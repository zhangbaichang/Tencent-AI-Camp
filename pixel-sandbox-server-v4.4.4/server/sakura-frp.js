/**
 * SakuraFrp 公网地址自动发现（Windows 优先）
 *
 * SakuraFrp 启动成功后会在服务日志中输出类似：
 *   Your XXX proxy is available now. Use >>http://host:port<< to connect.
 *   XXX 隧道启动成功 使用 >>http://host:port<< 连接你的隧道
 *
 * 本模块只读取本机 SakuraFrp 日志，不上传任何数据，也不需要 SakuraFrp token。
 * Windows 默认日志目录：%PROGRAMDATA%\SakuraFrpService\Logs
 * 可用环境变量 SAKURA_LOG_DIR 覆盖。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'public-address.json');
const DEFAULT_LOG_DIR = process.env.PROGRAMDATA
  ? path.join(process.env.PROGRAMDATA, 'SakuraFrpService', 'Logs')
  : '';
const LOG_DIR = process.env.SAKURA_LOG_DIR || DEFAULT_LOG_DIR;
let lastInfo = null;
let watcherStarted = false;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function normalizeAddress(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[\[\]<>`"']/g, '');
  s = s.replace(/[。；;，,]+$/g, '');
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z0-9.-]+:\d{2,6}$/i.test(s)) return 'http://' + s;
  return null;
}

function toWsUrl(url) {
  if (!url) return null;
  return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
}

function extractAddresses(content) {
  const found = [];
  const patterns = [
    /Use\s*>>\s*(https?:\/\/[^\s<>]+)\s*<</gi,
    /使用\s*>>\s*(https?:\/\/[^\s<>]+)\s*<</gi,
    /Use\s*>>\s*([a-z0-9.-]+:\d{2,6})\s*<</gi,
    /使用\s*>>\s*([a-z0-9.-]+:\d{2,6})\s*<</gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(content))) {
      const u = normalizeAddress(m[1]);
      if (u && !found.includes(u)) found.push(u);
    }
  }
  return found;
}

function listLogFiles() {
  if (!LOG_DIR) return [];
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => /\.log$/i.test(f))
      .map(f => {
        const p = path.join(LOG_DIR, f);
        let st; try { st = fs.statSync(p); } catch (_) { return null; }
        return { path:p, mtime: st.mtimeMs || 0 };
      })
      .filter(Boolean)
      .sort((a,b) => b.mtime - a.mtime)
      .slice(0, 8);
  } catch (_) { return []; }
}

function scanLogs() {
  for (const file of listLogFiles()) {
    let content;
    try {
      const buf = fs.readFileSync(file.path);
      content = buf.toString('utf8');
    } catch (_) { continue; }
    const addresses = extractAddresses(content);
    if (!addresses.length) continue;
    const url = addresses[addresses.length - 1];
    const info = {
      ok: true,
      url,
      wsUrl: toWsUrl(url),
      source: 'SakuraFrp log',
      logFile: file.path,
      logMtime: new Date(file.mtime).toISOString(),
      detectedAt: new Date().toISOString(),
      logDir: LOG_DIR || null,
    };
    lastInfo = info;
    ensureDataDir();
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(info, null, 2)); } catch (_) {}
    return info;
  }
  return null;
}

function getPublicAddressInfo() {
  if (lastInfo && lastInfo.url) return lastInfo;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && saved.url) { lastInfo = saved; return saved; }
  } catch (_) {}
  const found = scanLogs();
  if (found) return found;
  return {
    ok: false,
    url: null,
    wsUrl: null,
    source: 'SakuraFrp log',
    logDir: LOG_DIR || null,
    message: LOG_DIR
      ? '尚未检测到 SakuraFrp 隧道启动成功日志，请先启动游戏隧道。'
      : '未找到 SakuraFrp 默认日志目录；可设置 SAKURA_LOG_DIR。'
  };
}

function startSakuraFrpWatcher(onChange) {
  if (watcherStarted) return;
  watcherStarted = true;
  let previous = null;
  const tick = () => {
    const info = scanLogs();
    if (info && info.url && info.url !== previous) {
      previous = info.url;
      try { onChange && onChange(info); } catch (_) {}
    }
  };
  tick();
  setInterval(tick, 5000);
}

module.exports = { startSakuraFrpWatcher, getPublicAddressInfo };
