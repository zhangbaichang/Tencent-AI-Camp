/**
 * 像素沙盒 · 服务器版 V3.7（核心合并版 · 服务端权威世界 + 差量存档）
 *
 * 启动：
 *   cd server/
 *   npm install        （已随附 node_modules/ws，可跳过）
 *   node server.js
 * 访问：http://<本机IP>:8080   （静态页面与 WebSocket 同端口）
 *
 * V3.7 合并说明（本版核心改动）：
 *   把 V3.1~V3.6 的独立模块真正合并进主服务器，全部功能在此文件内生效：
 *     1. 权限系统   —— player / admin / developer 三级身份，按昵称持久化（data/roles.json）
 *     2. Kick       —— 踢出并限制 5 分钟内不得重进（data/kicklist.json，重启不丢）
 *     3. Ban        —— 封禁直到管理员解除（data/banlist.json，重启不丢）
 *     4. 创造模式   —— developer 默认创造；管理员可下发模式，实时同步客户端
 *     5. 聊天       —— WS /api/chat 双通道，带身份前缀，支持管理员公告，限速防刷
 *     6. PVP        —— 服务端总开关（data/config.json），关闭时攻击直接被拒
 *     7. 管理 API   —— /api/op/* 全部要求 opToken 鉴权（修复旧版任何人可踢人/重置的漏洞）
 *     8. 管理日志   —— 所有管理操作落盘 data/admin-log.json
 *     9. 玩家列表   —— player_list_update 广播（含身份前缀/模式），加入/离开/变更实时推送
 *
 * 保留的原有设计（未改动行为）：
 *   - 静态托管 index.html / css / js，一个 node 进程跑完整联机版
 *   - WebSocket 联机 + HTTP 轮询兜底（微信小程序）
 *   - 服务端权威世界差量：worldTiles Map 只记录玩家改动，叠加在种子地形之上
 *   - 200ms 增量同步 + 60s 全量兜底 + 定时落盘 world/ + 自动清理旧存档
 *
 * 运行环境：Node.js 16+（不依赖任何 Node 18+ 专属 API）。
 *
 * 注意：WORLD_W / WORLD_H 必须与 js/data.js 保持一致；服务端不引入前端模块，
 *       用常量同步以避免耦合（这是有 rationale 的显式约定，非 magic number）。
 */
const PlayerView=require('../js/player-view');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { startSakuraFrpWatcher, getPublicAddressInfo } = require('./sakura-frp');
const { spawn } = require('child_process');

// ==================== 系统终端：OS Shell 持久会话（V4.4.4v2） ====================
// 管理面板“系统终端”用于执行真实的系统命令（Windows cmd / Linux bash，如 dir / ipconfig / python）。
// 每个终端标签对应一个持久 shell 进程，支持交互式程序（python REPL 等）。
// 安全：仅当携带有效 OP 登录令牌（/api/op/shell 走 requireOp）且前端已解锁时才可访问。
const SHELL_SESSIONS = new Map(); // id -> { proc, out:[{id,text}], seq, closed }
let __shellSeq = 0;
const SHELL_MAX_BUF = 2000;
function spawnShell() {
  const isWin = process.platform === 'win32';
  const bin = isWin ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
  const args = isWin ? [] : ['-i'];
  const proc = spawn(bin, args, {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' }),
    windowsHide: true,
  });
  // Windows 下把 shell 代码页切到 UTF-8，避免中文命令输出乱码
  if (isWin) { try { proc.stdin.write('chcp 65001>nul\r\n'); } catch (e) {} }
  const id = 'sh' + (++__shellSeq);
  const sess = { id, proc, out: [], seq: 0, closed: false };
  const push = (t) => {
    if (!t) return;
    sess.out.push({ id: ++sess.seq, text: String(t) });
    if (sess.out.length > SHELL_MAX_BUF) sess.out.splice(0, sess.out.length - SHELL_MAX_BUF);
  };
  try { proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8'); } catch (e) {}
  proc.stdout.on('data', push);
  proc.stderr.on('data', push);
  proc.on('exit', (code) => { sess.closed = true; push('\n[进程已退出，code=' + code + ']'); });
  proc.on('error', (e) => { sess.closed = true; push('\n[启动失败] ' + e.message); });
  SHELL_SESSIONS.set(id, sess);
  return sess;
}
process.on('exit', () => {
  for (const s of SHELL_SESSIONS.values()) { try { s.proc.kill(); } catch (e) {} }
});

// CPU 使用率采样（管理面板状态圆环用：按两次调用间隔计算平均占用）
let __cpuTimesPrev = null;
function cpuUsagePercent(){
  try {
    const cur = os.cpus().map(c => c.times);
    if (!__cpuTimesPrev) { __cpuTimesPrev = cur; return 0; }
    let idle = 0, total = 0;
    cur.forEach((t, i) => {
      const p = __cpuTimesPrev[i]; if (!p) return;
      idle += t.idle - p.idle;
      // total 必须包含 idle，否则 idle/total > 1 会算出负占用
      total += (t.user + t.nice + t.sys + t.irq + t.idle) - (p.user + p.nice + p.sys + p.irq + p.idle);
    });
    __cpuTimesPrev = cur;
    if (total <= 0) return 0;
    return Math.round((1 - idle / total) * 1000) / 10;
  } catch (e) { return 0; }
}

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(__dirname, 'users'); // 全部用户数据（账户 / 玩家存档 / 身份 / 模式）
const LOG_DIR = path.join(__dirname, 'logs');    // 运行日志（服务器 / 管理登录 / 玩家操作分文件）
for (const dir of [DATA_DIR, USERS_DIR, LOG_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch(e) { return fallback; } }
function saveJson(file,obj) { try { fs.writeFileSync(file, JSON.stringify(obj,null,2)); } catch(e) { console.error('[data]',e.message); } }

// ==================== 日志体系（V4.4.2 增强） ====================
// logs/server-YYYY-MM-DD.log          服务器运行日志（终端全部输出 + 玩家关键操作）
// logs/admin-login-YYYY-MM-DD.log     管理面板登录日志（与服务器日志分开记录）
// logs/player-actions-YYYY-MM-DD.log  玩家操作明细（挖/放/聊天/死亡/PVP/物品等）
function pad2(n) { return String(n).padStart(2, '0'); }
function dayStamp(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
function logTime(d = new Date()) { return `${dayStamp(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function appendLog(file, line) { try { fs.appendFileSync(path.join(LOG_DIR, file), line + '\n'); } catch (e) {} }
const serverLogFile = () => `server-${dayStamp()}.log`;
const adminLoginLogFile = () => `admin-login-${dayStamp()}.log`;
const playerActionLogFile = () => `player-actions-${dayStamp()}.log`;
function formatLogArgs(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
}
// 保留原始 console，劫持后所有终端输出同时写入服务器日志 + 内存环形缓冲（供管理面板"终端"实时读取）
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const _consoleWarn = console.warn.bind(console);
const __consoleBuffer = [];   // { id, at, level, text }
let __consoleSeq = 0;
const __CONSOLE_MAX = 800;
function pushConsoleBuffer(level, args) {
  try {
    __consoleBuffer.push({ id: ++__consoleSeq, at: Date.now(), level, text: formatLogArgs(args) });
    if (__consoleBuffer.length > __CONSOLE_MAX) __consoleBuffer.splice(0, __consoleBuffer.length - __CONSOLE_MAX);
  } catch (e) {}
}
console.log = (...args) => { _consoleLog(...args); appendLog(serverLogFile(), `[${logTime()}] [INFO] ${formatLogArgs(args)}`); pushConsoleBuffer('INFO', args); };
console.error = (...args) => { _consoleError(...args); appendLog(serverLogFile(), `[${logTime()}] [ERROR] ${formatLogArgs(args)}`); pushConsoleBuffer('ERROR', args); };
console.warn = (...args) => { _consoleWarn(...args); appendLog(serverLogFile(), `[${logTime()}] [WARN] ${formatLogArgs(args)}`); pushConsoleBuffer('WARN', args); };
// 管理面板登录日志：单独文件，不写入服务器日志
function logAdminLogin(ip, ok, detail) {
  const line = `[${logTime()}] ${ok ? 'SUCCESS' : 'FAILED'} ip=${ip || '-'} ${detail || ''}`.trim();
  appendLog(adminLoginLogFile(), line);
  _consoleLog(line);
}
// 玩家操作明细：单独文件，避免高频操作刷屏终端
function logPlayerAction(nickname, action, detail) {
  appendLog(playerActionLogFile(), `[${logTime()}] user=${nickname || '-'} action=${action} ${detail || ''}`.trim());
}
// 重复日志限流：同一 key 在 intervalMs 内只输出一次，并汇总次数（修复存档清理刷屏）
const _logThrottle = new Map();
function logThrottled(key, message, intervalMs = 60000) {
  const now = Date.now();
  const st = _logThrottle.get(key) || { last: 0, count: 0 };
  st.count++;
  if (now - st.last < intervalMs) { _logThrottle.set(key, st); return; }
  const times = st.count > 1 ? `（近 ${Math.round((now - st.last) / 1000)} 秒累计 ${st.count} 次）` : '';
  st.last = now; st.count = 0;
  _logThrottle.set(key, st);
  console.log(message + times);
}

// ==================== 用户数据迁移（旧位置 → users/） ====================
// 启动时若 users/ 下还没有对应文件，而旧位置存在，则复制一份到 users/。
// 旧文件保留不删，避免升级过程中误删数据。
function migrateUserFile(oldPath, newPath) {
  try {
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
      fs.copyFileSync(oldPath, newPath);
      console.log(`[migrate] 用户数据迁移: ${path.relative(__dirname, oldPath)} → users/${path.basename(newPath)}`);
    }
  } catch (e) { console.error('[migrate] 迁移失败:', oldPath, e.message); }
}
migrateUserFile(path.join(DATA_DIR, 'accounts.json'), path.join(USERS_DIR, 'accounts.json'));
migrateUserFile(path.join(DATA_DIR, 'roles.json'), path.join(USERS_DIR, 'roles.json'));
migrateUserFile(path.join(DATA_DIR, 'player-modes.json'), path.join(USERS_DIR, 'player-modes.json'));
migrateUserFile(path.join(__dirname, 'players.json'), path.join(USERS_DIR, 'players.json'));
migrateUserFile(path.join(__dirname, 'players_backup.json'), path.join(USERS_DIR, 'players_backup.json'));
const WORLD_SEED_FILE = path.join(DATA_DIR,'world-seed.json');
const seedData = loadJson(WORLD_SEED_FILE,null);
let WORLD_SEED = seedData && Number.isFinite(seedData.seed) ? Math.floor(seedData.seed) : Math.floor(Math.random()*0x7fffffff);
if (!seedData) saveJson(WORLD_SEED_FILE,{seed:WORLD_SEED,createdAt:new Date().toISOString()});
// 与 js/data.js 的 WORLD_W / WORLD_H 同步（服务端权威世界差量的 key 计算依赖此值）
const WORLD_W = 600;
const WORLD_H = 300;
const IDLE_TIMEOUT = 60000;
const ROOT = path.join(__dirname, '..'); // 静态根 = 项目根（index.html/css/js 在 server/ 上一级）
const WORLD_DIR = path.join(__dirname, 'world'); // 世界存档目录（服务初始化时创建）
const SAVE_DIR = path.join(WORLD_DIR, 'save');   // 手动备份 zip 存放目录（world/save）
const SERVER_ROOT = __dirname;                   // 服务端根目录（world/users/data 的父目录）
const SAVE_INTERVAL_MS = 5000;   // 世界数据落盘间隔（毫秒，可调；默认 5 秒一份）
const MAX_SAVE_FILES = 20;       // world/ 中最多保留的存档份数，超出自动删除最旧的
const OP_TOKENS = new Set();
const OP_SESSIONS = new Map(); // token -> { user, role }
const ACCOUNT_TOKENS = new Map(); // sessionToken -> accountId
const ACCOUNT_FILE = path.join(USERS_DIR, 'accounts.json');
const USERS_PLAYERS_FILE = path.join(USERS_DIR, 'players.json');
const USERS_PLAYERS_BACKUP = path.join(USERS_DIR, 'players_backup.json');

// ==================== V3.7 数据持久化层（server/data/） ====================
// 所有管理类数据落盘在 server/data/，重启不丢。写文件采用同步写 +  try/catch：
// 数据量极小（几十条记录），同步写简单可靠，不会成为性能瓶颈。
const ROLES_FILE = path.join(USERS_DIR, 'roles.json');       // { 昵称: "admin"|"developer" }
const MODES_FILE = path.join(USERS_DIR, 'player-modes.json'); // { 昵称: "survival"|"creative" }
const BANLIST_FILE = path.join(DATA_DIR, 'banlist.json');   // [ { nickname, reason, by, at } ]
const KICKLIST_FILE = path.join(DATA_DIR, 'kicklist.json'); // { 昵称: 解封时间戳ms }
const ADMINLOG_FILE = path.join(DATA_DIR, 'admin-log.json');// [ { at, action, by, target, detail } ]
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');     // 世界开关配置

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function saveJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) {
    console.error('[data] 写入失败:', path.basename(file), e.message);
  }
}

// ==================== 游戏账户系统 ====================
// 游戏ID全局唯一；密码只保存 scrypt 哈希，不保存明文。
let accounts = loadJson(ACCOUNT_FILE, {});
if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) accounts = {};
function normalizeAccountId(v) { return String(v || '').trim().toLowerCase(); }
function validAccountId(id) { return /^[\u4e00-\u9fa5a-zA-Z0-9_]{1,24}$/.test(id); }
function passwordHash(password, salt) { return crypto.scryptSync(String(password), salt, 64).toString('hex'); }
function makePasswordRecord(password) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, hash: passwordHash(password, salt) }; }
function checkPassword(account, password) { if (!account || !account.salt || !account.passwordHash) return false; return crypto.timingSafeEqual(Buffer.from(account.passwordHash,'hex'), Buffer.from(passwordHash(password, account.salt),'hex')); }
function newAccountSession(accountId) { const token = crypto.randomBytes(32).toString('hex'); ACCOUNT_TOKENS.set(token, accountId); return token; }
function accountFromToken(token) { const id = ACCOUNT_TOKENS.get(String(token || '')); return id ? accounts[id] : null; }
function accountIdFromToken(token) { const id = ACCOUNT_TOKENS.get(String(token || '')); return id || null; }
function accountPublic(a) { return { id:a.id, nickname:a.nickname, uid:a.uid, createdAt:a.createdAt, lastLogin:a.lastLogin || null }; }
// 生成唯一 UID（U + 10 位十六进制），保证不与现有冲突
function genUid() {
  let u;
  do { u = 'U' + crypto.randomBytes(5).toString('hex').toUpperCase(); } while (Object.values(accounts).some(a => a.uid === u));
  return u;
}
// 按 UID 或昵称(账号)解析账户，返回账户对象或 null
function resolveAccountByIdent(ident) {
  if (!ident) return null;
  const s = String(ident).trim();
  if (!s) return null;
  if (accounts[s]) return accounts[s];
  const n = normalizeAccountId(s);
  if (accounts[n]) return accounts[n];
  return Object.values(accounts).find(a => a.uid === s || String(a.nickname || '').toLowerCase() === n) || null;
}
// 由 UID / 昵称 / 在线 id 解析出 nickname（封禁 / 身份 / 模式用）
function resolveNickname(data) {
  if (data && data.id !== undefined && data.id !== '') {
    const p = players.get(Number(data.id));
    if (p) return p.nickname;
  }
  if (data && data.uid) {
    const a = resolveAccountByIdent(data.uid);
    if (a) return a.nickname;
  }
  if (data && data.nickname) return String(data.nickname).trim();
  return '';
}

// ==================== 管理面板密码（可修改并持久化，V4.4.2 新增） ====================
// 默认密码来自 OP_PASSWORD 环境变量，否则为 admin123；首次启动写入 data/op-password.json（scrypt 哈希）。
// 之后以文件为准，可在管理面板随时修改，修改后所有登录会话失效。
const OP_PASSWORD_FILE = path.join(DATA_DIR, 'op-password.json');
function initOpPassword() {
  const rec = loadJson(OP_PASSWORD_FILE, null);
  if (rec && rec.salt && rec.hash) return rec;
  const initial = process.env.OP_PASSWORD || 'admin123';
  const pr = makePasswordRecord(initial);
  const data = { salt: pr.salt, hash: pr.hash, updatedAt: new Date().toISOString() };
  saveJson(OP_PASSWORD_FILE, data);
  console.log(`[admin] 已初始化管理密码（${process.env.OP_PASSWORD ? '来自 OP_PASSWORD 环境变量' : '默认 admin123，请登录管理面板后立即修改'}）`);
  return data;
}
let opPasswordRecord = initOpPassword();
function checkOpPassword(password) {
  if (!opPasswordRecord || !opPasswordRecord.salt) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(opPasswordRecord.hash, 'hex'),
      Buffer.from(passwordHash(String(password || ''), opPasswordRecord.salt), 'hex')
    );
  } catch (e) { return false; }
}

// ==================== 管理面板多账户（V4.4.4v2 新增） ====================
// 用 admin_accounts.json 取代单一管理密码：支持多个管理员账号（账号+密码），
// role==='super' 为最高权限（默认 admin），'admin' 为普通管理员。
const ADMIN_ACCOUNTS_FILE = path.join(DATA_DIR, 'admin_accounts.json');
function initAdminAccounts() {
  let list = loadJson(ADMIN_ACCOUNTS_FILE, null);
  if (Array.isArray(list) && list.length && list.every(a => a && a.user && a.salt && a.hash)) return list;
  const now = new Date().toISOString();
  list = [
    { user: 'admin', ...makePasswordRecord('admin'), role: 'super', createdAt: now },
    { user: 'xiaoxiao', ...makePasswordRecord('123456'), role: 'admin', createdAt: now },
  ];
  saveJson(ADMIN_ACCOUNTS_FILE, list);
  console.log('[admin] 已初始化管理员账户：admin(最高权限) / xiaoxiao(管理员)');
  return list;
}
let adminAccounts = initAdminAccounts();
function findAdmin(user) { return adminAccounts.find(a => a.user === String(user || '')); }
function verifyAdmin(user, password) {
  const a = findAdmin(user);
  if (!a || !a.salt || !a.hash) return null;
  try {
    if (crypto.timingSafeEqual(Buffer.from(a.hash, 'hex'), Buffer.from(passwordHash(String(password || ''), a.salt), 'hex'))) return a;
  } catch (e) {}
  return null;
}
function saveAdminAccounts() { saveJson(ADMIN_ACCOUNTS_FILE, adminAccounts); }
function opSession(token) { return OP_SESSIONS.get(String(token || '')) || null; }

// 身份表：昵称 -> role。普通玩家不记录（默认 player），只存提升过权限的。
let roles = loadJson(ROLES_FILE, {});
let playerModes = loadJson(MODES_FILE, {});
if (!playerModes || typeof playerModes !== 'object' || Array.isArray(playerModes)) playerModes = {};
// 封禁列表：数组，封禁直到管理员解除
let banlist = loadJson(BANLIST_FILE, []);
// 踢出限制：昵称 -> 解除时间戳（5 分钟临时限制）
let kicklist = loadJson(KICKLIST_FILE, {});
// 管理日志：最多保留 500 条，超出裁掉最旧
let adminLog = loadJson(ADMINLOG_FILE, []);
// 世界配置：PVP 总开关、创造模式管控、聊天开关、玩家列表显示
let config = Object.assign({
  pvp: false,
  creativeModeControl: true,
  chatEnabled: true,
  playerListDisplay: true,
  deathDrop: true,
  hungerEnabled: true,
  nuclearEnabled: true,
  mobilePerformance: true,
}, loadJson(CONFIG_FILE, {}));

const KICK_DURATION_MS = 5 * 60 * 1000; // Kick 限制时长：5 分钟
const CHAT_MAX_LEN = 120;               // 聊天单条最大长度
const CHAT_MIN_INTERVAL = 500;          // 聊天最小间隔（毫秒），防刷屏
const PVP_MAX_DAMAGE = 20;              // PVP 单次伤害上限（防伪造高伤害）
const PVP_MAX_RANGE = 400;
const MAX_HUNGER=20, HUNGER_TICK_MS=30000, STARVATION_DAMAGE=2;
const FOOD_VALUES={90:5,91:8,92:12,93:20};
const ARMOR_VALUES={94:5,95:12,96:20};
function xpNeed(l){return 100+Math.max(0,(Number(l)||1)-1)*50;}
function armorReduction(p){return Math.min(80,Math.max(0,Number(p.armor)||0));}
function applyDamage(p,raw){const d=Math.max(0,Number(raw)||0)*(1-armorReduction(p)/100);p.health=Math.max(0,p.health-d);return d;}
function gainXp(p,a){p.xp=Math.max(0,(p.xp||0)+Math.max(0,a||0));p.level=Math.max(1,p.level||1);while(p.xp>=xpNeed(p.level)){p.xp-=xpNeed(p.level);p.level++;p.health=Math.min(100,p.health+10);p.hunger=Math.min(MAX_HUNGER,(p.hunger||0)+2);}}
function savePlayerData(p){return{x:p.x,y:p.y,health:p.health,inventory:p.inventory||{},inventorySlots:Array.isArray(p.inventorySlots)?p.inventorySlots:[],hotbar:p.hotbar||[],hunger:p.hunger??20,xp:p.xp||0,level:p.level||1,armor:p.armor||0,equipment:p.equipment||{}};}
function syncStats(p,includeInventory=false){sendTo(p.id,{type:'player_stats',...(includeInventory?{inventory:p.inventory||{}}:{}),health:p.health,maxHealth:100,hunger:p.hunger??20,maxHunger:MAX_HUNGER,armor:armorReduction(p),xp:p.xp||0,level:p.level||1,xpNext:xpNeed(p.level||1),equipment:p.equipment||{}});}
function dropOnDeath(p){if(!config.deathDrop||p.mode==='creative'||Math.random()>0.4)return[];const ids=Object.keys(p.inventory||{}).filter(k=>(p.inventory[k]||0)>0).sort(()=>Math.random()-0.5).slice(0,2),out=[];for(const k of ids){p.inventory[k]--;if(p.inventory[k]<=0)delete p.inventory[k];out.push({id:Number(k),count:1});}return out;}
function handlePlayerDeath(p,cause){if(!p||p.deathHandled)return;p.deathHandled=true;p._deathT=Date.now();logPlayerAction(p.nickname,'death',`cause=${cause||'unknown'} x=${Math.round(p.x)} y=${Math.round(p.y)}`);const dropped=dropOnDeath(p);p.health=100;p.hunger=Math.max(8,p.hunger||20);p.invulnerableUntil=Date.now()+3000;savePlayers();syncStats(p);sendTo(p.id,{type:'player_respawn',health:p.health,hunger:p.hunger,armor:armorReduction(p),inventory:p.inventory||{},inventorySlots:p.inventorySlots||[],hotbar:p.hotbar||[],xp:p.xp||0,level:p.level||1,xpNext:xpNeed(p.level||1),deathX:p.x,deathY:p.y,dropped,cause});broadcast({type:'player_death',id:p.id,nickname:p.nickname,x:p.x,y:p.y,dropped,cause});setTimeout(()=>p.deathHandled=false,3000);}
function useFood(p,id){
  id=Number(id);
  if(!p || p.mode==='creative' || !config.hungerEnabled || !FOOD_VALUES[id] || (p.inventory?.[id]||0)<=0) return false;
  p.inventory[id]--;
  if(p.inventory[id]<=0) delete p.inventory[id];
  p.hunger=Math.min(MAX_HUNGER,(p.hunger||0)+FOOD_VALUES[id]);
  gainXp(p,2);
  savePlayers();
  sendTo(p.id,{type:'inventory_update',inventory:p.inventory||{},inventorySlots:p.inventorySlots||[],hotbar:p.hotbar||[]});
  syncStats(p);
  return true;
}
function unequipArmor(p){
 const id=p.equipment?.armorItem;if(!id)return false;
 p.inventory=p.inventory||{};p.inventory[id]=(p.inventory[id]||0)+1;p.equipment.armorItem=0;p.armor=0;
 savePlayers();syncStats(p,true);return true;
}
function equipArmor(p,id){id=Number(id);if(!ARMOR_VALUES[id]||(p.inventory?.[id]||0)<=0)return false;const old=p.equipment?.armorItem||0;if(old)p.inventory[old]=(p.inventory[old]||0)+1;p.inventory[id]--;if(p.inventory[id]<=0)delete p.inventory[id];p.equipment=p.equipment||{};p.equipment.armorItem=id;p.armor=ARMOR_VALUES[id];savePlayers();syncStats(p,true);return true;}
setInterval(()=>{if(!config.hungerEnabled)return;for(const p of players.values()){if(p.mode==='creative')continue;if(Date.now()-(p.lastHungerTick||0)<HUNGER_TICK_MS)continue;p.lastHungerTick=Date.now();p.hunger=Math.max(0,(p.hunger??20)-1);if(p.hunger===0){applyDamage(p,STARVATION_DAMAGE);if(p.health<=0)handlePlayerDeath(p,'starvation');}syncStats(p);}},5000);
              // PVP 最大命中距离（像素，约 12 格）

// ==================== V3.7 权限与身份系统 ====================
// 三级身份：player（默认）/ admin（管理员）/ developer（开发者）
// 身份按昵称绑定并持久化。注意：当前昵称即身份，无账号密码体系，
// 防伪造身份（昵称冒用）属于 V4.3 安全优化范围，本版先保证流程打通。
const PERMISSIONS = {
  player: ['chat'],
  admin: ['chat', 'kick', 'ban', 'world_control', 'announce'],
  developer: ['chat', 'kick', 'ban', 'world_control', 'announce', 'debug', 'creative'],
};

function getRole(nickname) {
  const r = roles[nickname];
  return (r === 'admin' || r === 'developer') ? r : 'player';
}

function getPrefix(role) {
  if (role === 'developer') return '[开发者]';
  if (role === 'admin') return '[管理员]';
  return '';
}

function hasPermission(role, action) {
  return (PERMISSIONS[role] || []).includes(action);
}

// 应用身份到玩家对象：developer 默认可选模式——显式设为 survival 时进入生存（便于测试生存机制），
// 其余情况（未设置 / creative）保持创造 + 飞行 + 无限物品，保留历史默认行为（与 V3.4 role-manager 设计一致）
function applyRole(p, role) {
  p.role = role || 'player';
  p.prefix = getPrefix(p.role);
  const savedMode = playerModes[p.nickname] === 'creative' ? 'creative' : 'survival';
  if (p.role === 'developer') {
    // 开发者可切换生存：仅当 playerModes 显式为 'survival' 才进入生存，否则默认创造
    p.mode = playerModes[p.nickname] === 'survival' ? 'survival' : 'creative';
    p.canFly = p.mode === 'creative';
    p.infiniteItems = p.mode === 'creative';
  } else if (p.role === 'admin' && config.creativeModeControl) {
    p.mode = savedMode;
    p.canFly = p.mode === 'creative';
    p.infiniteItems = p.mode === 'creative';
  } else {
    p.mode = 'survival';
    p.canFly = false;
    p.infiniteItems = false;
  }
  return p;
}

// 设置身份（持久化 + 在线玩家实时生效 + 广播）
function setRole(nickname, role, by) {
  nickname = String(nickname || '').trim();
  if (!nickname) return false;
  const wasCreativeMode = playerModes[nickname] === 'creative';
  if (role === 'player') delete roles[nickname];
  else roles[nickname] = role;
  if (role !== 'admin') delete playerModes[nickname];
  saveJson(ROLES_FILE, roles);
  saveJson(MODES_FILE, playerModes);
  // 降级到普通玩家且此前处于创造模式：清空背包，移除在创造模式下囤积/获取的物品，
  // 否则管理员可借创造模式大量获取物品后再降级为普通玩家，仍保留这些物品（刷物品漏洞）。
  const demoteOutOfCreative = (role === 'player' && wasCreativeMode);
  // 在线玩家实时更新并广播
  for (const [id, p] of players) {
    if (p.nickname === nickname) {
      applyRole(p, getRole(nickname));
      if (demoteOutOfCreative) {
        p.inventory = {};
        p.inventorySlots = [];
        p.hotbar = (Array.isArray(p.hotbar) && p.hotbar.length) ? p.hotbar.map(() => 0) : [0,0,0,0,0,0,0,0,0,0];
        savePlayers();
        sendTo(id, { type: 'inventory_update', inventory: p.inventory, inventorySlots: p.inventorySlots, hotbar: p.hotbar });
      }
      sendTo(id, {
        type: 'role_update', id, nickname: p.nickname,
        role: p.role, prefix: p.prefix, mode: p.mode,
        canFly: !!p.canFly, infiniteItems: !!p.infiniteItems
      });
      broadcast({ type: 'role_update', id, nickname, role: p.role, prefix: p.prefix, mode: p.mode }, id);
    }
  }
  // 离线玩家的存档背包一并清空，避免降级后重连仍保留创造物品
  if (demoteOutOfCreative && savedPlayers[nickname]) {
    const sp = savedPlayers[nickname];
    sp.inventory = {};
    sp.inventorySlots = [];
    sp.hotbar = (Array.isArray(sp.hotbar) && sp.hotbar.length) ? sp.hotbar.map(() => 0) : [0,0,0,0,0,0,0,0,0,0];
    savePlayers();
  }
  broadcastPlayerList();
  logAdmin('setrole', by || 'op', nickname, 'role=' + role + (demoteOutOfCreative ? ' (清空创造物品)' : ''));
  return true;
}

// ==================== V3.7 管理日志 ====================
function logAdmin(action, by, target, detail) {
  adminLog.push({ at: new Date().toISOString(), action, by: by || 'op', target: target || '', detail: detail || '' });
  if (adminLog.length > 500) adminLog = adminLog.slice(-500);
  saveJson(ADMINLOG_FILE, adminLog);
  console.log(`[admin] ${action} by=${by} target=${target} ${detail || ''}`);
  logPlayerAction(target || by || 'op', 'admin', `${action} ${detail || ''}`.trim());
}

// ==================== V3.7 Kick / Ban 检查 ====================
function isBanned(nickname) {
  return banlist.some(b => b.nickname === nickname);
}
function banPlayer(nickname, reason, by) {
  if (!isBanned(nickname)) {
    banlist.push({ nickname, reason: reason || '违反服务器规则', by: by || 'op', at: new Date().toISOString() });
    saveJson(BANLIST_FILE, banlist);
  }
  logAdmin('ban', by, nickname, reason || '');
}
function unbanPlayer(nickname, by) {
  const before = banlist.length;
  banlist = banlist.filter(b => b.nickname !== nickname);
  saveJson(BANLIST_FILE, banlist);
  if (banlist.length !== before) logAdmin('unban', by, nickname, '');
  return banlist.length !== before;
}
// 返回剩余毫秒数；0 表示不在限制中（顺手清理过期记录）
function kickedRemain(nickname) {
  const until = kicklist[nickname];
  if (!until) return 0;
  const remain = until - Date.now();
  if (remain <= 0) {
    delete kicklist[nickname];
    saveJson(KICKLIST_FILE, kicklist);
    return 0;
  }
  return remain;
}
function kickPlayer(nickname, by, reason) {
  kicklist[nickname] = Date.now() + KICK_DURATION_MS;
  saveJson(KICKLIST_FILE, kicklist);
  logAdmin('kick', by, nickname, reason || ('限制' + (KICK_DURATION_MS / 60000) + '分钟'));
}

// 按系统时间生成文件名片段：YYYY-MM-DD_HH-MM-SS-mmm（精确到毫秒，保证每次保存文件名唯一）
function fileTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// ==================== 服务端权威世界（差量覆盖） ====================
// key = ty * WORLD_W + tx  ->  tileId
// tileId 可以是 0（被挖空），用于覆盖种子地形上的原生方块
const { createZip, extractZip } = require('./zip-util');
const worldTiles = new Map();
const {WorldInteractions}=require('./world-interactions');
const {createDropTerrain}=require('./drop-terrain');
let dropIsSolid=createDropTerrain(WORLD_SEED,worldTiles,WORLD_W,WORLD_H);
const worldInteractions=new WorldInteractions({file:path.join(DATA_DIR,'chests.json'),tileAt:index=>worldTiles.get(index),isSolid:dropIsSolid});

// ==================== 移动反作弊（V4.4.4v2 新增） ====================
// 游戏移动为客户端权威，服务端原本盲信客户端上报的 x/y 并直接广播，导致玩家可“卡BUG飞天/穿墙/瞬移”。
// 这里对坐标做基础合法性校验：世界边界钳制 + 瞬移/超速拦截 + 非创造玩家穿墙（中心落入实心方块）拦截。
// 注意：TILE / 玩家碰撞盒须与 js/data.js、js/game.js 保持一致。
const TILE = 24;
const PLAYER_W = 18, PLAYER_H = 36;
const MOVE_MIN_DT = 30;       // ms：过短间隔（含首帧）直接放行，避免误判
const MOVE_MAX_SPEED = 2.2;    // px/ms（≈2640 px/s，远高于正常移动/下落，仅拦截瞬移类作弊）
function validateMovement(p, x, y) {
  x = Number(x); y = Number(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) { // 非法坐标：沿用上一帧合法坐标
    if (typeof p._lastX === 'number') return { x: p._lastX, y: p._lastY };
    return { x: 0, y: 0 };
  }
  const maxX = WORLD_W * TILE - PLAYER_W;
  const maxY = WORLD_H * TILE - PLAYER_H;
  x = Math.max(0, Math.min(maxX, x));
  y = Math.max(0, Math.min(maxY, y));
  const now = Date.now();
  // 瞬移/超速拦截（dt 处于正常帧间隔窗口内才校验；长间隔/刚复活/刚加入放行，避免误冻）
  if (typeof p._lastX === 'number' && typeof p._lastY === 'number' && typeof p._lastMoveT === 'number') {
    const dt = now - p._lastMoveT;
    const recentlyDied = (now - (p._deathT || 0)) < 3000;
    if (dt >= MOVE_MIN_DT && dt <= 1000 && !recentlyDied) {
      const dist = Math.hypot(x - p._lastX, y - p._lastY);
      if (dist > MOVE_MAX_SPEED * dt * 1.5) { x = p._lastX; y = p._lastY; } // 速度异常：拒绝，沿用上一帧合法坐标
    }
  }
  // 非创造玩家：中心点落入实心方块（穿墙）拦截，避免“穿墙飞天”
  if (p.mode !== 'creative' && typeof dropIsSolid === 'function') {
    const cx = Math.floor((x + PLAYER_W / 2) / TILE);
    const cy = Math.floor((y + PLAYER_H / 2) / TILE);
    if (dropIsSolid(cx, cy) && typeof p._lastX === 'number') { x = p._lastX; y = p._lastY; }
  }
  p._lastX = x; p._lastY = y; p._lastMoveT = now;
  return { x, y };
}
function handleWorldAction(p,msg){
  try{
    const result=worldInteractions.handle(p?.accountId,p,msg);
    if(result.removed){worldTiles.set(msg.index,0);pendingSync.set(msg.index,0);broadcast({type:'block',tx:msg.index%WORLD_W,ty:Math.floor(msg.index/WORLD_W),tileId:0});}
    if(msg.action==='drop'||msg.action==='pickup'){
      savedPlayers[p.nickname]=savePlayerData(p);savePlayers();
      broadcast({type:'shared_drops',drops:[...worldInteractions.drops.values()]});
    }
    return{ok:true,...result};
  }catch(e){return{ok:false,error:e.message};}
}


let dropTickAt=Date.now(),dropSyncAt=0,hadSharedDrops=false;
setInterval(()=>{const now=Date.now();worldInteractions.tick((now-dropTickAt)/1000);dropTickAt=now;for(const event of worldInteractions.events.splice(0))broadcast({type:'shared_explosion',...event});if(now-dropSyncAt>=50&&(worldInteractions.drops.size||hadSharedDrops)){broadcast({type:'shared_drops',drops:[...worldInteractions.drops.values()]});hadSharedDrops=worldInteractions.drops.size>0;dropSyncAt=now;}},16);

// 服务端权威时钟：所有客户端昼夜统一以此时钟为准（200ms 广播校正）
let gameTime = 0.15; // 0~1 一天（与客户端 game.time 同构）
let gameDay = 0;     // 天数

// 200ms 增量同步队列：只广播"本窗口内"的方块改动（动态地图），避免全量广播的带宽爆炸
const pendingSync = new Map(); // key -> tileId

// 记录一次方块改动到权威世界（含边界与类型校验）
function recordBlock(tx, ty, tileId, actor) {
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || !Number.isInteger(tileId) ||
      tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H ||
      tileId < 0 || tileId > 255) return false; // 非法入参返回 false，触发调用方回滚而非广播坏数据
  const key = ty * WORLD_W + tx;
  if(tileId!==27 && worldInteractions.protected(key))return false;
  if(tileId===27 && actor?.accountId)worldInteractions.register(key,actor.accountId);
  worldTiles.set(key, tileId);
  pendingSync.set(key, tileId); // 同时记入增量队列，供 200ms 定时同步
}

function worldStatePayload() {
  return { tiles: Array.from(worldTiles.entries()) };
}

// ==================== 玩家与会话 ====================

const PLAYER_SAVE_FILE = USERS_PLAYERS_FILE;
const PLAYER_AUTO_SAVE = 10000;
let savedPlayers = {};
try { savedPlayers = JSON.parse(fs.readFileSync(PLAYER_SAVE_FILE,'utf8')); } catch(e) { savedPlayers = {}; }
function savePlayers(){ try { fs.writeFileSync(PLAYER_SAVE_FILE, JSON.stringify(savedPlayers,null,2)); } catch(e){} }
function saveAccounts(){ saveJson(ACCOUNT_FILE, accounts); }

const PLAYER_DATA_BACKUP = USERS_PLAYERS_BACKUP;

setInterval(() => {
  try {
    savePlayers();
    if (!fs.existsSync(PLAYER_DATA_BACKUP)) {
      fs.writeFileSync(PLAYER_DATA_BACKUP, JSON.stringify(savedPlayers, null, 2));
    }
  } catch(e) {}
}, 10000);

const players = new Map(); // id -> player
let nextId = 1;

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== exceptId && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
    // HTTP 模式玩家需要把消息存入队列
    if (id !== exceptId && !p.ws) {
      p.messages = p.messages || [];
      if (p.messages.length > 1000) p.messages.splice(0, p.messages.length - 1000); // 上限保护：HTTP 轮询玩家长期不拉取时避免内存无上限增长
      p.messages.push(msg);
    }
  }
}

function sendTo(id, msg) {
  const p = players.get(id);
  if (!p) return;
  if (p.ws && p.ws.readyState === WebSocket.OPEN) {
    p.ws.send(JSON.stringify(msg));
  } else {
    p.messages = p.messages || [];
    p.messages.push(msg);
  }
}

// 在线人数实时广播
function broadcastOnlineCount() {
  broadcast({ type: 'onlineCount', count: players.size });
}

// V3.7 在线玩家列表广播：含身份前缀与模式，加入/离开/身份变更时推送。
// 客户端负责"最多显示5个+滚动"（V3.8 HUD），服务端发全量保证信息完整。
function broadcastPlayerList() {
  if (!config.playerListDisplay) return;
  const list = [];
  for (const [id, p] of players) {
    list.push({
      id, nickname: p.nickname, uid: p.uid,
      role: p.role || 'player', prefix: p.prefix || '',
      mode: p.mode || 'survival', health: p.health,
    });
  }
  broadcast({ type: 'player_list_update', count: list.length, players: list });
}

function getPlayerList(excludeId) {
  const list = [];
  for (const [id, p] of players) {
    if (id !== excludeId) {
      list.push({
        id, nickname: p.nickname, uid: p.uid,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        facing: p.facing, walkPhase: p.walkPhase, health: p.health,
        inventory: p.inventory || {},
        hotbar: p.hotbar || [],
        role: p.role || 'player', prefix: p.prefix || '',
        mode: p.mode || 'survival',
      });
    }
  }
  return list;
}

// 把玩家从服务器移除（kick/ban/超时共用）：通知本人、存档、广播离开
function removePlayer(id, notifyMsg, opts) {
  const p = players.get(id);
  if (!p) return;
  if (notifyMsg) sendTo(id, notifyMsg);
  if (p.ws) { try { p.ws.close(); } catch (e) {} }
  if (!(opts && opts.skipSave)) { savedPlayers[p.nickname] = savePlayerData(p); savePlayers(); }
  if (p.accountId && worldInteractions && worldInteractions.release) worldInteractions.release(p.accountId);
  players.delete(id);
  broadcast({ type: 'leave', id });
  broadcastOnlineCount();
  broadcastPlayerList();
}

// ==================== V3.7 聊天系统 ====================
// channel: 'normal' 普通聊天 | 'announce' 管理员公告 | 'server' 服务器消息
function handleChat(p, text, channel) {
  if (!p) return;
  // V4.4.4 游戏内指令：聊天以 / 开头即为指令，仅 admin / developer 可用（最低管理员）
  const rawCmd = String(text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, CHAT_MAX_LEN);
  if (rawCmd.startsWith('/')) {
    const role = p.role || getRole(p.nickname);
    if (role !== 'admin' && role !== 'developer') {
      sendTo(p.id, { type:'chat', id:0, nickname:'服务器', role:'developer', prefix:'[指令]', text:'指令需要最低管理员权限（admin/developer）', channel:'server', at:Date.now() });
      return;
    }
    console.log(`[游戏指令] ${p.nickname}: ${rawCmd}`);
    const out = runServerCommand(rawCmd.slice(1), p.nickname);
    sendTo(p.id, { type:'chat', id:0, nickname:'服务器', role:'developer', prefix:'[指令]', text:String(out || '(无输出)').slice(0, CHAT_MAX_LEN), channel:'server', at:Date.now() });
    logPlayerAction(p.nickname, 'command', rawCmd.slice(0, 80));
    return;
  }
  if (!config.chatEnabled) { sendTo(p.id, { type: 'chat_denied', reason: '聊天已被管理员关闭' }); return; }
  if (!hasPermission(p.role, 'chat')) { sendTo(p.id, { type: 'chat_denied', reason: '没有聊天权限' }); return; }
  // 公告频道需要 announce 权限（admin / developer）
  if (channel === 'announce' && !hasPermission(p.role, 'announce')) {
    sendTo(p.id, { type: 'chat_denied', reason: '只有管理员可以发公告' }); return;
  }
  // 限速：防刷屏
  const now = Date.now();
  if (p.lastChatAt && now - p.lastChatAt < CHAT_MIN_INTERVAL) {
    sendTo(p.id, { type: 'chat_denied', reason: '发言太快，请稍候' }); return;
  }
  p.lastChatAt = now;
  const clean = String(text || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, CHAT_MAX_LEN);
  if (!clean) return;
  broadcast({
    type: 'chat',
    id: p.id,
    nickname: p.nickname,
    role: p.role || 'player',
    prefix: p.prefix || '',
    text: clean,
    channel: channel === 'announce' ? 'announce' : 'normal',
    at: now,
  });
  logPlayerAction(p.nickname, channel === 'announce' ? 'announce' : 'chat', clean);
}

// 服务器系统消息（开发者可用，全服可见，无发送者）
function serverMessage(text) {
  broadcast({ type: 'chat', id: 0, nickname: '服务器', role: 'developer', prefix: '[服务器]', text: String(text).slice(0, CHAT_MAX_LEN), channel: 'server', at: Date.now() });
}

// ==================== V3.7 PVP 系统 ====================
// 服务端校验：总开关、伤害上限、距离上限（用双方上报位置做粗略判定，防全图秒杀）
function handlePvpHit(attacker, msg) {
  if (!attacker) return;
  if (!config.pvp) { sendTo(attacker.id, { type: 'pvp_denied', reason: 'PVP 未开启' }); return; }
  const target = players.get(Number(msg.target));
  if (!target) { sendTo(attacker.id, { type: 'pvp_denied', reason: '目标不在线' }); return; }
  if (target.id === attacker.id) return;
  const damage = Math.max(1, Math.min(PVP_MAX_DAMAGE, Number(msg.damage) || 1));
  // 距离校验：双方都有坐标时才检查，超出范围直接拒
  if (Number.isFinite(attacker.x) && Number.isFinite(attacker.y) && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    const dist = Math.hypot(attacker.x - target.x, attacker.y - target.y);
    if (dist > PVP_MAX_RANGE) { sendTo(attacker.id, { type: 'pvp_denied', reason: '目标太远' }); return; }
  }
  const dealt=applyDamage(target,damage); target.lastDamageAt=Date.now(); syncStats(target);
  sendTo(target.id,{type:'pvp_hit',from:attacker.id,fromNickname:attacker.nickname,fromPrefix:attacker.prefix||'',damage:dealt,health:target.health,armor:armorReduction(target)});
  logPlayerAction(attacker.nickname, 'pvp_hit', `target=${target.nickname} damage=${dealt} health=${target.health}`);
  if(target.health<=0) handlePlayerDeath(target,'pvp');
}

// ==================== 静态文件 + API 服务器 ====================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let urlPath;
  try { urlPath=decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400);res.end('Bad request');return; }
  res.clientIp = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const cookies = String(req.headers.cookie || '');
  const opToken = (cookies.match(/opToken=([^;]+)/)||[])[1];
  const opAuthed = !!(opToken && OP_TOKENS.has(opToken));

  if (urlPath === '/op' || urlPath === '/op/') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    fs.createReadStream(path.join(ROOT,'admin','index.html')).pipe(res);
    return;
  }

  if (req.method === 'POST') {
    // 上传 zip 恢复：二进制体，不能走 JSON 解析，单独收集 Buffer
    if (urlPath === '/api/op/restore') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => restoreUploadedZip(Buffer.concat(chunks), res, opAuthed));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let data = {};
      if (body.trim()) {
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
      }
      handleHttpApi(urlPath, data, res, opAuthed, opToken);
    });
    return;
  }

  if (urlPath === '/status' || urlPath === '/status/') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache, no-store, must-revalidate'});
    fs.createReadStream(path.join(ROOT,'status.html')).pipe(res);
    return;
  }

  if (urlPath === '/api/public-address') {
    jsonRes(res, 200, getPublicAddressInfo());
    return;
  }

  // GET /api/* → 交给 HTTP API 处理（如 /api/players 用 GET 轮询在线玩家）
  if (urlPath.startsWith('/api/')) {
    handleHttpApi(urlPath, {}, res, opAuthed, opToken);
    return;
  }

  // GET → 静态文件托管
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const publicFile = /^(?:\/(?:index|404|status)\.html|\/(?:js|css|client|admin)\/[a-zA-Z0-9_.\/-]+\.(?:js|css|html|png|jpg|svg|ico|woff2?))$/.test(rel);
  if(!publicFile || rel.split(/[\\/]/).some(part=>part==='..')){res.writeHead(403);res.end('Forbidden');return;}
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 缓存策略：HTML 不缓存（保证每次刷新拿到最新页面）；JS/CSS/图片短缓存（5 分钟）
    const isHtml = ext === '.html' || ext === '.htm';
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (isHtml) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    } else {
      headers['Cache-Control'] = 'public, max-age=300';
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

function jsonRes(res, code, obj) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(obj));
}

// 需要管理员鉴权的接口统一入口：未登录直接 403（V3.7 修复：旧版这些接口无鉴权，任何人可调用）
function requireOp(res, opAuthed) {
  if (!opAuthed) { jsonRes(res, 403, { ok:false, error:'unauthorized' }); return false; }
  return true;
}

function handleHttpApi(url, data, res, opAuthed, opToken) {
  switch (url) {
    case '/api/world': {
      const accountId=accountIdFromToken(data.accountToken);
      const p=[...players.values()].find(p=>p.accountId===accountId);
      if(!accountId||!p){jsonRes(res,401,{ok:false,error:'请先登录游戏'});return;}
      if((data.action==='drop'||data.action==='pickup')&&data.inventory&&typeof data.inventory==='object'&&!Array.isArray(data.inventory)){p.inventory=Object.fromEntries(Object.entries(data.inventory).filter(([id,n])=>Number.isInteger(Number(id))&&Number(id)>0&&Number(id)<=255&&Number.isSafeInteger(n)&&n>0&&n<=1000000000));}
      jsonRes(res,200,handleWorldAction(p,data));return;
    }

    // ---------- 游戏账户：注册 / 登录 ----------
    case '/api/account/register': {
      const rawName = String(data.accountId || '').trim();
      const accountId = normalizeAccountId(rawName);
      const password = String(data.password || '');
      const nickname = String(data.nickname || rawName).trim().slice(0, 16) || accountId;
      if (!validAccountId(accountId)) { jsonRes(res, 400, {ok:false,error:'bad_account_id',message:'玩家名称只能使用中文、字母、数字、下划线，长度1-24位'}); break; }
      if (password.length < 6 || password.length > 128) { jsonRes(res, 400, {ok:false,error:'bad_password',message:'密码长度需要6-128位'}); break; }
      if (accounts[accountId]) { jsonRes(res, 409, {ok:false,error:'account_exists',message:'游戏ID已存在'}); break; }
      // 昵称也避免重复，防止聊天/管理面板混淆身份
      if (Object.values(accounts).some(a => String(a.nickname).toLowerCase() === nickname.toLowerCase())) { jsonRes(res, 409, {ok:false,error:'nickname_exists',message:'昵称已被使用'}); break; }
      const pr = makePasswordRecord(password);
      accounts[accountId] = { id:accountId, nickname, uid:genUid(), salt:pr.salt, passwordHash:pr.hash, createdAt:new Date().toISOString(), lastLogin:null };
      saveAccounts();
      const token = newAccountSession(accountId);
      console.log(`[account] 注册 accountId=${accountId} nickname=${nickname}`);
      logPlayerAction(nickname, 'register', `accountId=${accountId}`);
      jsonRes(res, 200, {ok:true,token,account:accountPublic(accounts[accountId])});
      break;
    }
    case '/api/account/login': {
      const input = String(data.accountId || '').trim();
      const password = String(data.password || '');
      const a = resolveAccountByIdent(input);
      const accountId = a ? a.id : null;
      if (!a || !checkPassword(a,password)) { jsonRes(res, 403, {ok:false,error:'invalid_login',message:'昵称或密码错误'}); break; }
      if ([...players.values()].some(p => p.accountId === accountId)) { jsonRes(res, 409, {ok:false,error:'already_online',message:'该账户已经在线'}); break; }
      a.lastLogin = new Date().toISOString(); saveAccounts();
      const token = newAccountSession(accountId);
      console.log(`[account] 登录 accountId=${accountId} nickname=${a.nickname}`);
      logPlayerAction(a.nickname, 'login', `accountId=${accountId}`);
      jsonRes(res, 200, {ok:true,token,account:accountPublic(a)});
      break;
    }
    case '/api/account/check': {
      const a = accountFromToken(data.token);
      jsonRes(res, 200, {ok:!!a,account:a?accountPublic(a):null});
      break;
    }
    case '/api/account/logout': {
      ACCOUNT_TOKENS.delete(String(data.token || ''));
      jsonRes(res, 200, {ok:true});
      break;
    }
    // ---------- 管理员登录（无需鉴权） ----------
    case '/api/op/login': {
      const user = String(data.user || '').trim();
      const password = String(data.password || '');
      const ip = res.clientIp || '';
      const a = verifyAdmin(user, password);
      if (!a) {
        logAdminLogin(ip, false, '管理员账户/密码错误');
        jsonRes(res, 403, {ok:false, error:'bad_credentials', message:'账号或密码错误'});
        break;
      }
      const token = crypto.randomBytes(24).toString('hex');
      OP_TOKENS.add(token);
      OP_SESSIONS.set(token, { user: a.user, role: a.role });
      res.writeHead(200, {
        'Content-Type':'application/json',
        'Set-Cookie': `opToken=${token}; Path=/; HttpOnly; SameSite=Strict`
      });
      res.end(JSON.stringify({ ok:true, user: a.user, role: a.role }));
      logAdminLogin(ip, true, '登录成功: ' + a.user);
      break;
    }
    case '/api/op/check': {
      const token = String(data.token || '');
      jsonRes(res, 200, {ok:OP_TOKENS.has(token)});
      break;
    }
    case '/api/op/change-password': {
      if (!requireOp(res, opAuthed)) break;
      const sess = opSession(opToken);
      if (!sess) { jsonRes(res, 403, { ok:false, error:'unauthorized' }); break; }
      const a = findAdmin(sess.user);
      if (!a) { jsonRes(res, 403, { ok:false, error:'no_account' }); break; }
      const oldPassword = String(data.oldPassword || '');
      const newPassword = String(data.newPassword || '');
      if (!crypto.timingSafeEqual(Buffer.from(a.hash, 'hex'), Buffer.from(passwordHash(oldPassword, a.salt), 'hex'))) {
        jsonRes(res, 403, { ok:false, error:'bad_old_password', message:'原密码错误' });
        break;
      }
      if (newPassword.length < 6 || newPassword.length > 128) {
        jsonRes(res, 400, { ok:false, error:'bad_password', message:'新密码长度需要6-128位' });
        break;
      }
      const pr = makePasswordRecord(newPassword);
      a.salt = pr.salt; a.hash = pr.hash;
      saveAdminAccounts();
      // 仅让当前账户的所有会话失效（不影响其他管理员）
      for (const [t, s] of OP_SESSIONS) if (s.user === sess.user) { OP_TOKENS.delete(t); OP_SESSIONS.delete(t); }
      logAdmin('change_op_password', sess.user, '', '管理员密码已修改');
      logAdminLogin(res.clientIp, true, '管理员密码修改成功: ' + sess.user);
      res.writeHead(200, {
        'Content-Type':'application/json',
        'Set-Cookie':'opToken=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict'
      });
      res.end(JSON.stringify({ok:true, relogin:true}));
      break;
    }

    // ---------- 管理面板多账户（超级管理员） ----------
    case '/api/op/admin-accounts': {
      if (!requireOp(res, opAuthed)) break;
      const sess = opSession(opToken);
      if (!sess || sess.role !== 'super') { jsonRes(res, 403, { ok:false, error:'forbidden', message:'仅超级管理员可管理账户' }); break; }
      jsonRes(res, 200, { ok:true, accounts: adminAccounts.map(a => ({ user:a.user, role:a.role })), me: sess.user });
      break;
    }
    case '/api/op/admin-account/create': {
      if (!requireOp(res, opAuthed)) break;
      const sess = opSession(opToken);
      if (!sess || sess.role !== 'super') { jsonRes(res, 403, { ok:false, error:'forbidden', message:'仅超级管理员可创建账户' }); break; }
      const user = String(data.user || '').trim();
      const password = String(data.password || '');
      const role = data.role === 'super' ? 'super' : 'admin';
      if (!/^[A-Za-z0-9_]{2,24}$/.test(user)) { jsonRes(res, 400, { ok:false, error:'bad_user', message:'账号为2-24位字母/数字/下划线' }); break; }
      if (password.length < 6 || password.length > 128) { jsonRes(res, 400, { ok:false, error:'bad_password', message:'密码长度需要6-128位' }); break; }
      if (findAdmin(user)) { jsonRes(res, 400, { ok:false, error:'exists', message:'账号已存在' }); break; }
      adminAccounts.push({ user, ...makePasswordRecord(password), role, createdAt: new Date().toISOString() });
      saveAdminAccounts();
      logAdmin('admin_account_create', sess.user, user, '创建管理员账户: ' + user);
      jsonRes(res, 200, { ok:true });
      break;
    }
    case '/api/op/admin-account/delete': {
      if (!requireOp(res, opAuthed)) break;
      const sess = opSession(opToken);
      if (!sess || sess.role !== 'super') { jsonRes(res, 403, { ok:false, error:'forbidden', message:'仅超级管理员可删除账户' }); break; }
      const user = String(data.user || '').trim();
      if (user === 'admin') { jsonRes(res, 400, { ok:false, error:'protected', message:'默认超级管理员 admin 不可删除' }); break; }
      if (user === sess.user) { jsonRes(res, 400, { ok:false, error:'self', message:'不能删除当前登录的账户' }); break; }
      const i = adminAccounts.findIndex(a => a.user === user);
      if (i < 0) { jsonRes(res, 404, { ok:false, error:'not_found' }); break; }
      adminAccounts.splice(i, 1);
      saveAdminAccounts();
      for (const [t, s] of OP_SESSIONS) if (s.user === user) { OP_TOKENS.delete(t); OP_SESSIONS.delete(t); }
      logAdmin('admin_account_delete', sess.user, user, '删除管理员账户: ' + user);
      jsonRes(res, 200, { ok:true });
      break;
    }
    case '/api/op/admin-account/set-password': {
      if (!requireOp(res, opAuthed)) break;
      const sess = opSession(opToken);
      if (!sess || sess.role !== 'super') { jsonRes(res, 403, { ok:false, error:'forbidden', message:'仅超级管理员可重置密码' }); break; }
      const user = String(data.user || '').trim();
      const password = String(data.password || '');
      if (password.length < 6 || password.length > 128) { jsonRes(res, 400, { ok:false, error:'bad_password', message:'密码长度需要6-128位' }); break; }
      const a = findAdmin(user);
      if (!a) { jsonRes(res, 404, { ok:false, error:'not_found', message:'账号不存在' }); break; }
      const pr = makePasswordRecord(password);
      a.salt = pr.salt; a.hash = pr.hash;
      saveAdminAccounts();
      if (user === sess.user) { for (const [t, s] of OP_SESSIONS) if (s.user === sess.user) { OP_TOKENS.delete(t); OP_SESSIONS.delete(t); } }
      logAdmin('admin_account_setpw', sess.user, user, '重置管理员密码: ' + user);
      jsonRes(res, 200, { ok:true });
      break;
    }

    // ---------- V4.1 账户管理 ----------
    case '/api/op/accounts': {
      if (!requireOp(res, opAuthed)) break;
      jsonRes(res, 200, {ok:true, accounts:Object.values(accounts).map(a => Object.assign(accountPublic(a), {
        role:getRole(a.nickname), mode:(getRole(a.nickname)==='developer'?(playerModes[a.nickname]==='survival'?'survival':'creative'):(playerModes[a.nickname]||'survival'))
      }))});
      break;
    }
    case '/api/op/account/create': {
      if (!requireOp(res, opAuthed)) break;
      const accountId=normalizeAccountId(data.accountId), password=String(data.password||''), nickname=String(data.nickname||accountId).trim().slice(0,16)||accountId;
      if (!validAccountId(accountId) || password.length<6 || password.length>128) { jsonRes(res,400,{ok:false,error:'bad_params'}); break; }
      if (accounts[accountId]) { jsonRes(res,409,{ok:false,error:'account_exists'}); break; }
      if (Object.values(accounts).some(a=>String(a.nickname).toLowerCase()===nickname.toLowerCase())) { jsonRes(res,409,{ok:false,error:'nickname_exists'}); break; }
      const pr=makePasswordRecord(password); accounts[accountId]={id:accountId,nickname,uid:genUid(),salt:pr.salt,passwordHash:pr.hash,createdAt:new Date().toISOString(),lastLogin:null}; saveAccounts(); logAdmin('account_create','op',accountId,'nickname='+nickname);
      jsonRes(res,200,{ok:true,account:accountPublic(accounts[accountId])}); break;
    }
    case '/api/op/account/delete': {
      if (!requireOp(res, opAuthed)) break;
      const a = resolveAccountByIdent(data.uid || data.accountId); const accountId = a && a.id;
      if (!a) { jsonRes(res,404,{ok:false,error:'not_found'}); break; }
      const p=[...players.values()].find(x=>x.accountId===accountId); if(p) removePlayer(p.id,{type:'kick',reason:'账户已被管理员删除'});
      for (const [t,id] of ACCOUNT_TOKENS) if(id===accountId) ACCOUNT_TOKENS.delete(t);
      delete savedPlayers[a.nickname]; delete roles[a.nickname]; delete playerModes[a.nickname]; delete accounts[accountId]; savePlayers(); saveJson(ROLES_FILE,roles); saveJson(MODES_FILE,playerModes); saveAccounts();
      logAdmin('account_delete','op',accountId,''); jsonRes(res,200,{ok:true}); break;
    }
    case '/api/op/account/reset-password': {
      if (!requireOp(res, opAuthed)) break;
      const accountId=normalizeAccountId(data.accountId), password=String(data.password||''), a=accounts[accountId];
      if(!a || password.length<6 || password.length>128){jsonRes(res,400,{ok:false,error:'bad_params'});break;}
      const pr=makePasswordRecord(password); a.salt=pr.salt; a.passwordHash=pr.hash; saveAccounts(); for(const [t,id] of ACCOUNT_TOKENS)if(id===accountId)ACCOUNT_TOKENS.delete(t); logAdmin('account_password_reset','op',accountId,''); jsonRes(res,200,{ok:true}); break;
    }
    case '/api/op/give': {
      if (!requireOp(res, opAuthed)) break;
      const itemId=Number(data.itemId), count=Math.max(1,Math.min(9999,Number(data.count)||1));
      if(!Number.isFinite(itemId)||itemId<1||itemId>255){jsonRes(res,400,{ok:false,error:'bad_item',message:'物品ID需在 1-255'});break;}
      // 收集发放目标（支持批量：ids 在线id数组 / accountIds 账户名数组或逗号分隔字符串）
      const targets=[];
      if(Array.isArray(data.ids)) for(const id of data.ids){const p=players.get(Number(id)); if(p) targets.push({online:true,p});}
      let accIds=[];
      if(Array.isArray(data.accountIds)) accIds=data.accountIds;
      else if(typeof data.accountIds==='string'&&data.accountIds.trim()) accIds=data.accountIds.split(/[\s,，;；]+/);
      else if(typeof data.accountId==='string'&&data.accountId.trim()) accIds=[data.accountId];
      for(const raw of accIds){ const acct=resolveAccountByIdent(raw); const a=acct?acct.id:normalizeAccountId(raw); if(!a) continue; const p=[...players.values()].find(x=>x.accountId===a); if(p) targets.push({online:true,p}); else if(accounts[a]) targets.push({online:false,accountId:a}); }
      // 单个兼容（data.id / data.accountId 单独）
      if(!targets.length){
        const id=Number(data.id); const acct0=resolveAccountByIdent(data.accountId); const a0=acct0?acct0.id:normalizeAccountId(data.accountId);
        const p=id?players.get(id):[...players.values()].find(x=>x.accountId===a0);
        if(p) targets.push({online:true,p}); else if(a0&&accounts[a0]) targets.push({online:false,accountId:a0});
      }
      if(!targets.length){jsonRes(res,404,{ok:false,error:'no_target',message:'未找到目标玩家'});break;}
      const results=[];
      for(const t of targets){
        if(t.online){
          const p=t.p; p.inventory=p.inventory||{}; p.inventory[itemId]=(p.inventory[itemId]||0)+count; savePlayers(); sendTo(p.id,{type:'inventory_update',inventory:p.inventory,inventorySlots:p.inventorySlots||[],hotbar:p.hotbar||[]}); syncStats(p); logAdmin('give_item','op',p.nickname,'item='+itemId+' count='+count+' 批量'); results.push({accountId:p.accountId,nickname:p.nickname,online:true});
        } else {
          const a=accounts[t.accountId]; const sd=savedPlayers[a.nickname]||savePlayerData({x:0,y:0,health:100,inventory:{},hotbar:[0,0,0,0,0,0,0,0,0,0],hunger:20,xp:0,level:1,armor:0,equipment:{}}); sd.inventory=sd.inventory||{}; sd.inventory[itemId]=(sd.inventory[itemId]||0)+count; savedPlayers[a.nickname]=sd; savePlayers(); logAdmin('give_item','op',a.nickname,'item='+itemId+' count='+count+' offline 批量'); results.push({accountId:a.id,nickname:a.nickname,online:false});
        }
      }
      jsonRes(res,200,{ok:true,itemId,count,total:results.length,results});
      break;
    }
    // ---------- V3.7 管理接口（全部需要 op 鉴权） ----------
    case '/api/op/status': {
      if (!requireOp(res, opAuthed)) break;
      const mem = process.memoryUsage();
      const totalMem = os.totalmem(), freeMem = os.freemem();
      let disk = null;
      try {
        const st = fs.statfsSync(ROOT);
        const totalB = st.blocks * st.bsize, freeB = st.bfree * st.bsize, usedB = totalB - freeB;
        disk = {
          totalGB: +(totalB / 1073741824).toFixed(1),
          usedGB: +(usedB / 1073741824).toFixed(1),
          freeGB: +(freeB / 1073741824).toFixed(1),
          percent: totalB ? Math.round(usedB / totalB * 1000) / 10 : 0
        };
      } catch (e) { disk = null; }
      jsonRes(res, 200, {
        ok: true,
        online: players.size,
        uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        cpu: cpuUsagePercent(),
        memPercent: Math.round((1 - freeMem / totalMem) * 1000) / 10,
        memUsedMB: Math.round((totalMem - freeMem) / 1048576),
        memTotalMB: Math.round(totalMem / 1048576),
        disk,
        worldChanges: worldTiles.size,
        seed: WORLD_SEED,
        day: gameDay, time: gameTime,
        config,
        banned: banlist.length,
        kicked: Object.keys(kicklist).length,
        privileged: Object.values(roles).filter(r=>r==='admin'||r==='developer').length,
      });
      break;
    }
    case '/api/op/kick': {
      if (!requireOp(res, opAuthed)) break;
      const p = players.get(Number(data.id));
      if (!p) { jsonRes(res, 404, {ok:false, error:'not_online'}); break; }
      kickPlayer(p.nickname, 'op', data.reason);
      removePlayer(Number(data.id), { type:'kick', reason: data.reason || '你已被管理员踢出（5分钟内无法重进）' });
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/op/ban': {
      if (!requireOp(res, opAuthed)) break;
      const nickname = resolveNickname(data);
      if (!nickname) { jsonRes(res, 400, {ok:false, error:'no_target'}); break; }
      banPlayer(nickname, data.reason, 'op');
      const p = [...players.values()].find(x => x.nickname === nickname);
      if (p) removePlayer(p.id, { type:'kick', reason:'你已被封禁' });
      jsonRes(res, 200, {ok:true, nickname});
      break;
    }
    case '/api/op/unban': {
      if (!requireOp(res, opAuthed)) break;
      const a = data.uid ? resolveAccountByIdent(data.uid) : null;
      const nick = (a && a.nickname) || String(data.nickname || '');
      const ok = unbanPlayer(nick, 'op');
      jsonRes(res, 200, {ok, nickname:nick});
      break;
    }
    case '/api/op/banlist': {
      if (!requireOp(res, opAuthed)) break;
      jsonRes(res, 200, { ok: true, bans: banlist });
      break;
    }
    case '/api/op/setrole': {
      if (!requireOp(res, opAuthed)) break;
      const nickname = resolveNickname(data);
      const role = String(data.role || 'player');
      if (!nickname || !['player','admin','developer'].includes(role)) {
        jsonRes(res, 400, {ok:false, error:'bad_params'}); break;
      }
      setRole(nickname, role, 'op');
      jsonRes(res, 200, {ok:true, nickname, role});
      break;
    }
    case '/api/op/setmode': {
      if (!requireOp(res, opAuthed)) break;
      const nickname = resolveNickname(data);
      const p = resolveOnline(nickname);
      const mode = String(data.mode || '');
      if (!nickname || !['survival','creative'].includes(mode)) {
        jsonRes(res, 400, {ok:false, error:'bad_params'}); break;
      }
      const role = getRole(nickname);
      if (role !== 'admin' && role !== 'developer') {
        jsonRes(res, 403, {ok:false, error:'mode_denied', message:'只有管理员或开发者可以使用创造模式'}); break;
      }
      // 管理员 / 开发者均可自选模式：保存所选模式，由 applyRole 决定实际效果
      // （开发者显式选 survival 即进入生存，便于测试；其余默认创造 / 沿用各自逻辑）
      playerModes[nickname] = mode;
      saveJson(MODES_FILE, playerModes);
      if (p) {
        applyRole(p, role);
        sendTo(p.id, { type:'mode_update', id:p.id, mode:p.mode, canFly:!!p.canFly, infiniteItems:!!p.infiniteItems });
        broadcast({ type:'mode_update', id:p.id, mode:p.mode }, p.id);
      }
      broadcastPlayerList();
      logAdmin('setmode', 'op', nickname, 'mode=' + (p ? p.mode : mode));
      jsonRes(res, 200, {ok:true, nickname, mode:p ? p.mode : mode});
      break;
    }
    case '/api/op/shutdown': {
      if (!requireOp(res, opAuthed)) break;
      logAdmin('shutdown', 'op', '', '管理员从面板发起服务器关闭');
      jsonRes(res, 200, { ok:true, message:'服务器正在关闭' });
      // 先广播关闭公告，让在线玩家收到提示；稍后优雅退出进程
      broadcast({ type:'chat', prefix:'[系统]', nickname:'服务器', text:'服务器即将关闭，感谢游玩！', level:'system' });
      setTimeout(() => { try { if (typeof server !== 'undefined' && server && server.close) server.close(); } catch (_) {} process.exit(0); }, 800);
      break;
    }
    case '/api/op/config': {
      if (!requireOp(res, opAuthed)) break;
      // 只允许更新已知布尔开关，防止注入任意字段
      for (const k of ['pvp','creativeModeControl','chatEnabled','playerListDisplay','deathDrop','hungerEnabled','nuclearEnabled','mobilePerformance']) {
        if (typeof data[k] === 'boolean') config[k] = data[k];
      }
      saveJson(CONFIG_FILE, config);
      broadcast({ type:'config', config });
      logAdmin('config', 'op', '', JSON.stringify(config));
      jsonRes(res, 200, {ok:true, config});
      break;
    }
    case '/api/op/log': {
      if (!requireOp(res, opAuthed)) break;
      jsonRes(res, 200, {ok:true, log: adminLog.slice(-50).reverse()});
      break;
    }
    case '/api/op/console': {
      if (!requireOp(res, opAuthed)) break;
      // data.line 存在 = 执行命令；否则 = 拉取增量输出
      if (data.line !== undefined) {
        const line = String(data.line || '');
        console.log('> ' + line);
        const out = runServerCommand(line, 'op-console');
        if (out) console.log(out);
        jsonRes(res, 200, { ok:true, output: out, cursor: __consoleSeq });
      } else {
        const since = Number(data.since || 0) || 0;
        const lines = __consoleBuffer.filter(l => l.id > since);
        jsonRes(res, 200, { ok:true, lines, cursor: __consoleSeq });
      }
      break;
    }
    case '/api/op/shell': {
      // 系统终端：open / write / read / close（持久 shell 进程，支持 python 等交互程序）
      if (!requireOp(res, opAuthed)) break;
      const sAction = String(data.action || '');
      if (sAction === 'open') {
        const sess = spawnShell();
        const who = (opSession(opToken) || {}).user || 'op';
        logAdmin('shell_open', who, '', '');
        jsonRes(res, 200, { ok:true, id: sess.id, cwd: path.join(__dirname, '..'), build: '4.4.4v2.7' });
        break;
      }
      const sess = SHELL_SESSIONS.get(String(data.id || ''));
      if (!sess) { jsonRes(res, 404, { ok:false, error:'no_session', message:'系统终端会话不存在或已关闭' }); break; }
      if (sAction === 'write') {
        const line = String(data.line || '');
        if (!sess.closed && sess.proc.stdin && sess.proc.stdin.writable) sess.proc.stdin.write(line + '\r\n');
        jsonRes(res, 200, { ok:true });
        break;
      }
      if (sAction === 'read') {
        const since = Number(data.since || 0) || 0;
        const lines = sess.out.filter(l => l.id > since);
        jsonRes(res, 200, { ok:true, lines, cursor: sess.seq, closed: sess.closed });
        break;
      }
      if (sAction === 'close') {
        try { sess.proc.kill(); } catch (e) {}
        SHELL_SESSIONS.delete(sess.id);
        jsonRes(res, 200, { ok:true });
        break;
      }
      jsonRes(res, 400, { ok:false, error:'bad_action' });
      break;
    }
    case '/api/op/announce': {
      if (!requireOp(res, opAuthed)) break;
      const text = String(data.text || '').trim().slice(0, CHAT_MAX_LEN);
      if (text) serverMessage(text);
      logAdmin('announce', 'op', '', text);
      jsonRes(res, 200, {ok:true});
      break;
    }

    case '/api/op/backup': {
      if (!requireOp(res, opAuthed)) break;
      try {
        const r = createBackup();
        logAdmin('backup_create', 'op', r.name, `${r.files} 个文件 ${r.size}B`);
        jsonRes(res, 200, { ok: true, backup: r });
      } catch (e) { jsonRes(res, 500, { ok: false, error: 'backup_failed', message: e.message }); }
      break;
    }
    case '/api/op/backups': {
      if (!requireOp(res, opAuthed)) break;
      let list = [];
      try {
        if (fs.existsSync(SAVE_DIR)) {
          list = fs.readdirSync(SAVE_DIR).filter(f => /\.zip$/i.test(f)).map(f => {
            const st = fs.statSync(path.join(SAVE_DIR, f));
            return { name: f, size: st.size, mtime: st.mtime.toISOString() };
          }).sort((a, b) => b.name.localeCompare(a.name));
        }
      } catch (e) {}
      jsonRes(res, 200, { ok: true, backups: list, dir: path.relative(SERVER_ROOT, SAVE_DIR).replace(/\\/g, '/') });
      break;
    }
    case '/api/op/backup/restore': {
      if (!requireOp(res, opAuthed)) break;
      const name = String(data.name || '');
      if (!/^[\w.\-]{1,120}\.zip$/i.test(name)) { jsonRes(res, 400, { ok: false, error: 'bad_name' }); break; }
      const file = path.join(SAVE_DIR, name);
      if (!fs.existsSync(file)) { jsonRes(res, 404, { ok: false, error: 'not_found' }); break; }
      try {
        const n = applyRestore(fs.readFileSync(file));
        logAdmin('backup_restore', 'op', name, `恢复 ${n} 个文件`);
        jsonRes(res, 200, { ok: true, restored: n });
      } catch (e) { jsonRes(res, 400, { ok: false, error: 'restore_failed', message: e.message }); }
      break;
    }
    case '/api/op/backup/download': {
      if (!requireOp(res, opAuthed)) break;
      const name = String(data.name || '');
      if (!/^[\w.\-]{1,120}\.zip$/i.test(name)) { jsonRes(res, 400, { ok: false, error: 'bad_name' }); break; }
      const file = path.join(SAVE_DIR, name);
      if (!fs.existsSync(file)) { jsonRes(res, 404, { ok: false, error: 'not_found' }); break; }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
      fs.createReadStream(file).pipe(res);
      break;
    }
    case '/api/op/hard-reset': {
      if (!requireOp(res, opAuthed)) break;
      try {
        const r = hardResetWorld();
        logAdmin('hard_reset', 'op', '', `新种子=${r.seed} 踢下线=${r.kicked}`);
        jsonRes(res, 200, { ok: true, seed: r.seed, kicked: r.kicked });
      } catch (e) { jsonRes(res, 500, { ok: false, error: 'reset_failed', message: e.message }); }
      break;
    }
    // ---------- 旧版管理接口（保留路径兼容旧管理面板，V3.7 起要求鉴权） ----------
    case '/api/save': {
      if (!requireOp(res, opAuthed)) break;
      saveWorld();
      logAdmin('save', 'op', '', '');
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/kick': {
      if (!requireOp(res, opAuthed)) break;
      const p = players.get(Number(data.id));
      if (p) {
        kickPlayer(p.nickname, 'op', data.reason);
        removePlayer(Number(data.id), { type:'kick', reason:'你已被管理员踢出（5分钟内无法重进）' });
      }
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/reset': {
      if (!requireOp(res, opAuthed)) break;
      worldInteractions.chests={};worldInteractions.leases.clear();worldInteractions.drops.clear();worldInteractions.save();
      worldTiles.clear();
      pendingSync.clear();
      logAdmin('reset', 'op', '', '世界差量已清空');
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/ban': {
      if (!requireOp(res, opAuthed)) break;
      const p = players.get(Number(data.id));
      if (p) {
        banPlayer(p.nickname, data.reason, 'op');
        removePlayer(Number(data.id), { type:'kick', reason:'你已被封禁' });
      }
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/unban': {
      if (!requireOp(res, opAuthed)) break;
      unbanPlayer(String(data.nickname||''), 'op');
      jsonRes(res, 200, {ok:true});
      break;
    }

    // ---------- 游戏协议接口（公开，HTTP 轮询模式使用） ----------
    case '/api/join': {
      const accountId=accountIdFromToken(data.accountToken);
      if(!accountId){jsonRes(res,401,{ok:false,error:'请先登录'});return;}
      if([...players.values()].some(p=>p.accountId===accountId)){jsonRes(res,409,{ok:false,error:'账户已在线'});return;}
      const nickname=accounts[accountId].nickname;
      // V3.7 加入检查：先 Ban 后 Kick
      if (isBanned(nickname)) { jsonRes(res, 403, {error:'banned', reason:'你已被封禁'}); break; }
      const remain = kickedRemain(nickname);
      if (remain > 0) { jsonRes(res, 403, {error:'kicked', until: Date.now() + remain, reason:'你已被踢出，请 ' + Math.ceil(remain/60000) + ' 分钟后再试'}); break; }
      const id = nextId++;
      const role = getRole(nickname);
      const old = savedPlayers[nickname] || {};
      const p = applyRole({
        id, ws: null, accountId, nickname, uid: accounts[accountId].uid,
        x: Number.isFinite(Number(old.x)) ? Number(old.x) : 0,
        y: Number.isFinite(Number(old.y)) ? Number(old.y) : 0,
        vx: 0, vy: 0, facing: old.facing || 1, walkPhase: 0,
        health: old.health || 100, hunger:old.hunger ?? 20, xp:old.xp||0, level:old.level||1,
        armor:old.armor||0, equipment:old.equipment||{},
        inventory: old.inventory || {},
        inventorySlots: Array.isArray(old.inventorySlots) ? old.inventorySlots : [],
        hotbar: old.hotbar || [0,0,0,0,0,0,0,0,0,0],
        lastActive: Date.now(), messages: [],
      }, role);
      players.set(id, p);
      // 加入即同步时间：把当前权威昼夜时钟以 force 形式塞进消息队列，
      // 客户端 poll 时会随 welcome 一并拿到并立即对齐（与 WS 模式一致）。
      p.messages.push({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
      broadcast({ type: 'join', id, nickname, role: p.role, prefix: p.prefix, mode: p.mode }, id);
      broadcastOnlineCount();
      broadcastPlayerList();
      console.log(`[HTTP join] id=${id} nickname=${nickname} role=${p.role} (${players.size} online)`);
      logPlayerAction(nickname, 'join', `http id=${id} role=${p.role}`);
      jsonRes(res, 200, {
        id, uid: p.uid, seed: WORLD_SEED,
        role: p.role, prefix: p.prefix, mode: p.mode,
        canFly: p.canFly, infiniteItems: p.infiniteItems,
        x: p.x, y: p.y, inventory: p.inventory || {}, inventorySlots: p.inventorySlots || [], hotbar: p.hotbar || [],
        config,
        players: getPlayerList(id),
        worldstate: worldStatePayload(), // 下发服务端权威世界差量
      });
      break;
    }
    case '/api/players': {
      const list = getPlayerList();
      jsonRes(res, 200, {
        count: list.length,
        players: list.map(p => ({
          id:p.id, accountId:p.accountId, uid:p.uid, nickname:p.nickname, x:p.x, y:p.y, coordinates:PlayerView.coordinates(p.x,p.y), health:p.health, hunger:p.hunger, armor:armorReduction(p), xp:p.xp, level:p.level, online:true,
          role:p.role, prefix:p.prefix, mode:p.mode,
        }))
      });
      break;
    }
    case '/api/player/info': {
      const p = players.get(Number(data.id));
      jsonRes(res, 200, p ? {
        ok:true, id:data.id, nickname:p.nickname, x:p.x, y:p.y, health:p.health,
        role:p.role, prefix:p.prefix, mode:p.mode,
      } : {ok:false});
      break;
    }
    case '/api/chat': {
      // HTTP 轮询模式聊天
      const p = players.get(Number(data.id));
      if (!p) { jsonRes(res, 404, {ok:false, error:'not_online'}); break; }
      p.lastActive = Date.now();
      handleChat(p, data.text, data.channel);
      jsonRes(res, 200, {ok:true});
      break;
    }
    case '/api/move': {
      const p = players.get(data.id);
      if (!p) { res.writeHead(404); res.end('Not found'); return; }
      p.x = data.x; p.y = data.y;
      p.vx = data.vx; p.vy = data.vy;
      p.facing = PlayerView.facing(data.facing,p.facing); p.walkPhase = data.walkPhase;
      // 不在服务端采信客户端上报的血量（与 WS move 保持一致，服务端权威）。
      // 旧代码 p.health=data.health 会让客户端本地回血把权威血量重置回满，导致 PVP 永远打不死。
      // 仅保留：无敌窗口内血量下限保护 + 客户端自报死亡(health<=0)时触发服务端死亡结算。
      if (p.invulnerableUntil && Date.now()<p.invulnerableUntil) p.health=Math.max(1,p.health);
      if (Number(data.health)<=0) handlePlayerDeath(p,'client');
      p.lastActive = Date.now();
      broadcast({ type: 'move', id: data.id, ...data, health:p.health, facing:p.facing }, data.id);
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/block': {
      const p = players.get(data.id);
      if (!p) { jsonRes(res, 403, { ok:false, error:'not_joined' }); return; } // 仅在线（已加入）玩家可修改世界
      p.lastActive = Date.now();
      if(recordBlock(data.tx, data.ty, data.tileId,p)===false){jsonRes(res,403,{ok:false,error:'箱子受保护'});return;} // 记入权威世界
      broadcast({ type: 'block', id: data.id, tx: data.tx, ty: data.ty, tileId: data.tileId }, data.id);
      logPlayerAction(p.nickname, 'block', `tx=${data.tx} ty=${data.ty} tile=${data.tileId}`);
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/flash': {
      // 闪光弹事件（HTTP 轮询模式上报）：转发给其他在线玩家
      const p = players.get(data.id);
      if (p) p.lastActive = Date.now();
      broadcast({ type: 'flash', id: data.id, x: data.x, y: data.y }, data.id);
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/sleep': {
      const p = players.get(data.id);
      if (!p) { jsonRes(res, 403, { ok:false, error:'not_joined' }); return; } // 仅在线玩家可跳过黑夜
      // 床跳过黑夜（HTTP 轮询模式）：把服务端权威昼夜时钟跳到早晨并立即广播
      gameTime = 0;
      broadcast({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/poll': {
      const p = players.get(data.id);
      if (!p) { res.writeHead(404); res.end('Not found'); return; }
      // V3.7：HTTP 模式玩家同样受 Ban/Kick 约束（轮询时检查，立即生效）
      if (isBanned(p.nickname)) {
        removePlayer(data.id, { type:'kick', reason:'你已被封禁' });
        jsonRes(res, 403, {error:'banned'}); return;
      }
      if (kickedRemain(p.nickname) > 0) {
        removePlayer(data.id, { type:'kick', reason:'你已被踢出' });
        jsonRes(res, 403, {error:'kicked'}); return;
      }
      p.lastActive = Date.now();
      const messages = p.messages || [];
      p.messages = [];
      const playerList = getPlayerList(data.id);
      playerList.unshift({
        id: data.id, nickname: p.nickname,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        facing: p.facing, walkPhase: p.walkPhase, health: p.health,
        inventory: p.inventory || {},
        hotbar: p.hotbar || [],
        role: p.role, prefix: p.prefix, mode: p.mode,
      });
      jsonRes(res, 200, { messages, players: playerList });
      break;
    }
    case '/api/action': { const p=players.get(Number(data.id)); if(p&&data.type==='use_food') useFood(p,data.itemId); else if(p&&data.type==='equip_armor') equipArmor(p,data.itemId); else if(p&&data.type==='unequip_armor') unequipArmor(p); else if(p&&data.type==='player_death') handlePlayerDeath(p,data.cause||'client'); jsonRes(res,200,{ok:true}); break;}
    default:
      res.writeHead(404); res.end('Not Found');
  }
}

// ==================== WebSocket 服务器 ====================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  console.log(`[connect] id=${id}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
    const p = players.get(id);
    if (p) p.lastActive = Date.now();

    if(msg.type==='world_action'){
      sendTo(id,{type:'world_result',requestId:msg.requestId,...handleWorldAction(p,msg)});return;
    }
    switch (msg.type) {
      case 'join': {
        const accountId = accountIdFromToken(msg.accountToken);
        const account = accountId ? accounts[accountId] : null;
        if (!account) { ws.send(JSON.stringify({type:'kick',reason:'请先登录游戏账户'})); try{ws.close();}catch(e){} return; }
        if ([...players.values()].some(x=>x.accountId===accountId)) { ws.send(JSON.stringify({type:'kick',reason:'该账户已经在线'})); try{ws.close();}catch(e){} return; }
        const nickname = account.nickname;
        // V3.7 加入检查：先 Ban 后 Kick，不通过则告知原因并断开
        if (isBanned(nickname)) {
          ws.send(JSON.stringify({ type:'kick', reason:'你已被封禁，无法加入服务器' }));
          try { ws.close(); } catch (e) {}
          return;
        }
        const remain = kickedRemain(nickname);
        if (remain > 0) {
          ws.send(JSON.stringify({ type:'kick', reason:'你已被踢出，请 ' + Math.ceil(remain/60000) + ' 分钟后再试' }));
          try { ws.close(); } catch (e) {}
          return;
        }
        const old = savedPlayers[nickname] || {};
        const role = getRole(nickname);
        const np = applyRole({
          id, ws, accountId, nickname, uid: accounts[accountId].uid,
          x: old.x || 0, y: old.y || 0, vx: 0, vy: 0, facing: old.facing || 1, walkPhase: 0, health: old.health || 100, hunger:old.hunger ?? 20, xp:old.xp||0, level:old.level||1, armor:old.armor||0, equipment:old.equipment||{},
          inventory: old.inventory || {},
          inventorySlots: Array.isArray(old.inventorySlots) ? old.inventorySlots : [],
          hotbar: old.hotbar || [0,0,0,0,0,0,0,0,0,0],
          lastActive: Date.now(), messages: [],
        }, role);
        players.set(id, np);

        const playerList = [];
        for (const [pid, op] of players) {
          if (pid !== id) {
            playerList.push({
              id: pid, nickname: op.nickname, uid: op.uid,
              x: op.x, y: op.y, vx: op.vx, vy: op.vy,
              facing: op.facing, walkPhase: op.walkPhase, health: op.health,
              inventory: op.inventory || {},
              inventorySlots: op.inventorySlots || [],
              hotbar: op.hotbar || [],
              role: op.role || 'player', prefix: op.prefix || '',
              mode: op.mode || 'survival',
            });
          }
        }
        // 欢迎消息携带服务端权威世界差量 + V3.7 身份/模式/世界配置
        sendTo(id, {
          type: 'welcome', id, seed: WORLD_SEED,
          players: playerList,
          inventory: np.inventory || {}, inventorySlots: np.inventorySlots || [], hotbar: np.hotbar || [],
          x: np.x, y: np.y,
          role: np.role, prefix: np.prefix, mode: np.mode,
          canFly: np.canFly, infiniteItems: np.infiniteItems,
          config,
          worldstate: worldStatePayload(),
        });
        // 加入即同步时间：立即推一条 force 同步，客户端收到瞬间对齐昼夜（无需等 200ms 广播收敛）
        sendTo(id, { type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });

        broadcast({ type: 'join', id, nickname, role: np.role, prefix: np.prefix, mode: np.mode }, id);
        broadcastOnlineCount();
        broadcastPlayerList();
        console.log(`[join] id=${id} nickname=${nickname} role=${np.role} (${players.size} online)`);
        logPlayerAction(nickname, 'join', `ws id=${id} role=${np.role}`);
        break;
      }
      case 'playerData': {
        const p = players.get(id);
        if (!p) return;
        p.inventory = msg.inventory || {};
        if (Array.isArray(msg.inventorySlots)) p.inventorySlots = msg.inventorySlots;
        p.hotbar = msg.hotbar || [];
        const v = validateMovement(p, msg.x ?? p.x, msg.y ?? p.y);
        p.x = v.x; p.y = v.y;
        break;
      }
      case 'move': {
        const p = players.get(id);
        if (!p) return;
        const v = validateMovement(p, msg.x, msg.y);
        p.x = v.x; p.y = v.y;
        p.vx = msg.vx; p.vy = msg.vy;
        p.facing = PlayerView.facing(msg.facing,p.facing); p.walkPhase = msg.walkPhase;
        if (p.invulnerableUntil && Date.now()<p.invulnerableUntil) p.health=Math.max(1,p.health);
        if (Number(msg.health)<=0) handlePlayerDeath(p,'client');
        p.lastActive = Date.now();
        broadcast({ type: 'move', id, x:v.x, y:v.y, vx:p.vx, vy:p.vy, walkPhase:p.walkPhase, facing:p.facing }, id);
        break;
      }
      case 'block': {
        const p = players.get(id);
        if (!p) return; // 未加入的连接不得修改权威世界
        p.lastActive = Date.now();
        if(recordBlock(msg.tx, msg.ty, msg.tileId,p)===false){sendTo(id,{type:'block',tx:msg.tx,ty:msg.ty,tileId:(worldTiles.get(msg.ty*WORLD_W+msg.tx) ?? 0)});return;} // 记入权威世界（非法/受保护则回滚为当前方块）
        broadcast({ type: 'block', id, tx: msg.tx, ty: msg.ty, tileId: msg.tileId }, id);
        logPlayerAction(p.nickname, 'block', `tx=${msg.tx} ty=${msg.ty} tile=${msg.tileId}`);
        break;
      }
      case 'chat': {
        // V3.7 聊天：身份前缀 + 公告频道 + 限速（逻辑在 handleChat）
        handleChat(players.get(id), msg.text, msg.channel);
        break;
      }
      case 'pvp_hit': {
        // V3.7 PVP：服务端开关 + 伤害/距离校验（逻辑在 handlePvpHit）
        handlePvpHit(players.get(id), msg);
        break;
      }
      case 'use_food': { const p=players.get(id); if(p) useFood(p,msg.itemId); break; }
      case 'unequip_armor': {const p=players.get(id);if(p)unequipArmor(p);break;}
      case 'equip_armor': { const p=players.get(id); if(p) equipArmor(p,msg.itemId); break; }
      case 'player_death': { const p=players.get(id); if(p && (p.health<=0 || msg.confirm===true)) handlePlayerDeath(p,msg.cause||'client'); break; }
      case 'flash': {
        // 闪光弹事件转发：其他客户端按距离自行判定是否被闪
        const p = players.get(id);
        if (p) p.lastActive = Date.now();
        broadcast({ type: 'flash', id, x: msg.x, y: msg.y }, id);
        break;
      }
      case 'sleep': {
        const p = players.get(id);
        if (!p) return; // 仅在线玩家可跳过黑夜
        // 床跳过黑夜：把服务端权威昼夜时钟直接跳到早晨，并立即广播（force=true 让所有客户端瞬间对齐）
        gameTime = 0;
        broadcast({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
        break;
      }
    }
    } catch (e) { console.error('[ws] 消息处理异常:', e && e.stack ? e.stack : e); }
  });

  ws.on('close', () => {
    const closingPlayer=players.get(id);if(closingPlayer?.accountId)worldInteractions.release(closingPlayer.accountId);

    if (players.has(id)) {
      const p = players.get(id);
      savedPlayers[p.nickname] = savePlayerData(p);
      savePlayers();
      players.delete(id);
      broadcast({ type: 'leave', id });
      broadcastOnlineCount();
      broadcastPlayerList();
      console.log(`[leave] id=${id} nickname=${p.nickname} (${players.size} online)`);
      logPlayerAction(p.nickname, 'leave', `id=${id}`);
    }
  });

  ws.on('error', () => {
    // V3.7 修复：旧版此处引用了未定义的 p 会直接抛异常
    if (players.has(id)) {
      const p = players.get(id);
      savedPlayers[p.nickname] = savePlayerData(p);
      savePlayers();
      players.delete(id);
      broadcast({ type: 'leave', id });
      broadcastOnlineCount();
      broadcastPlayerList();
    }
  });
});

// ==================== 服务器指令（控制台 / 管理面板 / 游戏内共用） ====================
const CONSOLE_HELP = [
  '可用指令：',
  '  help                          显示帮助',
  '  online                        列出在线玩家',
  '  say <文字>                    全服公告',
  '  give <玩家|*> <物品ID> [数量]  发放物品（* = 全部在线）',
  '  kick <玩家>                   踢出在线玩家',
  '  ban <玩家> [原因]             封禁玩家',
  '  unban <玩家>                  解除封禁',
  '  role <玩家> <player|admin|developer>  设置身份',
  '  mode <玩家> <survival|creative>       设置模式',
  '  day                           查看游戏天数/时间',
  '  save                          保存世界',
  '  reset                         清空世界差量',
  '  stop                          关闭服务器进程',
].join('\n');

function resolveOnline(nickname) {
  const n = String(nickname || '').trim();
  if (!n) return null;
  return [...players.values()].find(p => p.nickname === n || p.accountId === n) || null;
}
function resolveAccount(nickname) {
  const n = String(nickname || '').trim();
  if (!n) return null;
  return accounts[n] || Object.values(accounts).find(a => a.nickname === n) || null;
}
function applyPlayerMode(nickname, mode) {
  if (!['survival', 'creative'].includes(mode)) return '模式只能是 survival 或 creative';
  playerModes[nickname] = mode;
  saveJson(MODES_FILE, playerModes);
  const p = resolveOnline(nickname);
  if (p) {
    applyRole(p, getRole(nickname));
    sendTo(p.id, { type:'mode_update', id:p.id, mode:p.mode, canFly:!!p.canFly, infiniteItems:!!p.infiniteItems });
    broadcast({ type:'mode_update', id:p.id, mode:p.mode }, p.id);
  }
  broadcastPlayerList();
  logAdmin('setmode', 'console', nickname, 'mode=' + mode);
  return `已设置 ${nickname} 的模式为 ${mode}`;
}
function consoleGive(nickname, itemId, count) {
  if (nickname === '*') {
    let n = 0;
    for (const p of players.values()) {
      p.inventory = p.inventory || {};
      p.inventory[itemId] = (p.inventory[itemId] || 0) + count;
      sendTo(p.id, { type:'inventory_update', inventory:p.inventory, inventorySlots:p.inventorySlots||[], hotbar:p.hotbar||[] });
      syncStats(p); n++;
    }
    savePlayers();
    return `已给 ${n} 名在线玩家发放 ${itemId}×${count}`;
  }
  const p = resolveOnline(nickname);
  if (p) {
    p.inventory = p.inventory || {};
    p.inventory[itemId] = (p.inventory[itemId] || 0) + count;
    sendTo(p.id, { type:'inventory_update', inventory:p.inventory, inventorySlots:p.inventorySlots||[], hotbar:p.hotbar||[] });
    syncStats(p); savePlayers();
    return `已给在线玩家 ${nickname} 发放 ${itemId}×${count}`;
  }
  const acct = resolveAccount(nickname);
  if (!acct) return `未找到玩家或账户：${nickname}`;
  const sd = savedPlayers[acct.nickname] || savePlayerData({ x:0, y:0, health:100, inventory:{}, hotbar:[0,0,0,0,0,0,0,0,0,0], hunger:20, xp:0, level:1, armor:0, equipment:{} });
  sd.inventory = sd.inventory || {};
  sd.inventory[itemId] = (sd.inventory[itemId] || 0) + count;
  savedPlayers[acct.nickname] = sd;
  savePlayers();
  return `已给离线玩家 ${acct.nickname} 发放 ${itemId}×${count}`;
}

function runServerCommand(rawLine, by) {
  by = by || 'console';
  const line = String(rawLine || '').trim();
  if (!line) return '';
  const sp = line.indexOf(' ');
  const cmd = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
  const args = rest ? rest.split(/\s+/) : [];
  try {
    switch (cmd) {
      case 'help': case '?': return CONSOLE_HELP;
      case 'online': case 'list': {
        if (!players.size) return '当前没有在线玩家';
        return '在线 ' + players.size + ' 人：\n' + [...players.values()].map(p => `  [${p.id}] ${p.nickname} (${p.role || 'player'}${p.accountId ? ' · ' + p.accountId : ''})`).join('\n');
      }
      case 'say': case 'announce': {
        if (!rest) return '用法：say <文字>';
        serverMessage(rest); logAdmin('announce', by, '', rest);
        return '已发送公告：' + rest;
      }
      case 'give': {
        if (args.length < 2) return '用法：give <玩家|*> <物品ID> [数量]';
        const itemId = Number(args[1]);
        const count = Math.max(1, Math.min(9999, Number(args[2]) || 1));
        if (!Number.isFinite(itemId) || itemId < 0 || itemId > 255) return '物品ID需在 0-255';
        return consoleGive(args[0], itemId, count);
      }
      case 'kick': {
        if (!args[0]) return '用法：kick <玩家>';
        const p = resolveOnline(args[0]);
        if (!p) return `玩家不在线：${args[0]}`;
        kickPlayer(p.nickname, by, rest.slice(args[0].length).trim());
        removePlayer(p.id, { type:'kick', reason:'你已被管理员踢出' });
        return `已踢出 ${p.nickname}`;
      }
      case 'ban': {
        if (!args[0]) return '用法：ban <玩家> [原因]';
        const reason = rest.slice(args[0].length).trim();
        banPlayer(args[0], reason, by);
        const p = resolveOnline(args[0]);
        if (p) removePlayer(p.id, { type:'kick', reason:'你已被封禁' });
        return `已封禁 ${args[0]}${reason ? '：' + reason : ''}`;
      }
      case 'unban': {
        if (!args[0]) return '用法：unban <玩家>';
        return unbanPlayer(args[0], by) ? `已解除封禁 ${args[0]}` : `${args[0]} 不在封禁列表`;
      }
      case 'role': {
        if (args.length < 2) return '用法：role <玩家> <player|admin|developer>';
        const role = args[1].toLowerCase();
        if (!['player','admin','developer'].includes(role)) return '身份只能是 player / admin / developer';
        return setRole(args[0], role, by) ? `已设置 ${args[0]} 的身份为 ${role}` : `未找到玩家：${args[0]}`;
      }
      case 'mode': {
        if (args.length < 2) return '用法：mode <玩家> <survival|creative>';
        return applyPlayerMode(args[0], args[1].toLowerCase());
      }
      case 'day': case 'time': {
        return `游戏第 ${gameDay} 天，时间 ${Number(gameTime).toFixed(2)}`;
      }
      case 'save': {
        saveWorld(); logAdmin('save', by, '', '');
        return '世界已保存';
      }
      case 'reset': {
        worldInteractions.chests = {};
        worldInteractions.leases.clear();
        worldInteractions.drops.clear();
        worldInteractions.save();
        worldTiles.clear();
        pendingSync.clear();
        logAdmin('reset', by, '', '世界差量已清空');
        return '世界差量已清空';
      }
      case 'clear': return '';
      case 'stop': {
        console.log(`[console] 收到 stop（by ${by}），2 秒后关闭服务器…`);
        setTimeout(() => process.exit(0), 2000);
        return '服务器将在 2 秒后关闭';
      }
      default: return `未知指令：${cmd}（输入 help 查看可用指令）`;
    }
  } catch (e) { return '指令执行出错：' + e.message; }
}

// ==================== 服务器终端：stdin 直接输入指令 ====================
try {
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let __stdinBuf = '';
    process.stdin.on('data', (chunk) => {
      __stdinBuf += chunk;
      let idx;
      while ((idx = __stdinBuf.indexOf('\n')) >= 0) {
        const line = __stdinBuf.slice(0, idx).trim();
        __stdinBuf = __stdinBuf.slice(idx + 1);
        if (!line) continue;
        const out = runServerCommand(line, 'terminal');
        if (out) console.log(out);
      }
    });
    console.log('[console] 服务器终端已就绪（输入 help 查看指令）');
    console.log('[console] 系统终端（OS Shell）已启用 · 构建 4.4.4v2.7（cmd/bash，可执行 dir / python 等）');
  }
} catch (e) {}

// UID 迁移：为历史账户补齐 uid（一次性，补齐后随账户保存）
let __uidFixed = 0;
for (const a of Object.values(accounts)) { if (!a.uid) { a.uid = genUid(); __uidFixed++; } }
if (__uidFixed) { saveAccounts(); console.log(`[uid] 已为 ${__uidFixed} 个历史账户补齐 UID`); }

// ==================== 启动 / 退出 ====================
server.listen(PORT, "0.0.0.0", () => {
  // 初始化：新建 world / data 存档目录（已存在则忽略），并恢复最近一份存档
  if (!fs.existsSync(WORLD_DIR)) fs.mkdirSync(WORLD_DIR, { recursive: true });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  loadLatestWorld();
  console.log(`✅ 像素沙盒 · 服务器版 V4.4.4v2（增强版）已启动，端口 ${PORT}`);
  console.log(`   世界种子: ${WORLD_SEED}（WORLD_W=${WORLD_W} WORLD_H=${WORLD_H}，须与 js/data.js 一致）`);
  console.log(`   用户目录: ${USERS_DIR}（accounts/players/roles/player-modes）`);
  console.log(`   数据目录: ${DATA_DIR}（banlist/kicklist/admin-log/config/op-password）`);
  console.log(`   日志目录: ${LOG_DIR}（server / admin-login / player-actions 按日分文件）`);
  console.log(`   存档目录: ${WORLD_DIR}（每 ${SAVE_INTERVAL_MS}ms 按系统时间命名落盘一份世界数据）`);
  console.log(`   世界配置: PVP=${config.pvp} 聊天=${config.chatEnabled} 创造管控=${config.creativeModeControl}`);
  console.log(`   静态托管: index.html / css / js`);
  startSakuraFrpWatcher((info) => {
    if (info && info.url) {
      console.log(`   🌐 SakuraFrp 公网地址: ${info.url}`);
      console.log(`   🔌 WebSocket: ${info.wsUrl}`);
    }
  });
});

// 构建权威世界数据快照（落盘与退出前保存共用）
function buildWorldPayload() {
  return {
    seed: WORLD_SEED,
    time: gameTime,
    day: gameDay,
    savedAt: new Date().toISOString(),
    tiles: Array.from(worldTiles.entries()),
  };
}

// 将权威世界数据落盘到 world/（按系统时间命名）。异步写，不阻塞主循环。
function saveWorld() {
  const file = path.join(WORLD_DIR, `world_${fileTimestamp()}.json`);
  fs.writeFile(file, JSON.stringify(buildWorldPayload()), (err) => {
    if (err) console.error('[save] 世界数据保存失败:', err.message);
    else pruneOldSaves();
  });
}

// 自动清理：只保留最近 MAX_SAVE_FILES 份存档，超出部分删除最旧的（文件名定宽时间戳，字典序=时间序）
function pruneOldSaves() {
  let files;
  try {
    files = fs.readdirSync(WORLD_DIR).filter(f => /^world_\d{4}-\d{2}-\d{2}_.*\.json$/.test(f));
  } catch (e) { return; }
  if (files.length <= MAX_SAVE_FILES) return;
  files.sort();
  const excess = files.slice(0, files.length - MAX_SAVE_FILES);
  let removed = 0;
  for (const f of excess) {
    try { fs.unlinkSync(path.join(WORLD_DIR, f)); removed++; } catch (e) {}
  }
  if (removed > 0) logThrottled('save-prune', `[save] 已自动清理 ${removed} 份过期存档（保留最近 ${MAX_SAVE_FILES} 份）`, 60000);
}

// 启动时从 world/ 读取最近一份存档，恢复权威世界（差量方块 + 昼夜时钟）。
// 文件名含毫秒时间戳且定宽，按字典序即时间序，取最后一个即最新。
function loadLatestWorld() {
  let files;
  try {
    files = fs.readdirSync(WORLD_DIR).filter(f => /^world_\d{4}-\d{2}-\d{2}_.*\.json$/.test(f));
  } catch (e) { return; }
  if (files.length === 0) {
    console.log('   [存档] 未找到历史存档，从种子地形开始新世界');
    return;
  }
  files.sort();
  const latest = files[files.length - 1];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(WORLD_DIR, latest), 'utf8'));
    if (Array.isArray(data.tiles)) {
      for (const [k, v] of data.tiles) worldTiles.set(k, v);
    }
    if (typeof data.time === 'number') gameTime = data.time;
    if (typeof data.day === 'number') gameDay = data.day;
    console.log(`   [存档] 已恢复最近存档: ${latest}（${worldTiles.size} 处方块改动，day=${gameDay} time=${gameTime.toFixed(3)}）`);
  } catch (e) {
    console.error('   [存档] 读取最近存档失败，回退到种子地形:', e.message);
  }
}

// ==================== 数据备份 / 恢复（world/save + 上传 zip 恢复） ====================
function collectDataFiles() {
  const files = [];
  const saveResolved = path.resolve(SAVE_DIR);
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (path.resolve(full) === saveResolved) continue; walk(full); }
      else if (ent.isFile()) files.push({ name: path.relative(SERVER_ROOT, full).replace(/\\/g, '/'), data: fs.readFileSync(full) });
    }
  };
  for (const d of ['world', 'users', 'data']) walk(path.join(SERVER_ROOT, d));
  return files;
}
function saveWorldSync() {
  try { fs.writeFileSync(path.join(WORLD_DIR, `world_${fileTimestamp()}.json`), JSON.stringify(buildWorldPayload())); } catch (e) { console.error('[backup] 同步保存世界失败:', e.message); }
}
function createBackup() {
  saveWorldSync(); // 先把内存世界同步落盘，保证备份含最新改动
  if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });
  const files = collectDataFiles();
  const buf = createZip(files);
  const name = `backup_${fileTimestamp()}.zip`;
  fs.writeFileSync(path.join(SAVE_DIR, name), buf);
  return { name, size: buf.length, files: files.length };
}
function reloadDataFromDisk() {
  try { accounts = loadJson(ACCOUNT_FILE, {}); } catch (e) {}
  try { adminAccounts = loadJson(ADMIN_ACCOUNTS_FILE, adminAccounts); } catch (e) {}
  try { roles = loadJson(ROLES_FILE, {}); } catch (e) {}
  try { playerModes = loadJson(MODES_FILE, {}); } catch (e) {}
  try { banlist = loadJson(BANLIST_FILE, []); } catch (e) {}
  try { savedPlayers = loadJson(PLAYER_SAVE_FILE, {}); } catch (e) {}
  try { kicklist = loadJson(KICKLIST_FILE, {}); } catch (e) {}
  try { config = Object.assign({}, config, loadJson(CONFIG_FILE, config)); } catch (e) {}
  try { if (worldInteractions && worldInteractions.reload) worldInteractions.reload(); } catch (e) {} // 恢复备份后同步重载箱子数据，避免旧内存把恢复结果覆盖掉
  try {
    // 恢复后同步重载世界种子（让地形/掉落判定与备份一致）
    const sd = loadJson(WORLD_SEED_FILE, null);
    if (sd && Number.isFinite(sd.seed) && Math.floor(sd.seed) !== WORLD_SEED) {
      WORLD_SEED = Math.floor(sd.seed);
      dropIsSolid = createDropTerrain(WORLD_SEED, worldTiles, WORLD_W, WORLD_H);
      if (worldInteractions) worldInteractions.isSolid = (tx, ty) => dropIsSolid(tx, ty);
    }
    worldTiles.clear();
    if (typeof pendingSync !== 'undefined' && pendingSync.clear) pendingSync.clear();
    loadLatestWorld();
    broadcast({ type: 'worldstate', tiles: Array.from(worldTiles.entries()) });
  } catch (e) { console.error('[restore] 重载世界失败:', e.message); }
}
function applyRestore(buf) {
  const files = extractZip(buf);
  if (!files.length) throw new Error('备份为空');
  let restored = 0;
  for (const f of files) {
    const name = String(f.name).replace(/\\/g, '/');
    if (!/^(world|users|data)\//.test(name)) continue;      // 只恢复数据，防止覆盖代码/依赖
    if (/^world\/save\//.test(name)) continue;              // 备份 zip 本体不参与恢复
    const dest = path.join(SERVER_ROOT, name);
    if (!dest.startsWith(SERVER_ROOT + path.sep)) continue; // 防路径穿越
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
    restored++;
  }
  if (!restored) throw new Error('未找到可恢复的数据（需包含 world/ 或 users/ 或 data/）');
  reloadDataFromDisk();
  return restored;
}
function restoreUploadedZip(buf, res, opAuthed) {
  if (!opAuthed) { jsonRes(res, 403, { ok: false, error: 'unauthorized' }); return; }
  try {
    const n = applyRestore(buf);
    logAdmin('backup_restore', 'op', '', `上传恢复 ${n} 个文件`);
    jsonRes(res, 200, { ok: true, restored: n });
  } catch (e) { jsonRes(res, 400, { ok: false, error: 'restore_failed', message: e.message }); }
}

// ==================== 一键重置（新种子 + 清空世界/背包，保留账户昵称） ====================
function hardResetWorld() {
  const newSeed = Math.floor(Math.random() * 0x7fffffff);
  try { saveJson(WORLD_SEED_FILE, { seed: newSeed, createdAt: new Date().toISOString(), resetAt: Date.now() }); } catch (e) {}
  WORLD_SEED = newSeed;
  dropIsSolid = createDropTerrain(WORLD_SEED, worldTiles, WORLD_W, WORLD_H);
  if (worldInteractions) {
    try { worldInteractions.chests = {}; worldInteractions.leases.clear(); worldInteractions.drops.clear(); worldInteractions.save(); } catch (e) {}
    worldInteractions.isSolid = (tx, ty) => dropIsSolid(tx, ty); // 让掉落/箱子逻辑按新种子地形判断
  }
  worldTiles.clear();
  if (typeof pendingSync !== 'undefined' && pendingSync.clear) pendingSync.clear();
  // 清空世界滚动存档文件，避免重启后又加载回旧世界
  try { for (const f of fs.readdirSync(WORLD_DIR)) if (/^world_\d{4}-\d{2}-\d{2}_.*\.json$/.test(f)) fs.unlinkSync(path.join(WORLD_DIR, f)); } catch (e) {}
  // 清空玩家背包/进度存档（昵称保留在 accounts，不受影响）
  savedPlayers = {};
  try { savePlayers(); } catch (e) {}
  // 让在线玩家重连以获取新种子与空世界
  let kicked = 0;
  for (const p of [...players.values()]) { try { removePlayer(p.id, { type: 'kick', reason: '世界已重置（新种子），请重新进入' }, { skipSave: true }); kicked++; } catch (e) {} }
  try { broadcast({ type: 'worldstate', tiles: [] }); } catch (e) {}
  return { seed: newSeed, kicked };
}

// 优雅退出
function shutdown(signal) {
  console.log(`\n[world] 收到 ${signal}，退出前同步保存一份世界数据...`);
  try {
    const file = path.join(WORLD_DIR, `world_${fileTimestamp()}.json`);
    fs.writeFileSync(file, JSON.stringify(buildWorldPayload()));
  } catch (e) {
    console.error('[save] 退出前保存失败:', e.message);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// 兜底：避免单条消息/定时回调里的意外异常直接杀死整个服务器进程
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack ? e.stack : e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });

// 定时检查无操作玩家，超时则踢出
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of players) {
    if (now - p.lastActive > IDLE_TIMEOUT) {
      console.log(`[timeout] 踢出 id=${id} nickname=${p.nickname} (无操作${Math.round((now - p.lastActive) / 1000)}秒)`);
      if (p.ws) {
        try {
          p.ws.send(JSON.stringify({ type: 'kick', reason: '无操作超时，已被自动踢出' }));
          p.ws.close();
        } catch (e) {}
      }
      savedPlayers[p.nickname] = savePlayerData(p);
      savePlayers();
      players.delete(id);
      broadcast({ type: 'leave', id });
      broadcastOnlineCount();
      broadcastPlayerList();
    }
  }
}, 10000);

// 200ms 高频同步（动态地图 + 权威时钟）：
//   - 时间：广播服务端权威昼夜（t/day），所有客户端昼夜一致
//   - 地图：合并广播本窗口内的方块改动（增量，非全量）
setInterval(() => {
  // 权威时钟持续推进（即使无人在线），保证与周期性世界存档一致
  gameTime += 0.2 / 360;
  if (gameTime >= 1) { gameTime -= 1; gameDay++; }
  // 无论有无人都在此清空增量队列，避免无人在线时 pendingSync/worldTiles 无上限增长（OOM）
  const tiles = pendingSync.size > 0 ? Array.from(pendingSync.entries()) : null;
  pendingSync.clear();
  if (players.size === 0) return;
  // 时间与增量地图合并成一条消息发送（省一次消息往返）
  broadcast({ type: 'sync', t: gameTime, day: gameDay, tiles });
}, 200);

// 每 100ms 将权威世界（差量方块 + 昼夜时钟）按系统时间命名保存到 world/ 文件夹
setInterval(saveWorld, SAVE_INTERVAL_MS);

// 60 秒全量兜底：确保断线重连或网络丢包后客户端能纠正方块不一致（仅在有改动时发送）
setInterval(() => {
  if (worldTiles.size === 0 || players.size === 0) return;
  const payload = { type: 'worldstate', tiles: Array.from(worldTiles.entries()) };
  broadcast(payload);
  console.log(`[sync] 广播 worldstate（${worldTiles.size} 处方块改动）`);
}, 60000);

// 玩家自动保存
setInterval(() => { try { savePlayers(); } catch(e){} }, PLAYER_AUTO_SAVE);
