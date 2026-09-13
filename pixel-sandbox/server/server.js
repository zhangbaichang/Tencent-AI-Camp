/**
 * 像素沙盒 · 服务器版（服务端权威世界 + 差量存档）
 *
 * 启动：
 *   cd D:/游戏/service
 *   npm install        （已随附 node_modules/ws，可跳过）
 *   node server.js
 * 访问：http://<本机IP>:8080   （静态页面与 WebSocket 同端口）
 *
 * 设计要点（先结论）：
 *   1. 静态托管 index.html / css / js —— 一个 node 进程即可跑完整联机版。
 *   2. WebSocket 联机中继（保留原转发逻辑），HTTP 轮询作为微信小程序兜底。
 *   3. 服务端权威（server-authoritative）：服务端持有"世界差量" Map，
 *      只记录玩家挖/放产生的改动，叠加在各客户端用 WORLD_SEED 本地生成的
 *      自然地形之上。服务端按 SAVE_INTERVAL_MS（默认 5 秒）将权威世界（差量方块 + 昼夜时钟）
 *      按系统时间命名落盘到 world/ 文件夹，并自动保留最近 MAX_SAVE_FILES 份、清理过期存档。
 *   4. 新加入者通过 welcome（WS）或 /api/join（HTTP）拿到 worldstate 差量，
 *      客户端应用到本地生成的世界，保证同一会话内所有人看到同一份"已建设"的世界。
 *
 * 运行环境：Node.js 16+（不依赖任何 Node 18+ 专属 API，老内核服务器可直接运行）。
 *
 * 注意：WORLD_W / WORLD_H 必须与 js/data.js 保持一致；服务端不引入前端模块，
 *       用常量同步以避免耦合（这是有 rationale 的显式约定，非 magic number）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const WORLD_SEED = 7777;
// 与 js/data.js 的 WORLD_W / WORLD_H 同步（服务端权威世界差量的 key 计算依赖此值）
const WORLD_W = 600;
const WORLD_H = 300;
const IDLE_TIMEOUT = 60000;
const ROOT = path.join(__dirname, '..'); // 静态根 = 项目根（index.html/css/js 在 server/ 上一级）
const WORLD_DIR = path.join(__dirname, 'world'); // 世界存档目录（服务初始化时创建）
const SAVE_INTERVAL_MS = 5000;   // 世界数据落盘间隔（毫秒，可调；默认 5 秒一份）
const MAX_SAVE_FILES = 20;       // world/ 中最多保留的存档份数，超出自动删除最旧的

// 按系统时间生成文件名片段：YYYY-MM-DD_HH-MM-SS-mmm（精确到毫秒，保证每次保存文件名唯一）
function fileTimestamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

// ==================== 服务端权威世界（差量覆盖） ====================
// key = ty * WORLD_W + tx  ->  tileId
// tileId 可以是 0（被挖空），用于覆盖种子地形上的原生方块
const worldTiles = new Map();

// 世界数据每 100ms 落盘到 world/（见文件底部 setInterval）。worldTiles 为会话内权威状态，
// 落盘后即便服务端重启也可读取最近一份存档恢复（本版仅负责写，恢复逻辑可按需扩展）。

// 服务端权威时钟：所有客户端昼夜统一以此时钟为准（200ms 广播校正）
let gameTime = 0.15; // 0~1 一天（与客户端 game.time 同构）
let gameDay = 0;     // 天数

// 200ms 增量同步队列：只广播"本窗口内"的方块改动（动态地图），避免全量广播的带宽爆炸
const pendingSync = new Map(); // key -> tileId

// 记录一次方块改动到权威世界（含边界与类型校验）
function recordBlock(tx, ty, tileId) {
  if (!Number.isInteger(tx) || !Number.isInteger(ty) || !Number.isInteger(tileId)) return;
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;
  const key = ty * WORLD_W + tx;
  worldTiles.set(key, tileId);
  pendingSync.set(key, tileId); // 同时记入增量队列，供 200ms 定时同步
}

function worldStatePayload() {
  return { tiles: Array.from(worldTiles.entries()) };
}

// ==================== 玩家与会话 ====================
const players = new Map(); // id -> { ws, nickname, x, y, vx, vy, facing, walkPhase, health, lastActive, messages: [] }
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

function getPlayerList(excludeId) {
  const list = [];
  for (const [id, p] of players) {
    if (id !== excludeId) {
      list.push({
        id, nickname: p.nickname,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        facing: p.facing, walkPhase: p.walkPhase, health: p.health,
      });
    }
  }
  return list;
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

  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
      handleHttpApi(urlPath, data, res);
    });
    return;
  }

  // GET /api/* → 交给 HTTP API 处理（如 /api/players 用 GET 轮询在线玩家）
  if (urlPath.startsWith('/api/')) {
    handleHttpApi(urlPath, {}, res);
    return;
  }

  // GET → 静态文件托管
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 缓存策略：HTML 不缓存（保证每次刷新拿到最新页面）；JS/CSS/图片短缓存（5 分钟）
    // 避免"改了代码刷新还是旧版"的经典问题，同时减少重复请求
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

function handleHttpApi(url, data, res) {
  switch (url) {
    case '/api/join': {
      const nickname = String(data.nickname || '玩家').trim().slice(0, 16);
      const id = nextId++;
      players.set(id, {
        ws: null, nickname,
        x: 0, y: 0, vx: 0, vy: 0, facing: 1, walkPhase: 0, health: 100,
        lastActive: Date.now(), messages: [],
      });
      // 加入即同步时间：把当前权威昼夜时钟以 force 形式塞进消息队列，
      // 客户端 poll 时会随 welcome 一并拿到并立即对齐（与 WS 模式一致）。
      players.get(id).messages.push({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
      broadcast({ type: 'join', id, nickname }, id);
      console.log(`[HTTP join] id=${id} nickname=${nickname} (${players.size} online)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, seed: WORLD_SEED,
        players: getPlayerList(id),
        worldstate: worldStatePayload(), // 下发服务端权威世界差量
      }));
      break;
    }
    case '/api/players': {
      // 登录界面轮询用：返回当前已在游戏中的全部在线玩家（不含尚在登录界面、尚未 join 的访客）
      const list = getPlayerList(); // 不传 excludeId → 返回所有在线者
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: list.length,
        players: list.map(p => ({ id: p.id, nickname: p.nickname })),
      }));
      break;
    }
    case '/api/move': {
      const p = players.get(data.id);
      if (!p) { res.writeHead(404); res.end('Not found'); return; }
      p.x = data.x; p.y = data.y;
      p.vx = data.vx; p.vy = data.vy;
      p.facing = data.facing; p.walkPhase = data.walkPhase;
      p.health = data.health;
      p.lastActive = Date.now();
      broadcast({ type: 'move', id: data.id, ...data }, data.id);
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/block': {
      const p = players.get(data.id);
      if (p) p.lastActive = Date.now();
      recordBlock(data.tx, data.ty, data.tileId); // 记入权威世界
      broadcast({ type: 'block', id: data.id, tx: data.tx, ty: data.ty, tileId: data.tileId }, data.id);
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
      // 床跳过黑夜（HTTP 轮询模式）：把服务端权威昼夜时钟跳到早晨并立即广播
      gameTime = 0;
      broadcast({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
      res.writeHead(200); res.end('OK');
      break;
    }
    case '/api/poll': {
      const p = players.get(data.id);
      if (!p) { res.writeHead(404); res.end('Not found'); return; }
      p.lastActive = Date.now();
      const messages = p.messages || [];
      p.messages = [];
      const playerList = getPlayerList(data.id);
      playerList.unshift({
        id: data.id, nickname: p.nickname,
        x: p.x, y: p.y, vx: p.vx, vy: p.vy,
        facing: p.facing, walkPhase: p.walkPhase, health: p.health,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages, players: playerList }));
      break;
    }
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

    const p = players.get(id);
    if (p) p.lastActive = Date.now();

    switch (msg.type) {
      case 'join': {
        const nickname = String(msg.nickname || '玩家').trim().slice(0, 16);
        players.set(id, {
          ws, nickname,
          x: 0, y: 0, vx: 0, vy: 0, facing: 1, walkPhase: 0, health: 100,
          lastActive: Date.now(), messages: [],
        });

        const playerList = [];
        for (const [pid, p] of players) {
          if (pid !== id) {
            playerList.push({
              id: pid, nickname: p.nickname,
              x: p.x, y: p.y, vx: p.vx, vy: p.vy,
              facing: p.facing, walkPhase: p.walkPhase, health: p.health,
            });
          }
        }
        // 欢迎消息携带服务端权威世界差量
        sendTo(id, { type: 'welcome', id, seed: WORLD_SEED, players: playerList, worldstate: worldStatePayload() });
        // 加入即同步时间：立即推一条 force 同步，客户端收到瞬间对齐昼夜（无需等 200ms 广播收敛）
        sendTo(id, { type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });

        broadcast({ type: 'join', id, nickname }, id);
        console.log(`[join] id=${id} nickname=${nickname} (${players.size} online)`);
        break;
      }
      case 'move': {
        const p = players.get(id);
        if (!p) return;
        p.x = msg.x; p.y = msg.y;
        p.vx = msg.vx; p.vy = msg.vy;
        p.facing = msg.facing; p.walkPhase = msg.walkPhase;
        p.health = msg.health;
        p.lastActive = Date.now();
        broadcast({ type: 'move', id, ...msg }, id);
        break;
      }
      case 'block': {
        const p = players.get(id);
        if (p) p.lastActive = Date.now();
        recordBlock(msg.tx, msg.ty, msg.tileId); // 记入权威世界
        broadcast({ type: 'block', id, tx: msg.tx, ty: msg.ty, tileId: msg.tileId }, id);
        break;
      }
      case 'flash': {
        // 闪光弹事件转发：其他客户端按距离自行判定是否被闪
        const p = players.get(id);
        if (p) p.lastActive = Date.now();
        broadcast({ type: 'flash', id, x: msg.x, y: msg.y }, id);
        break;
      }
      case 'sleep': {
        // 床跳过黑夜：把服务端权威昼夜时钟直接跳到早晨，并立即广播（force=true 让所有客户端瞬间对齐）
        gameTime = 0;
        broadcast({ type: 'sync', t: gameTime, day: gameDay, tiles: null, force: true });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (players.has(id)) {
      const p = players.get(id);
      players.delete(id);
      broadcast({ type: 'leave', id });
      console.log(`[leave] id=${id} nickname=${p.nickname} (${players.size} online)`);
    }
  });

  ws.on('error', () => {
    if (players.has(id)) {
      players.delete(id);
      broadcast({ type: 'leave', id });
    }
  });
});

// ==================== 启动 / 退出 ====================
server.listen(PORT, () => {
  // 初始化：新建 world 存档目录（已存在则忽略），并恢复最近一份存档
  if (!fs.existsSync(WORLD_DIR)) fs.mkdirSync(WORLD_DIR, { recursive: true });
  loadLatestWorld();
  console.log(`✅ 像素沙盒 · 服务器版已启动，端口 ${PORT}`);
  console.log(`   世界种子: ${WORLD_SEED}（WORLD_W=${WORLD_W} WORLD_H=${WORLD_H}，须与 js/data.js 一致）`);
  console.log(`   存档目录: ${WORLD_DIR}（每 ${SAVE_INTERVAL_MS}ms 按系统时间命名落盘一份世界数据）`);
  console.log(`   静态托管: index.html / css / js`);
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
  if (removed > 0) console.log(`[save] 已自动清理 ${removed} 份过期存档（保留最近 ${MAX_SAVE_FILES} 份）`);
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
      players.delete(id);
      broadcast({ type: 'leave', id });
    }
  }
}, 10000);

// 200ms 高频同步（动态地图 + 权威时钟）：
//   - 时间：广播服务端权威昼夜（t/day），所有客户端昼夜一致
//   - 地图：合并广播本窗口内的方块改动（增量，非全量）
setInterval(() => {
  if (players.size === 0) return;
  // 权威时钟推进：200ms / dayLength(360s) = 0.2/360
  gameTime += 0.2 / 360;
  if (gameTime >= 1) { gameTime -= 1; gameDay++; }
  // 时间与增量地图合并成一条消息发送（省一次消息往返）
  const tiles = pendingSync.size > 0 ? Array.from(pendingSync.entries()) : null;
  pendingSync.clear();
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
