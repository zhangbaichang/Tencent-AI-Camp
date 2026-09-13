/**
 * 像素沙盒 - 主游戏引擎
 * 玩家物理 / 渲染 / 挖掘建造 / 合成 / 敌人 / 昼夜 / UI
 */
(function() {
'use strict';

const { TILE, WORLD_W, WORLD_H, GRAVITY, MAX_FALL, PLAYER_SPEED, JUMP_FORCE, REACH, JUMP_CUT, FALL_GRAVITY_MULT, APEX_GRAVITY_MULT, APEX_VY, COYOTE, JUMP_BUFFER } = window.GAME_CONST;
const BLOCKS = window.BLOCKS;
const RECIPES = window.RECIPES;
const WorldGen = window.WorldGen;
const getBlockShade = window.getBlockShade;
const BLOCK_ELEMENTS = window.BLOCK_ELEMENTS;
const ELEMENT_INFO = window.ELEMENT_INFO;
const ELEMENT_REACTIONS = window.ELEMENT_REACTIONS;
const PERIODIC_TABLE = window.PERIODIC_TABLE;
const ORE_ELEMENT_MAP = window.ORE_ELEMENT_MAP;

// 世界种子：固定值，保证每次进入世界一致（联机时与服务端相同，所有玩家世界一致）
const WORLD_SEED = 7777;
const CHEST_SLOTS = 27; // 每个箱子的物品栏格子数（仿工作台 27 格，点一下整组搬移）

// ==================== 游戏状态 ====================
const game = {
  canvas: null, ctx: null,
  lightCanvas: null, lightCtx: null,
  world: null, surface: null,
  camX: 0, camY: 0,
  cw: 0, ch: 0,
  keys: {},
  mouse: { x: 0, y: 0, worldX: 0, worldY: 0, left: false, right: false },
  player: null,
  enemies: [],
  particles: [],
  droppedItems: [],
  bucketFluid: new Set(),   // 桶倒出的流体格索引：不参与 stepFluid 扩散，保持静止满格，可随时舀回（杜绝水/岩浆通胀）
  spawnPoint: null,         // 床重生点 {tx, ty}；null=未设置，死亡回退默认出生列（联机下为各客户端本地状态，不跨玩家同步）
  inventory: {},
  hotbar: [0,0,0,0,0,0,0,0,0,0], // 方块ID
  hotbarCounts: [0,0,0,0,0,0,0,0,0,0],
  selectedSlot: 0,
  hoveredSlot: -1,
  time: 0.15, // 0~1 一天
  dayLength: 360, // 秒（原120，放慢约3倍，昼夜节奏更舒缓）
  day: 0,                     // 游戏天数（time 每走满 1 天 +1），驱动树苗生长计时
  saplings: new Map(),        // key=ty*WORLD_W+tx → 种植时的连续天数(day+time)；满 SAPLING_GROW_DAYS 后长成树
  grassFrontier: new Set(),   // 草蔓延前沿：与草相邻、可被草化的泥土格 key 集合
  _grassAccum: 0,             // 草蔓延计时累加（ms）
  _plantAccum: 0,             // 树苗生长检测计时累加（ms）
  mining: { target: null, progress: 0, x:0, y:0 },
  craftingOpen: false,
  craftingDirty: true,
  craftingMode: 'hand', // 'hand' | 'workbench' | 'furnace'
  chestOpen: false,
  chestIdx: -1,          // 当前打开箱子的世界格索引（ty*WORLD_W+tx）；-1 表示无
  chests: {},            // idx -> Array(CHEST_SLOTS)，每格 {id,count}|null
  chestDirty: true,
  _chestWarn: 0,         // 挖非空箱子的提示节流计时
  inventoryOpen: false,
  inventoryDirty: true,
  cursorId: 0,           // Java 版“鼠标拿起”的光标物品 id（0=手中没拿东西）
  cursorCount: 0,        // 光标物品数量
  _cursorDropTs: 0,      // 最近一次把物品放回背包的时间戳（避免放回时误关面板）
  _dragPress: null,      // 拖拽交互中间态（bindCursorDrag 内部使用）
  paused: false,
  fps: 0,
  showMap: false,
  // 卡牌对战
  battleTarget: null,
  battleCards: [],       // 已选热栏槽位索引（最多3个）
  battleOpen: false,
  battleCooldown: 0,
  battleAnimating: false, // 攻击动画进行中
  discoveredElements: new Set(), // 已发现的化学元素符号
  elementPopupActive: false, // 周期表弹窗是否显示
  regenAccum: 0, // 血量回复累积
  flashAlpha: 0, // 全屏白闪强度 0~1（闪光弹触发，随时间衰减）
  // 手机触屏输入
  touchInput: {
    moveX: 0,       // 摇杆水平: -1/0/1
    moveY: 0,       // 摇杆垂直: -1/0/1（用于 8 向瞄准）
    jump: false,    // 跳跃按钮
    mine: false,    // 挖掘按钮(持续)
    place: false,   // 放置按钮(单次)
    drop: false,    // 甩落/丢弃按钮(单次)
    tap: false,     // 画布点击(单次,用于敌人交互)
    isTouch: false, // 是否触屏设备
    aimX: 0,        // 玩家在画布上点选的世界坐标 X（用于自主选择挖掘/放置目标）
    aimY: 0,        // 玩家在画布上点选的世界坐标 Y
    aimActive: false, // 是否已点选目标方块（true 时优先用点选块，false 时回退摇杆自动瞄准）
  },
  // UI 安全区（刘海/状态栏偏移量，单位 px）
  safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
  // 联机
  nickname: null,
  multiplayer: {
    ws: null,
    myId: null,
    connected: false,
    players: new Map(),
    sendAccum: 0,
    reconnectDelay: 0,
  },
};

// ==================== 初始化 ====================
function init() {
  if (game._initialized) return;
  game._initialized = true;
  game.canvas = document.getElementById('game-canvas');
  game.ctx = game.canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // 检测是否应启用手机触屏 UI：综合 UA + 指针精度 + 屏幕尺寸，避免带触控屏的 Windows/Mac 电脑被误判为手机
  const ua = navigator.userAgent;
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const isFinePointer = window.matchMedia('(pointer: fine)').matches;
  const isDesktopUA = /Windows NT|Windows Phone|Macintosh|Linux x86_64|CrOS/i.test(ua) && !/Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
  const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|Mobile|Tablet|Touch/i.test(ua);
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 1024;
  // 规则：桌面 UA 且只有 fine pointer → 强制桌面； coarse pointer 且小屏/移动端 UA → 手机
  game.touchInput.isTouch = (!isDesktopUA && isCoarsePointer && smallScreen) || (isMobileUA && (!isFinePointer || smallScreen));
  if (game.touchInput.isTouch) {
    document.body.classList.add('touch-device');
    // 手机版：把独立静音键移入顶部状态栏，整合零散 HUD，避免遮挡画面
    const _mute = document.getElementById('btn-mute');
    const _topbar = document.getElementById('mobile-topbar');
    if (_mute && _topbar) {
      _mute.classList.remove('hud-btn');
      _mute.classList.add('mobile-top-btn');
      _topbar.appendChild(_mute);
    }
  }

  // 事件（不依赖世界，可先绑定）
  bindEvents();
  // 手机控件
  bindMobileControls();

  // 连接联机服务器（不依赖世界，可先连）
  connectMultiplayer();

  // 异步生成世界（Web Worker 生成，主线程不卡），完成后再启动循环并隐藏加载画面
  setupWorld(WORLD_SEED).then(() => {
    startLoop();
    showToast('欢迎来到像素沙盒世界！', 2000);
  }).catch((err) => {
    console.error('[world] 生成失败', err);
    showToast('世界生成失败：' + (err && err.message ? err.message : err), 4000);
    startLoop();
  });
}

// 启动游戏主循环（在世界就绪后调用）
function startLoop() {
  // 隐藏加载画面
  const ls = document.getElementById('loading-screen');
  if (ls) ls.classList.add('hide');

  let lastTime = performance.now();
  let frameCount = 0, fpsTime = 0;
  function loop(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    frameCount++;
    fpsTime += dt;
    if (fpsTime > 500) { game.fps = Math.round(frameCount * 1000 / fpsTime); frameCount = 0; fpsTime = 0; }
    // 安全网：任何一次更新/渲染异常都只跳过本帧，绝不让游戏彻底卡死（死机）
    try {
      if (!game.paused) update(dt);
      render();
    } catch (err) {
      if (!game._loopErrShown) {
        game._loopErrShown = true;
        console.error('[loop error]', err);
        showToast('运行异常：' + (err && err.message ? err.message : err), 3000);
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// 异步生成世界：优先用 Web Worker（不卡主线程）；file:// 直接打开或浏览器不支持时退回同步生成
function generateWorldAsync(W, H, seed) {
  return new Promise((resolve) => {
    try {
      const worker = new Worker('js/world-worker.js');
      worker.onmessage = (e) => { worker.terminate(); resolve(e.data); };
      worker.onerror = (err) => {
        console.warn('[world] Worker 生成失败，退回同步生成', err);
        try { worker.terminate(); } catch (_) {}
        resolve(globalThis.WorldGen.generateWorld(W, H, seed));
      };
      worker.postMessage({ W, H, seed });
    } catch (e) {
      console.warn('[world] 无法创建 Worker（可能以 file:// 打开），同步生成', e);
      resolve(globalThis.WorldGen.generateWorld(W, H, seed));
    }
  });
}

// 根据种子生成世界 + 玩家（init 与联机收到服务端种子时都会调用）
async function setupWorld(seed) {
  game.worldSeed = seed;
  console.log('[world] 种子 =', seed, '（尺寸', WORLD_W, 'x', WORLD_H, '）');
  const w = await generateWorldAsync(WORLD_W, WORLD_H, seed);
  game.world = w.world;
  game.surface = w.surfaceHeight;

  // 初始化水体分级数组（每格水位 0~4，初始水块为满级），供流体模拟使用
  game.waterLevels = new Uint8Array(WORLD_W * WORLD_H);
  for (let i = 0; i < game.world.length; i++) {
    if (game.world[i] === 12) game.waterLevels[i] = 4;
  }

  // 初始化岩浆分级数组（每格岩浆量 0~4，初始岩浆块为满级），与水体同步做流体模拟
  game.lavaLevels = new Uint8Array(WORLD_W * WORLD_H);
  for (let i = 0; i < game.world.length; i++) {
    if (game.world[i] === 63) game.lavaLevels[i] = 4;
  }

  // 流体活跃集（只追踪含水的格，避免每拍遍历整张世界）
  rebuildFluidActive();

  // 光源集合缓存：所有带 light 属性的方块索引（火把/灯笼/熔炉等），供光照层每帧快速过滤视口
  // 替代 drawLighting 每帧全视口 1800 格 getTile 扫描（光照层最大热点之一）
  game.lightSet = new Set();
  for (let i = 0; i < game.world.length; i++) {
    const lb = BLOCKS[game.world[i]];
    if (lb && lb.light) game.lightSet.add(i);
  }

  // 服务端权威世界差量：若欢迎消息先于世界就绪到达，在此补齐应用
  if (game.pendingWorldState) { applyWorldState(game.pendingWorldState); game.pendingWorldState = null; }

  // 植物生长系统初始化（新世界从第 0 天开始，无已种树苗，草前沿由地形重建）
  game.day = 0;
  game.saplings = new Map();
  rebuildGrassFrontier();

  // 门开关状态集合：存“开启”的门格索引（整扇门=上下两格都存）。开着的门可穿过、视觉上敞开
  game.openDoors = new Set();

  // 创建玩家（在地表中央，且避开水面/岩浆）
  const spawnTx0 = findSafeSpawnColumn();
  const spawnX = spawnTx0 * TILE;
  const spawnY = (game.surface[spawnTx0] - 2) * TILE;
  game.player = {
    x: spawnX, y: spawnY - 36,
    vx: 0, vy: 0,
    w: 18, h: 36,
    isPlayer: true,
    onGround: false,
    coyote: 0, jumpBuffer: 0,
    health: 100, maxHealth: 100,
    oxygen: OXYGEN_MAX, maxOxygen: OXYGEN_MAX,
    headInWater: false,
    invuln: 0,
    lastDamageTime: 0,
    facing: 1,
    mining: false,
    walkPhase: 0,
  };

  // 给玩家一些初始物品
  game.inventory[4] = 10; // 10木头
  game.inventory[15] = 5; // 5火把
  game.inventory[13] = 20; // 20木板
  updateHotbar();
  game.hotbar[0] = 15; game.hotbarCounts[0] = 5;
  game.hotbar[1] = 4;  game.hotbarCounts[1] = 10;
  game.hotbar[2] = 13; game.hotbarCounts[2] = 20;
}


function resizeCanvas() {
  game.cw = game.canvas.width = game.canvas.clientWidth;
  game.ch = game.canvas.height = game.canvas.clientHeight;
  // 读取 CSS 安全区变量（px），供 canvas 内 UI 避开刘海/系统栏
  const root = getComputedStyle(document.documentElement);
  game.safeArea.top = parseInt(root.getPropertyValue('--sa-top')) || 0;
  game.safeArea.right = parseInt(root.getPropertyValue('--sa-right')) || 0;
  game.safeArea.bottom = parseInt(root.getPropertyValue('--sa-bottom')) || 0;
  game.safeArea.left = parseInt(root.getPropertyValue('--sa-left')) || 0;
}

// 方块图标 emoji
const BLOCK_EMOJI = {
  0:'', 1:'🌿', 2:'🟤', 3:'🪨', 4:'🪵', 5:'🍃', 6:'🏖️', 7:'⚫', 8:'🟠',
  9:'⚙️', 10:'🟡', 11:'💎', 12:'💧', 13:'🟧', 14:'🧱', 15:'🔥', 16:'🪟',
  17:'🔨', 18:'🏺', 19:'🟫', 20:'⬜', 21:'🟨', 22:'🟥', 23:'❄️', 24:'🧊', 25:'⬛',
  26:'🚪', 27:'📦', 28:'🚧', 29:'🔩', 30:'🟮', 31:'🔷', 32:'🏮', 33:'📚', 34:'⛓️', 35:'🔵',
  36:'⚪', 37:'🔮', 38:'🟩', 39:'🟦', 40:'🟡', 41:'💎',
  42:'⬜', 43:'💠', 44:'🟢', 45:'🔷', 46:'🧊',
  47:'🟠', 48:'🔇', 49:'🟨', 50:'🔍', 51:'🔌', 52:'💣', 53:'🧪', 54:'🔷', 55:'🔋',
  56:'⛏️', 57:'⛏️', 58:'⛏️',
  65:'⚪', 66:'🔘', 67:'🪙', 68:'🪙', 69:'🔷', 70:'✨',
  71:'🪞', 72:'⬜', 73:'🪞', 74:'⬜', 75:'✨', 76:'🟨', 77:'🔩', 78:'💥',
  79:'🗡️', 80:'🗡️', 81:'🗡️',
};

// ==================== 世界操作 ====================
function getTile(tx, ty) {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return 0;
  return game.world[ty * WORLD_W + tx];
}

function setTile(tx, ty, id) {
  if (tx < 0 || tx >= WORLD_W || ty < 0 || ty >= WORLD_H) return;
  const idx = ty * WORLD_W + tx;
  const old = game.world[idx];
  if (old === id) return; // 无变化不触发重绘标记
  // 光源集合维护：方块变化时同步增删（火把/灯笼/熔炉等带 light 的方块）
  if (game.lightSet) {
    const ob = BLOCKS[old];
    if (ob && ob.light) game.lightSet.delete(idx);
    const nb = BLOCKS[id];
    if (nb && nb.light) game.lightSet.add(idx);
  }
  // 同步水体活跃集 + 分级：移除水时清零并移出活跃集，放置水时设为满级并加入活跃集
  if (old === 12 && id !== 12) { game.waterLevels[idx] = 0; if (game._waterActive) game._waterActive.delete(idx); }
  if (id === 12) { game.waterLevels[idx] = 4; if (game._waterActive) game._waterActive.add(idx); }
  // 同步岩浆活跃集 + 分级（与水体同步）
  if (old === 63 && id !== 63) { game.lavaLevels[idx] = 0; if (game._lavaActive) game._lavaActive.delete(idx); }
  if (id === 63) { game.lavaLevels[idx] = 4; if (game._lavaActive) game._lavaActive.add(idx); }
  // 非流体方块覆盖桶水时，清除桶隔离标记（避免残留导致守恒失衡）
  if (id !== 12 && id !== 63) game.bucketFluid.delete(idx);
  game.world[idx] = id;
  // 床被破坏（被挖/炸/覆盖，原是59而新值不是59）→ 重生点失效。
  // 写在 setTile 内可覆盖所有破坏途径（左键挖、爆炸炸空、方块覆盖），且联机同步应用 block 时也会在本端触发。
  if (old === 59 && id !== 59 && game.spawnPoint && game.spawnPoint.tx === tx && game.spawnPoint.ty === ty) {
    game.spawnPoint = null;
    showToast('床被破坏了，重生点已失效', 1500);
  }
  // 瓦片缓存脏格标记：该格变化后需要重绘到离屏缓存（帧率优化，见 drawTiles）
  if (game.tileCache && game.tileCache.dirty) game.tileCache.dirty.add(idx);
}

function isSolid(tx, ty) {
  const id = getTile(tx, ty);
  // 开着的门：可穿过（不视为实心）
  if (id === 26 && game.openDoors && game.openDoors.has(ty * WORLD_W + tx)) return false;
  return BLOCKS[id] && BLOCKS[id].solid;
}

function getTileLight(tx, ty) {
  const id = getTile(tx, ty);
  return BLOCKS[id] ? BLOCKS[id].light : 0;
}

// 检查以 (ctx, cty) 为中心、半径 rTiles 的方块区域内是否有发光方块（火把/灯笼/熔炉等）
// 用于判定某处是否"被照亮"——地下若无光源即视为黑暗，可生成怪物
function hasNearbyLight(ctx, cty, rTiles) {
  for (let dy = -rTiles; dy <= rTiles; dy++) {
    for (let dx = -rTiles; dx <= rTiles; dx++) {
      const id = getTile(ctx + dx, cty + dy);
      const b = BLOCKS[id];
      if (b && b.light && b.light > 0) return true;
    }
  }
  return false;
}

// 切换整扇门（占 2 格）的开关状态：开/关同时作用于上下两半
function toggleDoor(tx, ty) {
  if (getTile(tx, ty) !== 26) return;
  // 收集整扇门的两格索引
  const idxs = [ty * WORLD_W + tx];
  if (getTile(tx, ty - 1) === 26) idxs.push((ty - 1) * WORLD_W + tx);
  if (getTile(tx, ty + 1) === 26) idxs.push((ty + 1) * WORLD_W + tx);
  const nowOpen = !game.openDoors.has(idxs[0]);
  if (!nowOpen) {
    // 关门保护：门变实心前，先检查玩家/怪物是否正占据门口任一格。
    // 否则下一帧 collideAxis 的 vy>0 分支会把实体顶到门上半格的正上方（空白格），出现“被弹飞”。
    const ents = [game.player, ...(game.enemies || [])];
    for (const e of ents) {
      if (!e) continue;
      const ew = e.w || 18, eh = e.h || 36;
      const ex0 = e.x, ey0 = e.y, ex1 = e.x + ew, ey1 = e.y + eh;
      for (const i of idxs) {
        const cx = i % WORLD_W, cy = (i / WORLD_W) | 0;
        const tx0 = cx * TILE, ty0 = cy * TILE, tx1 = tx0 + TILE, ty1 = ty0 + TILE;
        if (ex1 > tx0 && ex0 < tx1 && ey1 > ty0 && ey0 < ty1) {
          showToast('门口被占用，门无法关闭', 1100);
          sfx('deny');
          return; // 阻止关门，保留开门状态
        }
      }
    }
  }
  for (const i of idxs) {
    if (nowOpen) game.openDoors.add(i);
    else game.openDoors.delete(i);
  }
  // 标记门所在瓦片为脏：开门/关门只改 openDoors 集合、不动方块，
  // 瓦片缓存层(drawTiles)不会自动刷新，会导致「能通过但画面仍显示关闭」的视觉错位。
  if (game.tileCache && game.tileCache.dirty) {
    for (const i of idxs) game.tileCache.dirty.add(i);
  }
  sfx('click', { pan: audioPan(tx * TILE + TILE / 2) });
}

// ==================== 箱子系统 ====================
// 箱子内容存于 game.chests[idx]，idx = ty*WORLD_W+tx，值为长度 CHEST_SLOTS 的数组，每格 {id,count}|null
function getChest(idx) {
  if (!game.chests[idx]) game.chests[idx] = new Array(CHEST_SLOTS).fill(null);
  return game.chests[idx];
}
function chestHasItems(idx) {
  const arr = game.chests[idx];
  return !!(arr && arr.some(s => s));
}
// 打开箱子 UI（右键/点按触发）。箱子内容在首次打开时初始化为空数组
function openChest(tx, ty) {
  const idx = ty * WORLD_W + tx;
  getChest(idx);
  game.chestIdx = idx;
  game.chestOpen = true;
  game.chestDirty = true;
  // 打开箱子时关闭其它面板，避免叠层
  game.craftingOpen = false;
  game.inventoryOpen = false;
  sfx('chest');
}

// 检查附近是否有工作台/熔炉
function hasCraftingStation(type) {
  const px = game.player.x / TILE | 0;
  const py = game.player.y / TILE | 0;
  for (let dx = -4; dx <= 4; dx++) {
    for (let dy = -4; dy <= 4; dy++) {
      const id = getTile(px + dx, py + dy);
      if (type === 'workbench' && id === 17) return true;
      if (type === 'furnace' && id === 18) return true;
    }
  }
  return false;
}

// ==================== 物理与碰撞 ====================
function moveEntity(e, dt) {
  const dts = dt / 16.67; // 标准化到60fps步长

  // X轴移动
  e.x += e.vx * dts;
  collideAxis(e, 'x');

  // Y轴移动（水中浮力：降低重力并限制下沉速度）
  let g = GRAVITY;
  if (e.inWater) g *= 0.18;
  else if (e.isPlayer) {
    // 跳跃手感曲线：下落比上升快(fast-fall) + 顶点轻微悬停，只对玩家生效，不影响掉落物/怪物
    if (e.vy > 0) g *= FALL_GRAVITY_MULT;
    else if (Math.abs(e.vy) < APEX_VY) g *= APEX_GRAVITY_MULT;
  }
  const maxFall = e.inWater ? 2.2 : MAX_FALL;
  e.vy += g * dts;
  if (e.vy > maxFall) e.vy = maxFall;
  e.y += e.vy * dts;
  e.onGround = false;
  collideAxis(e, 'y');
}

function collideAxis(e, axis) {
  const minTx = Math.floor(e.x / TILE);
  const maxTx = Math.floor((e.x + e.w - 1) / TILE);
  const minTy = Math.floor(e.y / TILE);
  const maxTy = Math.floor((e.y + e.h - 1) / TILE);

  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (!isSolid(tx, ty)) continue;

      const tileLeft = tx * TILE;
      const tileTop = ty * TILE;
      const tileRight = tileLeft + TILE;
      const tileBottom = tileTop + TILE;

      if (axis === 'x') {
        if (e.vx > 0) { e.x = tileLeft - e.w; e.vx = 0; }
        else if (e.vx < 0) { e.x = tileRight; e.vx = 0; }
      } else {
        if (e.vy > 0) { e.y = tileTop - e.h; e.vy = 0; e.onGround = true; }
        else if (e.vy < 0) { e.y = tileBottom; e.vy = 0; }
      }
    }
  }

  // 世界边界
  if (e.x < 0) { e.x = 0; e.vx = 0; }
  if (e.x + e.w > WORLD_W * TILE) { e.x = WORLD_W * TILE - e.w; e.vx = 0; }
  if (e.y < 0) { e.y = 0; e.vy = 0; }
  if (e.y > WORLD_H * TILE) { e.y = 0; e.vy = 0; e.health = 0; game._voidFall = true; } // 掉出世界（标记虚空坠落：重生时跳过死亡掉落，见 respawn）
}

// 实体间碰撞解算：把 a 推出 b 的身体（a 受力、b 不动），用于玩家被怪物挡住
function pushOutOf(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return;
  if (ox < oy) {
    if (a.x < b.x) a.x = b.x - a.w; else a.x = b.x + b.w;
  } else {
    if (a.y < b.y) { a.y = b.y - a.h; if (a.vy > 0) a.vy = 0; }
    else { a.y = b.y + b.h; if (a.vy < 0) a.vy = 0; }
  }
}

// 实体间碰撞解算：怪物之间优先在 x 方向散开，避免堆叠在同一列 / 同一 x 坐标
function resolveOverlapAABB(a, b) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox <= 0 || oy <= 0) return;
  // 优先水平分离，保证重叠时两怪落在不同 x
  const pushX = ox / 2 + 0.1;
  const ax = a.x < b.x ? a.x - pushX : a.x + pushX;
  const bx = a.x < b.x ? b.x + pushX : b.x - pushX;
  if (!wouldBeSolidX(ax, a) && !wouldBeSolidX(bx, b)) {
    a.x = ax; b.x = bx;
    a.vx *= 0.5; b.vx *= 0.5;
  } else {
    // 水平推开会卡进墙里时，再退而求其次做垂直分离
    const pushY = oy / 2 + 0.1;
    if (a.y < b.y) { a.y -= pushY; b.y += pushY; } else { a.y += pushY; b.y -= pushY; }
    if (a.vy > 0) a.vy = 0;
    if (b.vy > 0) b.vy = 0;
  }
}

// 判断把实体放到 x（保持 y 不变）时是否会嵌进实心方块
function wouldBeSolidX(x, e) {
  const xl = Math.floor(x / TILE);
  const xr = Math.floor((x + e.w - 1) / TILE);
  const yt = Math.floor(e.y / TILE);
  const yb = Math.floor((e.y + e.h - 1) / TILE);
  for (let ty = yt; ty <= yb; ty++) {
    if (isSolid(xl, ty) || isSolid(xr, ty)) return true;
  }
  return false;
}

// ==================== 输入处理 ====================
function bindEvents() {
  window.addEventListener('keydown', e => {
    game.keys[e.code] = true;
    // 防止空格触发按钮点击（跳跃键）
    if (e.code === 'Space') e.preventDefault();
    // 对战时只允许 Escape（但动画期间禁止退出）
    if (game.battleOpen) {
      if (e.code === 'Escape' && !game.battleAnimating) closeBattle();
      return;
    }
    // 热栏选择
    if (e.code.startsWith('Digit')) {
      const n = parseInt(e.code.slice(5));
      game.selectedSlot = (n === 0) ? 9 : n - 1;
    }
    if (e.code === 'KeyE') {
      game.inventoryOpen = !game.inventoryOpen;
      if (game.inventoryOpen) { game.craftingOpen = false; game.chestOpen = false; }
      game.inventoryDirty = true;
    }
    if (e.code === 'KeyQ' && !e.repeat) {
      dropSelected(); // 甩落当前手持物品
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      if (!game.craftingOpen) {
        game.craftingOpen = true;
        game.craftingMode = 'hand';
      } else if (game.craftingMode !== 'hand') {
        game.craftingMode = 'hand';
      } else {
        game.craftingOpen = false;
      }
      if (game.craftingOpen) { game.inventoryOpen = false; game.chestOpen = false; }
      game.craftingDirty = true;
    }
    if (e.code === 'Escape') { game.craftingOpen = false; game.inventoryOpen = false; game.chestOpen = false; }
    if (e.code === 'KeyM') { game.showMap = !game.showMap; }
  });
  window.addEventListener('keyup', e => { game.keys[e.code] = false; });
  // 失焦时清空所有输入：切窗/点别处会让 keyup、pointerup 丢失，导致按键或跳跃按钮卡在「按下」态，
  // 表现为「没按键盘却自动跳/持续移动」。失焦时强制复位，回到窗口后恢复正常。
  window.addEventListener('blur', () => {
    game.keys = {};
    if (game.touchInput) {
      for (const k in game.touchInput) game.touchInput[k] = false;
    }
    game._jumpHeld = false;
  });

  game.canvas.addEventListener('mousemove', e => {
    const rect = game.canvas.getBoundingClientRect();
    game.mouse.x = e.clientX - rect.left;
    game.mouse.y = e.clientY - rect.top;
    // 计算世界坐标
    game.mouse.worldX = game.camX + game.mouse.x;
    game.mouse.worldY = game.camY + game.mouse.y;
    // 热栏悬停检测
    const slotSize = 40, gap = 4;
    const totalW = 10 * slotSize + 9 * gap;
    const startX = (game.cw - totalW) / 2;
    const hotY = game.ch - slotSize - 16;
    if (game.mouse.y >= hotY && game.mouse.y <= hotY + slotSize) {
      const relX = game.mouse.x - startX;
      if (relX >= 0 && relX < totalW) {
        game.hoveredSlot = Math.floor(relX / (slotSize + gap));
        if (game.hoveredSlot < 0 || game.hoveredSlot > 9) game.hoveredSlot = -1;
      } else {
        game.hoveredSlot = -1;
      }
    } else {
      game.hoveredSlot = -1;
    }
  });

  game.canvas.addEventListener('mousedown', e => {
    e.preventDefault();
    // 热栏点击选择
    if (e.button === 0) {
      const slotSize = 44, gap = 4;
      const totalW = 10 * slotSize + 9 * gap;
      const startX = (game.cw - totalW) / 2;
      const hotY = game.ch - slotSize - 14;
      if (game.mouse.y >= hotY && game.mouse.y <= hotY + slotSize) {
        const relX = game.mouse.x - startX;
        if (relX >= 0 && relX < totalW) {
          const slot = Math.floor(relX / (slotSize + gap));
          if (slot >= 0 && slot <= 9 && game.hotbar[slot] > 0) {
            game.selectedSlot = slot;
            sfx('click');
            return;
          }
        }
      }
    }
    if (e.button === 0) game.mouse.left = true;
    if (e.button === 2) game.mouse.right = true;
  });
  // 关键修复：mouseup 必须绑定到 window 而非 canvas。
  // 否则鼠标在 canvas 上按下、移到 HTML UI 控件（合成/背包/箱子面板）或浏览器其它区域后松开，
  // canvas 收不到 mouseup，game.mouse.left/right 将永久卡在 true —— 玩家松手后仍在持续挖掘/放置（“自动挖掘”BUG）。
  window.addEventListener('mouseup', e => {
    if (e.button === 0) game.mouse.left = false;
    if (e.button === 2) game.mouse.right = false;
  });
  // 失焦（切走标签页/窗口）时同样清掉，避免回来后残留的按键状态继续触发操作
  window.addEventListener('blur', () => {
    game.mouse.left = false;
    game.mouse.right = false;
  });
  game.canvas.addEventListener('contextmenu', e => e.preventDefault());

  // 触屏支持
  function isOnMobileControl(e) {
    // 触摸点在移动控件（摇杆/按钮）上时，交还控件处理，canvas 不拦截不设瞄准
    const tgt = e.target;
    return !!(tgt && tgt.closest && tgt.closest('#mobile-controls'));
  }
  function onTouchStart(e) {
    if (isOnMobileControl(e)) return; // 控件触摸：不 preventDefault，避免与多点触控冲突
    e.preventDefault();
    const t = e.touches[0];
    const rect = game.canvas.getBoundingClientRect();
    game.mouse.x = t.clientX - rect.left;
    game.mouse.y = t.clientY - rect.top;
    game.mouse.worldX = game.camX + game.mouse.x;
    game.mouse.worldY = game.camY + game.mouse.y;
    // 触屏设备：记录玩家点选的世界坐标，作为挖掘/放置的自主选择目标
    if (game.touchInput.isTouch) {
      game.touchInput.aimX = game.mouse.worldX;
      game.touchInput.aimY = game.mouse.worldY;
      game.touchInput.aimActive = true;
      game.touchInput.tap = true;
    } else {
      game.mouse.left = true;
    }
  }
  function onTouchMove(e) {
    if (isOnMobileControl(e)) return; // 控件触摸不拦截
    e.preventDefault();
    const t = e.touches[0];
    const rect = game.canvas.getBoundingClientRect();
    game.mouse.x = t.clientX - rect.left;
    game.mouse.y = t.clientY - rect.top;
    game.mouse.worldX = game.camX + game.mouse.x;
    game.mouse.worldY = game.camY + game.mouse.y;
    // 触屏拖动时持续更新点选目标，便于玩家瞄准
    if (game.touchInput.isTouch) {
      game.touchInput.aimX = game.mouse.worldX;
      game.touchInput.aimY = game.mouse.worldY;
      game.touchInput.aimActive = true;
    }
  }
  function onTouchEnd(e) {
    if (game.touchInput.isTouch) {
      game.touchInput.tap = false;
    } else {
      game.mouse.left = false;
    }
  }
  game.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
  game.canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  game.canvas.addEventListener('touchend', onTouchEnd, { passive: false });
  game.canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // 合成界面点击（手里拿着物品时点击空白先放回背包）
  document.getElementById('crafting-overlay').addEventListener('click', e => {
    if (e.target.id === 'crafting-overlay') {
      if (game.cursorId > 0) giveCursorToBag();
      game.craftingOpen = false;
    }
  });

  // 背包界面点击（手里拿着物品时点击空白只放回、不关面板，防止误关）
  document.getElementById('inventory-overlay').addEventListener('click', e => {
    if (e.target.id !== 'inventory-overlay') return;
    if (game.cursorId > 0) return;
    if (performance.now() - (game._cursorDropTs || 0) < 450) return;
    game.inventoryOpen = false;
  });

  // 箱子界面点击（点面板外区域关闭；手里拿物时先放回不关面板）
  const chestOverlay = document.getElementById('chest-overlay');
  if (chestOverlay) {
    chestOverlay.addEventListener('click', e => {
      if (e.target.id !== 'chest-overlay') return;
      if (game.cursorId > 0) return;
      if (performance.now() - (game._cursorDropTs || 0) < 450) return;
      game.chestOpen = false;
    });
  }

  // 对战面板点击外部关闭
  const battleOverlay = document.getElementById('battle-overlay');
  if (battleOverlay) {
    battleOverlay.addEventListener('click', e => {
      if (e.target.id === 'battle-overlay' && !game.battleAnimating) {
        closeBattle();
      }
    });
  }

  // 背包/箱子里的鼠标“拿起-拖放”物品搬运
  bindCursorDrag();
}

// ==================== 手机触屏控件 ====================
function bindMobileControls() {
  // ---- 虚拟摇杆（Pointer Events 多点触控：摇杆只认自己的 pointerId，右按钮同时按互不干扰）----
  const joyBase = document.getElementById('joystick-base');
  const joyKnob = document.getElementById('joystick-knob');
  let joyActive = false;
  let joyCenterX = 0, joyCenterY = 0;
  let joyPointerId = null; // 摇杆自身对应的 pointerId/touchId，多指时只跟随它

  function joyStart(e) {
    e.preventDefault();
    e.stopPropagation();
    if (joyActive) return; // 已在追踪一根手指，忽略其它手指（摇杆单指）
    joyActive = true;
    joyPointerId = (e.pointerId !== undefined) ? e.pointerId : ((e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0].identifier : null);
    joyBase.classList.add('active');
    const rect = joyBase.getBoundingClientRect();
    joyCenterX = rect.left + rect.width / 2;
    joyCenterY = rect.top + rect.height / 2;
    joyMove(e);
  }

  function joyMove(e) {
    if (!joyActive) return;
    e.preventDefault();
    e.stopPropagation();
    // 多点触控：只跟随摇杆自己的那根手指/指针（identifier 匹配）
    let t = null;
    if (e.touches && e.touches.length) {
      if (joyPointerId !== null) {
        t = [...e.touches].find(tt => tt.identifier === joyPointerId) || null;
      }
      if (!t) t = e.touches[0];
    } else {
      t = e;
    }
    if (!t) return;
    let dx = t.clientX - joyCenterX;
    let dy = t.clientY - joyCenterY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxR = 45;
    if (dist > maxR) {
      dx = (dx / dist) * maxR;
      dy = (dy / dist) * maxR;
    }
    joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // 水平移动：超过死区才触发
    const deadzone = 12;
    if (Math.abs(dx) > deadzone) {
      game.touchInput.moveX = dx > 0 ? 1 : -1;
    } else {
      game.touchInput.moveX = 0;
    }
    // 垂直分量：用于手机 8 向挖掘/放置瞄准（屏幕 y 向下为正）
    if (Math.abs(dy) > deadzone) {
      game.touchInput.moveY = dy > 0 ? 1 : -1;
    } else {
      game.touchInput.moveY = 0;
    }
  }

  function joyEnd(e) {
    e.preventDefault();
    e.stopPropagation();
    // 仅当摇杆自己的那根手指/指针抬起时才重置（其它手指松开不影响摇杆）
    if (joyPointerId !== null) {
      const isEnded = (e.changedTouches && [...e.changedTouches].some(tt => tt.identifier === joyPointerId)) ||
                      (e.pointerId !== undefined && e.pointerId === joyPointerId);
      if (!isEnded) return;
    }
    joyActive = false;
    joyPointerId = null;
    joyBase.classList.remove('active');
    joyKnob.style.transform = 'translate(-50%, -50%)';
    game.touchInput.moveX = 0;
    game.touchInput.moveY = 0;
  }

  if (window.PointerEvent) {
    joyBase.addEventListener('pointerdown', joyStart, { passive: false });
    joyBase.addEventListener('pointermove', joyMove, { passive: false });
    joyBase.addEventListener('pointerup', joyEnd, { passive: false });
    joyBase.addEventListener('pointercancel', joyEnd, { passive: false });
  } else {
    joyBase.addEventListener('touchstart', joyStart, { passive: false });
    joyBase.addEventListener('touchmove', joyMove, { passive: false });
    joyBase.addEventListener('touchend', joyEnd, { passive: false });
    joyBase.addEventListener('touchcancel', joyEnd, { passive: false });
    // 鼠标也支持（测试用）
    joyBase.addEventListener('mousedown', joyStart);
    window.addEventListener('mousemove', e => { if (joyActive) joyMove(e); });
    window.addEventListener('mouseup', e => { if (joyActive) joyEnd(e); });
  }

  // ---- 通用按钮多点触控绑定 ----
  // 用 Pointer Events 替代 touch 事件：每根手指独立 pointerId，左摇杆与右按钮天然可同时按下。
  // 兼容不支持 Pointer Events 的旧浏览器（回退到 touch/mouse）。
  function bindHoldButton(btn, onDown, onUp) {
    if (!btn) return;
    if (window.PointerEvent) {
      btn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); onDown(e); }, { passive: false });
      btn.addEventListener('pointerup', e => { e.preventDefault(); e.stopPropagation(); onUp(e); }, { passive: false });
      btn.addEventListener('pointercancel', onUp, { passive: false });
      btn.addEventListener('pointerleave', onUp, { passive: false });
    } else {
      btn.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onDown(e); }, { passive: false });
      btn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); onUp(e); }, { passive: false });
      btn.addEventListener('touchcancel', onUp, { passive: false });
      btn.addEventListener('mousedown', onDown);
      btn.addEventListener('mouseup', onUp);
      btn.addEventListener('mouseleave', onUp);
    }
  }
  function bindTapButton(btn, onTap) {
    if (!btn) return;
    if (window.PointerEvent) {
      btn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); onTap(e); }, { passive: false });
    } else {
      btn.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); onTap(e); }, { passive: false });
      btn.addEventListener('mousedown', onTap);
    }
  }

  // ---- 跳跃按钮 ----
  const btnJump = document.getElementById('btn-jump');
  function jumpStart(e) {
    game.touchInput.jump = true;
    btnJump.classList.add('pressed');
  }
  function jumpEnd(e) {
    game.touchInput.jump = false;
    btnJump.classList.remove('pressed');
  }
  bindHoldButton(btnJump, jumpStart, jumpEnd);

  // ---- 挖掘按钮（持续按住）----
  const btnMine = document.getElementById('btn-mine');
  function mineStart(e) {
    game.touchInput.mine = true;
    btnMine.classList.add('pressed');
  }
  function mineEnd(e) {
    game.touchInput.mine = false;
    btnMine.classList.remove('pressed');
  }
  bindHoldButton(btnMine, mineStart, mineEnd);

  // ---- 放置按钮（单次触发）----
  const btnPlace = document.getElementById('btn-place');
  function placeTap(e) {
    game.touchInput.place = true;
    btnPlace.classList.add('pressed');
    setTimeout(() => btnPlace.classList.remove('pressed'), 150);
  }
  bindTapButton(btnPlace, placeTap);

  // ---- 甩落/丢弃按钮 ----
  const btnDrop = document.getElementById('btn-drop');
  function dropStart(e) {
    game.touchInput.drop = true;
    btnDrop.classList.add('pressed');
  }
  function dropEnd(e) {
    game.touchInput.drop = false;
    btnDrop.classList.remove('pressed');
  }
  bindHoldButton(btnDrop, dropStart, dropEnd);

  // ---- 静音按钮（桌面+手机通用）----
  const btnMute = document.getElementById('btn-mute');
  if (btnMute) {
    const toggleMute = e => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.Sound) return;
      const muted = Sound.toggleMute();
      btnMute.textContent = muted ? '🔇' : '🔊';
      showToast(muted ? '🔇 已静音' : '🔊 音效开启', 800);
    };
    btnMute.addEventListener('touchstart', toggleMute, { passive: false });
    btnMute.addEventListener('mousedown', toggleMute);
  }

  // ---- 服务器版：世界差量由服务端内存持有，客户端无本地存档 ----
  // 挖/放实时上报服务端 recordBlock，新加入 welcome.worldstate 下发全量差量，
  // 服务端每 60 秒广播 worldstate 纠错——确保客户端世界一致。

  // ---- 背包按钮 ----
  const btnInv = document.getElementById('btn-inventory');
  btnInv.addEventListener('touchstart', e => {
    e.preventDefault();
    e.stopPropagation();
    game.inventoryOpen = !game.inventoryOpen;
    if (game.inventoryOpen) { game.craftingOpen = false; game.chestOpen = false; }
    game.inventoryDirty = true;
    sfx('click');
  }, { passive: false });
  btnInv.addEventListener('click', e => {
    e.stopPropagation();
  });

  // ---- 合成按钮 ----
  const btnCraft = document.getElementById('btn-craft');
  btnCraft.addEventListener('touchstart', e => {
    e.preventDefault();
    e.stopPropagation();
    if (!game.craftingOpen) {
      game.craftingOpen = true;
      game.craftingMode = 'hand';
    } else if (game.craftingMode !== 'hand') {
      game.craftingMode = 'hand';
    } else {
      game.craftingOpen = false;
    }
    if (game.craftingOpen) { game.inventoryOpen = false; game.chestOpen = false; }
    game.craftingDirty = true;
    sfx('click');
  }, { passive: false });
  btnCraft.addEventListener('click', e => {
    e.stopPropagation();
  });

  // ---- 热栏触屏选择 ----
  game.canvas.addEventListener('touchstart', e => {
    if (!game.touchInput.isTouch) return;
    // 如果触摸在控件上则跳过
    const target = e.target;
    if (target.closest('#mobile-controls')) return;
    // 热栏区域检测
    const rect = game.canvas.getBoundingClientRect();
    const tx = e.touches[0].clientX - rect.left;
    const ty = e.touches[0].clientY - rect.top;
    const slotSize = 44, gap = 4;
    const totalW = 10 * slotSize + 9 * gap;
    const startX = (game.cw - totalW) / 2;
    const hotY = game.ch - slotSize - 20; // 触屏热栏位置
    if (ty >= hotY && ty <= hotY + slotSize) {
      const relX = tx - startX;
      if (relX >= 0 && relX < totalW) {
        const slot = Math.floor(relX / (slotSize + gap));
        if (slot >= 0 && slot <= 9 && game.hotbar[slot] > 0) {
          game.selectedSlot = slot;
          sfx('click');
          e.preventDefault();
          return;
        }
      }
    }
  }, { passive: false });
}

// ==================== 玩家更新 ====================
function updatePlayer(dt) {
  const p = game.player;
  const dts = dt / 16.67;

  // 水体检测：
  //  inWater      —— 身体任一格入水（浮力/游泳/减速，脚踩水即生效）
  //  headInWater  —— 头部（顶格）入水（氧气消耗判定，只有头没入才耗氧）
  let inWater = false, headInWater = false;
  {
    const minX = Math.floor((p.x + 2) / TILE);
    const maxX = Math.floor((p.x + p.w - 2) / TILE);
    const minY = Math.floor((p.y + 6) / TILE);   // 顶格 ≈ 头部
    const maxY = Math.floor((p.y + p.h - 2) / TILE);
    for (let yy = minY; yy <= maxY && !inWater; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        if (getTile(xx, yy) === 12) {
          inWater = true;
          if (yy === minY) headInWater = true; // 顶格入水 = 头部没入
          break;
        }
      }
    }
  }
  p.inWater = inWater;
  p.headInWater = headInWater;

  // 水下氧气：仅头部没入水中才消耗；脚踩水/半身入水不耗氧；出水回复；耗尽后按秒扣血
  if (p.headInWater) {
    p.oxygen = Math.max(0, p.oxygen - OXYGEN_DRAIN_PER_SEC * (dt / 1000));
  } else {
    p.oxygen = Math.min(p.maxOxygen, p.oxygen + OXYGEN_REGEN_PER_SEC * (dt / 1000));
  }
  if (p.oxygen <= 0) {
    // 溺水脉冲：无敌窗口（DROWN_INVULN）结束后才再次扣血，与敌人/爆炸/岩浆共用 p.invuln 机制
    if (p.invuln <= 0) {
      p.health = Math.max(0, p.health - DROWN_DAMAGE_PULSE);
      p.invuln = DROWN_INVULN;
      p.lastDamageTime = performance.now(); // 暂停血量自动回复
      sfx('hurt');
    }
    if (Math.random() < 0.04) spawnParticles(p.x + p.w / 2, p.y + 4, '#9fd8ff', 1); // 溺水气泡
  }

  // 移动
  let moveX = 0;
  if (game.keys['KeyA'] || game.keys['ArrowLeft']) moveX -= 1;
  if (game.keys['KeyD'] || game.keys['ArrowRight']) moveX += 1;
  // 手机摇杆
  if (moveX === 0 && game.touchInput.moveX !== 0) moveX = game.touchInput.moveX;

  // 移动（水中减速并带水阻）
  const sp = inWater ? PLAYER_SPEED * 0.6 : PLAYER_SPEED;
  if (moveX !== 0) {
    p.vx = moveX * sp;
    p.facing = moveX;
    p.walkPhase += dts * 0.3;
  } else {
    p.vx *= inWater ? 0.85 : 0.7;
    if (Math.abs(p.vx) < 0.1) p.vx = 0;
    p.walkPhase = 0;
  }

  // 跳跃手感系统：上升沿触发 + 可变跳高 + 土狼时间 + 跳跃缓冲（仅地面/土狼窗口内触发，杜绝自动跳）
  const jumpNow = game.keys['KeyW'] || game.keys['Space'] || game.keys['ArrowUp'] || game.touchInput.jump;
  const jumpEdge = jumpNow && !game._jumpHeld;
  // 松键那一帧削减上升速度 → 轻点=小跳、长按=满跳（可变跳高，仅释放瞬间生效一次）
  if (game._jumpHeld && !jumpNow && p.vy < 0) p.vy *= JUMP_CUT;
  game._jumpHeld = jumpNow;

  // 土狼时间：离地后仍有数帧可起跳，避免悬崖边"踩空漏跳"
  if (p.onGround) p.coyote = COYOTE;
  else if (p.coyote > 0) p.coyote -= dts;
  // 跳跃缓冲：落地前提前按下不丢失
  if (jumpEdge) p.jumpBuffer = JUMP_BUFFER;
  else if (p.jumpBuffer > 0) p.jumpBuffer -= dts;

  if (p.jumpBuffer > 0 && p.coyote > 0) {
    p.vy = -JUMP_FORCE;
    p.onGround = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    sfx('jump');
  } else if (jumpNow && inWater) {
    p.vy -= 0.9 * dts;
    if (p.vy < -4.5) p.vy = -4.5;
    if (Math.random() < 0.12) sfx('splash', { pan: audioPan(p.x + p.w / 2) });
  }

  // 物理
  moveEntity(p, dt);

  if (p.invuln > 0) p.invuln -= dt;

  // 血量自动回复：受伤4秒后开始，每800ms回复2HP
  if (p.health < p.maxHealth && p.invuln <= 0) {
    const timeSinceDamage = performance.now() - (p.lastDamageTime || 0);
    if (timeSinceDamage > 4000) {
      game.regenAccum += dt;
      if (game.regenAccum >= 800) {
        game.regenAccum = 0;
        p.health = Math.min(p.maxHealth, p.health + 2);
        if (Math.random() < 0.4) {
          spawnParticles(p.x + p.w / 2, p.y + 4, '#22ff44', 2);
        }
      }
    }
  }

  // 岩浆伤害：接触岩浆(63)持续扣血（带无敌冷却）
  if (p.invuln <= 0) {
    const lcx = Math.floor((p.x + p.w / 2) / TILE);
    const lcy = Math.floor((p.y + p.h / 2) / TILE);
    let onLava = getTile(lcx, lcy) === 63;
    if (!onLava) {
      const lfy = Math.floor((p.y + p.h - 1) / TILE);
      onLava = getTile(lcx, lfy) === 63;
    }
    if (onLava) {
      p.health -= LAVA_DAMAGE;
      p.lastDamageTime = performance.now();
      p.invuln = LAVA_INVULN;
      sfx('hurt');
    }
  }

  // 死亡
  if (p.health <= 0) {
    respawn();
  }

  // 玩家所在方块坐标（提前计算，供下方触屏挖掘/放置使用，避免 TDZ 引用错误）
  const px = Math.floor((p.x + p.w / 2) / TILE);
  const py = Math.floor((p.y + p.h / 2) / TILE);

  // 任意 UI 覆盖层打开时，玩家世界输入必须冻结：既不挖掘也不放置。
  // 否则打开背包/合成时若鼠标 worldX/Y 仍指向某实体方块，会出现“UI 背后自动挖掘”的假象。
  const uiOpen = game.craftingOpen || game.inventoryOpen || game.chestOpen;

  // 挖掘/放置/对战
  // 手机触屏挖掘：优先用玩家在画布上点选的方块（自主选择），否则回退摇杆 8 向瞄准
  if (game.touchInput.isTouch && game.touchInput.mine && !game.battleOpen && !uiOpen) {
    const aim = getMobileTargetTile(px, py);
    game.mouse.worldX = aim.tx * TILE + TILE / 2;
    game.mouse.worldY = aim.ty * TILE + TILE / 2;
    game.mouse.left = true;
  } else if (game.touchInput.isTouch && !game.touchInput.mine) {
    // 挖掘按钮松开时清除
    game.mouse.left = false;
  }
  // 手机触屏放置：优先用玩家点选的方块（单次触发），否则回退摇杆 8 向瞄准
  if (game.touchInput.isTouch && game.touchInput.place && !game.battleOpen && !uiOpen) {
    const aim = getMobileTargetTile(px, py);
    game.mouse.worldX = aim.tx * TILE + TILE / 2;
    game.mouse.worldY = aim.ty * TILE + TILE / 2;
    game.mouse.right = true;
    game.touchInput.place = false; // 单次触发后清除
  }
  // 手机触屏甩落（单次触发）：丢出当前手持物品
  if (game.touchInput.isTouch && game.touchInput.drop && !game.battleOpen) {
    dropSelected();
    game.touchInput.drop = false;
  }

  const tx = Math.floor(game.mouse.worldX / TILE);
  const ty = Math.floor(game.mouse.worldY / TILE);
  const dist = Math.abs(tx - px) + Math.abs(ty - py);

  if (game.battleCooldown > 0) game.battleCooldown -= dt;

  // 点击敌人 → 手持剑则近战挥击，否则开启卡牌对战（优先于挖掘）
  let clickedEnemy = false;
  const tapActive = game.mouse.left || (game.touchInput.isTouch && game.touchInput.tap);
  if (tapActive && !game.battleOpen && game.battleCooldown <= 0) {
    for (const en of game.enemies) {
      const ex = en.x + en.w / 2;
      const ey = en.y + en.h / 2;
      if (Math.abs(game.mouse.worldX - ex) < en.w &&
          Math.abs(game.mouse.worldY - ey) < en.h && dist <= REACH) {
        const held = game.hotbar[game.selectedSlot];
        const heldBlock = (held > 0) ? BLOCKS[held] : null;
        if (heldBlock && heldBlock.tool === 'sword') {
          meleeAttack(en); // 近战挥剑（有耐久，伤害高）
        } else {
          openBattle(en);
        }
        game.mouse.left = false;
        game.touchInput.tap = false;
        clickedEnemy = true;
        break;
      }
    }
  }

  // 任意 UI 覆盖层打开时，冻结玩家世界输入并清零挖掘进度：
  // 既防止“UI 背后自动挖掘”，也避免关闭 UI 瞬间因残留按键状态立即瞬挖。
  if (uiOpen) {
    game.mouse.left = false;
    game.mouse.right = false;
    game.touchInput.mine = false;
    game.mining.target = null;
    game.mining.progress = 0;
  }

  // 挖掘（未点中敌人时）
  // 触屏设备：挖掘只通过按钮触发
  const mineActive = game.touchInput.isTouch ? (game.touchInput.mine && game.mouse.left) : game.mouse.left;
  if (!clickedEnemy && mineActive && dist <= REACH && !game.battleOpen && !uiOpen) {
    handleMining(tx, ty, dt);
  } else if (!game.battleOpen && !mineActive && !uiOpen) {
    game.mining.target = null;
    game.mining.progress = 0;
  }

  // 触屏点击工作站打开UI
  if (game.touchInput.isTouch && game.touchInput.tap && !clickedEnemy && !game.battleOpen) {
    if (tryBucketAction(tx, ty)) { game.touchInput.tap = false; return; } // 桶舀取/倒出优先
    const tapTile = getTile(tx, ty);
    if (tapTile === 17 && dist <= REACH) {
      game.craftingOpen = true;
      game.craftingMode = 'workbench';
      game.craftingDirty = true;
      game.inventoryOpen = false;
      game.touchInput.tap = false;
      sfx('click');
    } else if (tapTile === 18 && dist <= REACH) {
      game.craftingOpen = true;
      game.craftingMode = 'furnace';
      game.craftingDirty = true;
      game.inventoryOpen = false;
      game.touchInput.tap = false;
      sfx('click');
    } else if (tapTile === 59 && dist <= REACH) {
      // 床：点按设重生点 / 睡过夜晚
      sleepInBed(tx, ty);
      game.touchInput.tap = false;
    } else if (tapTile === 26 && dist <= REACH) {
      // 木门：点按开关（开着的门可穿过）
      toggleDoor(tx, ty);
      game.touchInput.tap = false;
    } else if (tapTile === 27 && dist <= REACH) {
      // 箱子：点按打开
      openChest(tx, ty);
      game.touchInput.tap = false;
    }
  }

  // 触屏点击为一次性行为：本帧处理后无论是否命中，都清除 tap，
  // 防止 tap 卡住导致每帧重复触发对战/合成界面（造成“假死机”）
  if (game.touchInput.isTouch) game.touchInput.tap = false;

  // 右键：打开工作站UI 或 放置方块（UI 打开时由上方 uiOpen 守卫冻结，这里再加一层拦截）
  if (game.mouse.right && !game.battleOpen && !uiOpen) {
    if (tryBucketAction(tx, ty)) { game.mouse.right = false; return; }
    const targetTile = getTile(tx, ty);
    if (targetTile === 17 && dist <= REACH) {
      game.craftingOpen = true;
      game.craftingMode = 'workbench';
      game.craftingDirty = true;
      game.inventoryOpen = false;
      game.mouse.right = false;
      sfx('click');
    } else if (targetTile === 18 && dist <= REACH) {
      game.craftingOpen = true;
      game.craftingMode = 'furnace';
      game.craftingDirty = true;
      game.inventoryOpen = false;
      game.mouse.right = false;
      sfx('click');
    } else if (targetTile === 59 && dist <= REACH) {
      // 床：右键设重生点 / 睡过夜晚
      sleepInBed(tx, ty);
      game.mouse.right = false;
    } else if (targetTile === 26 && dist <= REACH) {
      // 木门：右键开关（开着的门可穿过）
      toggleDoor(tx, ty);
      game.mouse.right = false;
    } else if (targetTile === 27 && dist <= REACH) {
      // 箱子：右键打开
      openChest(tx, ty);
      game.mouse.right = false;
    } else if (dist <= REACH && dist > 0) {
      handlePlacing(tx, ty);
      game.mouse.right = false;
    }
    // 触屏放置兜底清除
    if (game.touchInput.isTouch) game.mouse.right = false;
  }
}

// 挖掘逻辑：按硬度与工具需求推进进度，完成后掉落对应物品并清空方块
function handleMining(tx, ty, dt) {
  const tileId = getTile(tx, ty);
  if (tileId === 0) return;
  const block = BLOCKS[tileId];
  if (!block || block.hardness === 0) return;

  // 箱子保护：箱内还有物品时不允许挖掘，必须先清空（避免物品凭空消失）
  if (tileId === 27 && chestHasItems(ty * WORLD_W + tx)) {
    const now = performance.now();
    if (now - game._chestWarn > 1500) {
      showToast('箱子里还有东西，先拿出来！', 1500);
      game._chestWarn = now;
    }
    game.mining.target = null;
    game.mining.progress = 0;
    return;
  }

  // 工具需求检查
  const requiredTier = block.tool || 0;
  const equippedToolId = game.hotbar[game.selectedSlot];
  const equippedTool = equippedToolId > 0 ? BLOCKS[equippedToolId] : null;
  // 只有镐子(tool==='pickaxe')才提供挖掘等级；剑虽有 toolTier 但那是武器等级，不能挖矿
  const toolTier = (equippedTool && equippedTool.tool === 'pickaxe' && equippedTool.toolTier) ? equippedTool.toolTier : 0;

  if (requiredTier > 0 && toolTier < requiredTier) {
    const toolNames = ['', '木镐', '石镐', '铁镐'];
    if (!game.mining.toolWarnTimer || performance.now() - game.mining.toolWarnTimer > 1500) {
      showToast(`需要${toolNames[requiredTier]}或更好的工具！`, 1500);
      game.mining.toolWarnTimer = performance.now();
    }
    game.mining.target = null;
    game.mining.progress = 0;
    return;
  }

  // 工具加速：有工具时挖掘更快
  const speedMul = toolTier > 0 ? 1 + toolTier * 0.4 : 1;

  const targetKey = tx + ',' + ty;
  if (game.mining.target !== targetKey) {
    game.mining.target = targetKey;
    game.mining.progress = 0;
    game.mining.x = tx;
    game.mining.y = ty;
  }

  game.mining.progress += dt * speedMul;
  // 粒子
  if (Math.random() < 0.3) {
    spawnParticles(tx * TILE + TILE / 2, ty * TILE + TILE / 2, block.shade || block.color, 2);
  }
  // 挖掘中反馈音（按进度步进，避免刷屏）
  if (!game.mining._tick || game.mining.progress - game.mining._tick >= 0.25) {
    game.mining._tick = game.mining.progress;
    sfx('dig', { pan: audioPan(tx * TILE + TILE / 2) });
  }

  if (game.mining.progress >= block.hardness * 8) {
    // 挖掘完成
    const dropId = block.drop || tileId;
    addItem(dropId, 1);
    if (tileId === 5 && Math.random() < SAPLING_DROP_CHANCE) addItem(64, 1); // 树叶有概率掉树苗
    setTile(tx, ty, 0);
    if (tileId === 64) game.saplings.delete(ty * WORLD_W + tx); // 挖掉树苗，移出生长表
    syncBlockChange(tx, ty, 0);
    // 木门占 2 格：挖掉任意一半时，连带另一半一并移除（不再掉落，整扇门仍回收为 1 个门物品）；
    // 同时清掉开门状态集合，避免残留“开启”索引
    if (tileId === 26) {
      for (const d of [0, -1, 1]) {
        const ny = ty + d;
        if (getTile(tx, ny) === 26) {
          setTile(tx, ny, 0);
          syncBlockChange(tx, ny, 0);
          game.openDoors.delete(ny * WORLD_W + tx);
        }
      }
    }
    // 箱子：挖掉时清除其存储的内容（挖掘前已强制清空，这里兜底）
    if (tileId === 27) {
      delete game.chests[ty * WORLD_W + tx];
    }
    spawnParticles(tx * TILE + TILE / 2, ty * TILE + TILE / 2, block.color, 12);
    sfx('break', { tile: tileId, pan: audioPan(tx * TILE + TILE / 2) });
    game.mining.target = null;
    game.mining.progress = 0;

    // 元素发现检测
    const elementSymbol = ORE_ELEMENT_MAP[tileId];
    if (elementSymbol && !game.discoveredElements.has(elementSymbol)) {
      game.discoveredElements.add(elementSymbol);
      showElementDiscovery(elementSymbol);
    }

  }
}

function handlePlacing(tx, ty) {
  // 桶类物品不能当成方块放置（舀/倒由 tryBucketAction 处理）
  const holdBlk = BLOCKS[game.hotbar[game.selectedSlot]];
  if (holdBlk && holdBlk.placeable === false) {
    showToast('桶请右键使用：舀水或岩浆 / 倒在空处', 900);
    return;
  }
  // 目标位置必须是空气或水：水中可放置方块，放置时排开该格的水（水体活跃集与分级由 setTile 同步清零）
  const tgt = getTile(tx, ty);
  if (tgt !== 0 && tgt !== 12) return;
  const wasWater = (tgt === 12);

  // （已支持在空中放置：不再要求相邻有固体方块，玩家朝向 5 格内任意空气处均可放）

  // 不能放在玩家身上
  const p = game.player;
  const pTx = Math.floor(p.x / TILE);
  const pTy = Math.floor(p.y / TILE);
  const pTx2 = Math.floor((p.x + p.w - 1) / TILE);
  const pTy2 = Math.floor((p.y + p.h - 1) / TILE);
  if (tx >= pTx && tx <= pTx2 && ty >= pTy && ty <= pTy2) {
    if (BLOCKS[game.hotbar[game.selectedSlot]] && BLOCKS[game.hotbar[game.selectedSlot]].solid) return;
  }

  const slot = game.selectedSlot;
  const blockId = game.hotbar[slot];
  if (blockId === 0 || game.hotbarCounts[slot] <= 0) return;

  // 工具（拾取类，非方块）不能放置：只有真正带 toolTier 的道具（木镐/石镐/铁镐）才算工具。
  // 注意：矿物/石头用 block.tool 表示「需要的挖掘等级」，并非工具，可被正常放置。
  const placeBlock = BLOCKS[blockId];
  if (placeBlock && placeBlock.toolTier) {
    showToast('工具不能放置，请选择方块', 800);
    return;
  }

  // 树苗：只能种在泥土(2)或草地(1)上（底部须有土壤支撑，否则种不下去）
  if (blockId === 64) {
    const below = getTile(tx, ty + 1);
    if (below !== 2 && below !== 1) {
      showToast('树苗只能种在泥土或草地上', 1000);
      return;
    }
  }

  // 木门：占上下 2 格（下半=点击处，上半=正上方一格）。需上方为空且不压住玩家。
  if (blockId === 26) {
    const topY = ty - 1;
    if (topY < 0 || (getTile(tx, topY) !== 0 && getTile(tx, topY) !== 12) ||
        (tx >= pTx && tx <= pTx2 && topY >= pTy && topY <= pTy2)) {
      showToast('门需要上下 2 格空间，且不能压住自己', 1200);
      return;
    }
    setTile(tx, ty, 26);
    syncBlockChange(tx, ty, 26);
    setTile(tx, topY, 26);
    syncBlockChange(tx, topY, 26);
    removeItem(26, 1);
    sfx('place', { pan: audioPan(tx * TILE + TILE / 2) });
    return;
  }

  setTile(tx, ty, blockId);
  syncBlockChange(tx, ty, blockId);
  if (blockId === 59) game.spawnPoint = { tx, ty }; // 放置床即锚定重生点（右键床也会刷新，见 sleepInBed）
  if (blockId === 64) game.saplings.set(ty * WORLD_W + tx, game.day + game.time); // 登记种植时的连续天数(day+time)，供精确生长计时
  removeItem(blockId, 1);
  sfx(wasWater ? 'splash' : (blockId === 15 ? 'torch' : 'place'), { pan: audioPan(tx * TILE + TILE / 2) });
}

// 桶逻辑：空桶可舀水(12)/岩浆(63)，装满的桶可在空邻格倒出对应液体
function tryBucketAction(tx, ty) {
  const held = game.hotbar[game.selectedSlot];
  if (!BLOCKS[held] || !BLOCKS[held].isBucket) return false; // 只有手持桶才处理
  const LAVA = 63;
  const tile = getTile(tx, ty);

  // 空桶 → 舀取
  if (held === 60) {
    if (tile === 12) {                          // 水
      const lvl = game.waterLevels[ty * WORLD_W + tx] || 0;
      if (lvl !== 4) {                          // 仅舀满级“源水”，流动浅水舀不动→杜绝水通胀
        showToast('只能舀满级水源（浅水舀不动）', 900);
        return false;
      }
      setTile(tx, ty, 0);
      syncBlockChange(tx, ty, 0);
      game.bucketFluid.delete(ty * WORLD_W + tx);
      removeItem(60, 1); addItem(61, 1);
      sfx('splash', { pan: audioPan(tx * TILE + TILE / 2) });
      return true;
    } else if (tile === LAVA) {                 // 岩浆
      const lvl = game.lavaLevels[ty * WORLD_W + tx] || 0;
      if (lvl !== 4) {                          // 岩浆同样只舀满级源，避免增殖
        showToast('只能舀满级岩浆源（流动岩浆舀不动）', 900);
        return false;
      }
      setTile(tx, ty, 0);
      syncBlockChange(tx, ty, 0);
      game.bucketFluid.delete(ty * WORLD_W + tx);
      removeItem(60, 1); addItem(62, 1);
      sfx('lava', { pan: audioPan(tx * TILE + TILE / 2) });
      return true;
    }
    return false; // 空桶对着非液体不做任何事
  }

  // 装桶 → 倒出（目标须为空且旁边有支撑）
  if (tile !== 0) return false;
  const hasNeighbor = isSolid(tx - 1, ty) || isSolid(tx + 1, ty) ||
                      isSolid(tx, ty - 1) || isSolid(tx, ty + 1);
  if (!hasNeighbor) return false;
  if (held === 61) {                            // 水桶 → 倒水
    setTile(tx, ty, 12);
    syncBlockChange(tx, ty, 12);
    game.bucketFluid.add(ty * WORLD_W + tx);
    removeItem(61, 1); addItem(60, 1);
    sfx('splash', { pan: audioPan(tx * TILE + TILE / 2) });
    return true;
  }
  if (held === 62) {                            // 岩浆桶 → 倒岩浆
    setTile(tx, ty, LAVA);
    syncBlockChange(tx, ty, LAVA);
    game.bucketFluid.add(ty * WORLD_W + tx);
    removeItem(62, 1); addItem(60, 1);
    sfx('lava', { pan: audioPan(tx * TILE + TILE / 2) });
    return true;
  }
  return false;
}

// 手机 8 向瞄准：根据虚拟摇杆方向（moveX, moveY）量化成 8 个方向之一。
// 摇杆居中时回退到面朝方向（保持旧习惯）。屏幕 y 向下为正，故“上”对应 dy=-1。
function getTouchAimDir() {
  const ti = game.touchInput;
  const dx = ti.moveX, dy = ti.moveY;
  if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
    return { dx: game.player.facing || 1, dy: 0 };
  }
  // 8 个方向（顺时针，从“右”开始）
  const dirs = [
    { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 1 },
    { dx: -1, dy: 0 }, { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
  ];
  const ang = Math.atan2(dy, dx);               // -π..π
  const oct = Math.round(ang / (Math.PI / 4));  // 0..7（接近边界四舍五入到最近方向）
  return dirs[((oct % 8) + 8) % 8];
}

// 手机挖掘/放置目标格：优先玩家在画布上点选的方块（自主选择），
// 若未点选或点选方块超出触及范围(REACH)，则回退到摇杆 8 向瞄准（相邻格）。
function getMobileTargetTile(px, py) {
  const ti = game.touchInput;
  if (ti.aimActive) {
    const atx = Math.floor(ti.aimX / TILE);
    const aty = Math.floor(ti.aimY / TILE);
    const adist = Math.abs(atx - px) + Math.abs(aty - py);
    // 仅当点选目标格仍在范围内且为实体方块时才锁定它；
    // 该格被挖空（变空气）后自动放弃锁定、回退到摇杆/正前方瞄准，
    // 使按住挖掘按钮能继续凿穿下一个方块，修复“挖掉一格后挖掘空转卡死”的问题
    if (adist <= REACH && getTile(atx, aty) !== 0) return { tx: atx, ty: aty };
  }
  const aim = getTouchAimDir();
  return { tx: px + aim.dx, ty: py + aim.dy };
}

// ==================== 敌人系统 ====================
// 怪物数量上限（[PLACEHOLDER] 待 playtest 校准）：在性能预算内让地下有"压迫感"
const ENEMY_MAX_TOTAL = 18;        // 同一时刻最多存活怪物总数（原10；怪 AI 极简，可上探）
const ENEMY_MAX_SURFACE = 5;       // 地表（夜晚）上限（原4）
const ENEMY_MAX_UNDERGROUND = 14;  // 地下/黑暗环境上限（原7；地下是新怪主场，应更密）
// 地下刷怪节奏（[PLACEHOLDER]）：每帧尝试概率 + 仅约束"生成点本身"的无光源判定半径
const UNDERGROUND_SPAWN_CHANCE = 0.02; // 每帧地下刷怪尝试概率（原0.008，提速填满上限）
const SPAWN_DARK_RADIUS = 2;          // 生成点周围无发光方块判定半径（只约束生成点，不约束玩家个人照明）

function updateEnemies(dt) {
  const dts = dt / 16.67;
  const p = game.player;
  const pTy = Math.floor((p.y + p.h / 2) / TILE);
  const surfP = game.surface[Math.floor(p.x / TILE)] || WORLD_H * 0.35;

  // 夜晚（地表）生成敌人
  if (game.time > 0.5 && game.time < 0.95 &&
      game.enemies.length < ENEMY_MAX_SURFACE && game.enemies.length < ENEMY_MAX_TOTAL &&
      Math.random() < 0.004) {
    spawnEnemy(false);
  }

  // 地下/黑暗环境生成敌人：玩家身处地下（深度>地表+3）即按概率刷出。
  // 注意：刷怪点固定在屏幕外约 (cw/2+3) 格远，玩家个人照明（火把）照不到生成点，
  // 故不再用"玩家周围有无光源"决定是否刷怪（那会让带火把的玩家几乎永不遇怪）。
  // 生成点本身是否够暗，改由 spawnEnemy 内部对生成点做 SPAWN_DARK_RADIUS 检查兜底。
  if (game.enemies.length < ENEMY_MAX_UNDERGROUND && game.enemies.length < ENEMY_MAX_TOTAL &&
      pTy > surfP + 3 &&
      Math.random() < UNDERGROUND_SPAWN_CHANCE) {
    spawnEnemy(true);
  }

  for (let i = game.enemies.length - 1; i >= 0; i--) {
    const e = game.enemies[i];

    // 闪光弹眩晕：期间不移动/不攻击（AI 暂停，但物理与死亡检查照常）
    const stunned = e.stun && e.stun > 0;
    if (stunned) {
      e.stun -= dt;
      e.vx *= 0.8;
    }

    // AI：朝玩家移动
    const p = game.player;
    const dx = p.x - e.x;
    const dist = Math.abs(dx);

    if (!stunned && dist < 200 && dist > 20) {
      e.vx = (dx > 0 ? 1 : -1) * (e.speed || 1.5);
    } else if (!stunned) {
      e.vx *= 0.9;
    }

    // 跳跃（如果在地面碰到障碍）
    if (e.onGround && Math.abs(e.vx) > 0.5 && isSolid(
      Math.floor((e.x + (e.vx > 0 ? e.w + 2 : -2)) / TILE),
      Math.floor((e.y + e.h - 2) / TILE)
    )) {
      e.vy = -7;
    }

    // 物理
    moveEntity(e, dt);

    // 实体碰撞：与玩家接触（AABB 严格重叠判定）——眩晕敌人不造成伤害
    if (p.x < e.x + e.w && p.x + p.w > e.x && p.y < e.y + e.h && p.y + p.h > e.y) {
      if (p.invuln <= 0 && !stunned) {
        // 接触伤害 + 击退（伤害按怪物类型：史莱姆 8 / 蜘蛛 10 / 石魔像 16）
        p.health -= e.damage || 8;
        p.invuln = 800;
        p.lastDamageTime = performance.now();
        p.vx = (p.x < e.x ? -5 : 5);
        p.vy = -6;
        sfx('hurt');
      } else {
        // 无敌期间：把玩家推出怪物身体，避免直接穿过
        pushOutOf(p, e);
      }
    }

    // 删除死亡/掉出世界
    if (e.health <= 0 || e.y > WORLD_H * TILE) {
      game.enemies.splice(i, 1);
    }

    e.animPhase = (e.animPhase || 0) + dts * 0.15;
  }

  // 怪物之间互相碰撞：优先在 x 方向散开，避免堆叠在同一点 / 同一 x 列
  for (let i = 0; i < game.enemies.length; i++) {
    for (let j = i + 1; j < game.enemies.length; j++) {
      resolveOverlapAABB(game.enemies[i], game.enemies[j]);
    }
  }

  // 白天清除地表敌人（地下怪物身处黑暗，保留不被清除）
  if (game.time < 0.05 || game.time > 0.95) {
    for (let i = game.enemies.length - 1; i >= 0; i--) {
      const e = game.enemies[i];
      const eTy = Math.floor((e.y + e.h / 2) / TILE);
      const eSurf = game.surface[Math.floor(e.x / TILE)] || WORLD_H * 0.35;
      if (eTy <= eSurf + 2 && Math.random() < 0.02) game.enemies.splice(i, 1);
    }
  }
}

// 找一个与现有怪物不同 x（不同 tile 列）的空地，避免刷怪重叠 / 同列堆叠
function findFreeEnemyTileX(baseTx, side) {
  const occupied = new Set(game.enemies.map(e => Math.floor(e.x / TILE)));
  if (!occupied.has(baseTx)) return baseTx;
  for (let d = 1; d < 40; d++) {
    const c1 = baseTx + side * d;
    if (c1 >= 2 && c1 <= WORLD_W - 3 && !occupied.has(c1)) return c1;
    const c2 = baseTx - side * d;
    if (c2 >= 2 && c2 <= WORLD_W - 3 && !occupied.has(c2)) return c2;
  }
  return baseTx;
}

// 地下怪物类型表：按玩家所在深度（相对地表）分层——浅层刷蜘蛛（快），深层刷石魔像（肉）
// 属性均为 [PLACEHOLDER]，待 playtest 调整
const UNDERGROUND_ENEMY_TYPES = {
  spider: { name: '洞穴蜘蛛', health: 45, damage: 10, w: 26, h: 22, speed: 2.0, color: '#7a4a9a', minDepth: 4,  maxDepth: 60, weight: 70 },
  golem:  { name: '石魔像',   health: 90, damage: 16, w: 32, h: 32, speed: 1.0, color: '#8a8a92', minDepth: 30, maxDepth: 400, weight: 55 },
};

// 怪物显示名称（卡牌对战面板等）
const ENEMY_NAMES = { slime: '史莱姆', spider: '洞穴蜘蛛', golem: '石魔像' };

// 按深度加权随机选取地下怪物类型（越深越偏强怪）
function pickUndergroundType(depth) {
  const cands = Object.entries(UNDERGROUND_ENEMY_TYPES)
    .filter(([, t]) => depth >= t.minDepth && depth <= t.maxDepth);
  if (cands.length === 0) return 'slime'; // 极浅地下仍出史莱姆
  let total = 0;
  for (const [, t] of cands) total += t.weight;
  let roll = Math.random() * total;
  for (const [key, t] of cands) {
    roll -= t.weight;
    if (roll <= 0) return key;
  }
  return cands[cands.length - 1][0];
}

function spawnEnemy(underground) {
  const p = game.player;
  // 在玩家附近但屏幕外生成
  const side = Math.random() < 0.5 ? -1 : 1;
  const dist = (game.cw / TILE / 2 + 3) * TILE;
  let x = p.x + side * dist;
  let tx = Math.max(2, Math.min(WORLD_W - 3, Math.floor(x / TILE)));
  tx = findFreeEnemyTileX(tx, side); // 避免与现有怪物落在同一 x 列
  x = tx * TILE;

  let ty;
  if (underground) {
    // 在玩家所在深度附近寻找可站立（本格空、下方为实地）的非实心格
    const pTy = Math.floor((p.y + p.h / 2) / TILE);
    let placed = -1;
    for (let d = 0; d <= 14 && placed < 0; d++) {
      const candidates = d === 0 ? [pTy] : [pTy - d, pTy + d];
      for (const s of candidates) {
        if (s < 1 || s >= WORLD_H - 1) continue;
        if (!isSolid(tx, s) && isSolid(tx, s + 1)) { placed = s; break; }
      }
    }
    ty = placed >= 0 ? placed : pTy;
  } else {
    // 地表：找到地表后落在上方
    ty = 0;
    for (let yy = 0; yy < WORLD_H; yy++) {
      if (isSolid(tx, yy)) { ty = yy - 2; break; }
    }
  }

  // 选类型：地下按深度分层（蜘蛛/石魔像），地表始终史莱姆
  let type = 'slime';
  if (underground) {
    const surfP = game.surface[Math.floor(p.x / TILE)] || WORLD_H * 0.35;
    const depth = Math.max(0, Math.floor((p.y + p.h / 2) / TILE) - surfP);
    type = pickUndergroundType(depth);
  }
  const T = UNDERGROUND_ENEMY_TYPES[type] || null;
  const w = T ? T.w : 24, h = T ? T.h : 24;

  // 生成点本身若被光源照亮（如玩家在亮基地旁），放弃本次刷怪——避免亮处凭空出怪。
  // 仅约束生成点，不限制玩家个人照明（屏幕外生成点本就远离玩家火把）。
  if (underground && hasNearbyLight(tx, ty + 1, SPAWN_DARK_RADIUS)) return;

  game.enemies.push({
    x: x,
    y: underground ? (ty + 1) * TILE - h : ty * TILE,
    vx: 0, vy: 0,
    w: w, h: h,
    onGround: false,
    health: T ? T.health : 30,
    maxHealth: T ? T.health : 30,
    damage: T ? T.damage : 8,
    speed: T ? T.speed : 1.5,
    animPhase: 0,
    type: type,
    underground: !!underground,
  });
}

// ==================== 掉落物系统 ====================
function updateDroppedItems(dt) {
  const dts = dt / 16.67;
  const p = game.player;

  for (let i = game.droppedItems.length - 1; i >= 0; i--) {
    const item = game.droppedItems[i];
    if (!item.vx) item.vx = 0; // 兼容未设 vx 的掉落物（如敌人掉落），避免坐标变 NaN
    item.age = (item.age || 0) + dt; // 已存活时间（ms），用于拾取前的短暂保护

    // ===== 掉落物物理：重力 + 分离轴 AABB 碰撞（杜绝穿墙）=====
    // 掉落物为 8×8 像素，碰撞盒即自身。x/y 分离处理，撞到实心方块即贴边停下。
    const IW = 8, IH = 8;
    item.vy += GRAVITY * dts;
    const maxFall = (typeof item.maxFall === 'number') ? item.maxFall : MAX_FALL;
    if (item.vy > maxFall) item.vy = maxFall;

    // X 轴移动 + 碰撞（水平速度撞墙即停，不再穿墙）
    item.x += item.vx * dts;
    if (item.vx !== 0) {
      const minTx = Math.floor(item.x / TILE);
      const maxTx = Math.floor((item.x + IW - 1) / TILE);
      const minTy = Math.floor(item.y / TILE);
      const maxTy = Math.floor((item.y + IH - 1) / TILE);
      let hit = false;
      for (let ty = minTy; ty <= maxTy && !hit; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (isSolid(tx, ty)) {
            if (item.vx > 0) item.x = tx * TILE - IW;
            else item.x = (tx + 1) * TILE;
            item.vx = 0;
            hit = true;
            break;
          }
        }
      }
    }

    // Y 轴移动 + 碰撞（落地/顶头即停）
    item.y += item.vy * dts;
    if (item.vy !== 0) {
      const minTx = Math.floor(item.x / TILE);
      const maxTx = Math.floor((item.x + IW - 1) / TILE);
      const minTy = Math.floor(item.y / TILE);
      const maxTy = Math.floor((item.y + IH - 1) / TILE);
      let hit = false;
      for (let ty = minTy; ty <= maxTy && !hit; ty++) {
        for (let tx = minTx; tx <= maxTx; tx++) {
          if (isSolid(tx, ty)) {
            if (item.vy > 0) { item.y = ty * TILE - IH; item.vy = 0; }
            else { item.y = (ty + 1) * TILE; item.vy = 0; }
            hit = true;
            break;
          }
        }
      }
    }
    item.vx *= 0.9;

    // 硫磺弹/闪光弹：倒计时引爆
    if (item.isBomb) {
      item.fuse -= dt;
      if (item.fuse <= 0) {
        if (item.id === 78) {
          flashBang(item.x, item.y);
        } else {
          explode(item.x, item.y, 3);
        }
        game.droppedItems.splice(i, 1);
        continue;
      }
    }

    item.life -= dt;

    // 掉落物坠入岩浆：燃烧焚毁 + 火焰粒子。岩浆不可靠近，物品若滞留其中既看不见也永远捡不回，
    // 明确"焚毁"让玩家知道东西没戏了，而不是困惑它为什么消失。
    if (getTile(Math.floor((item.x + 4) / TILE), Math.floor((item.y + 4) / TILE)) === 63) {
      spawnParticles(item.x + 4, item.y + 4, '#ffaa33', 6);
      spawnParticles(item.x + 4, item.y + 4, '#ff6622', 3);
      game.droppedItems.splice(i, 1);
      continue;
    }

    // 拾取（noPickup 的掉落物仅作视觉展示，不进背包，例如飘落的树叶）
    if (!item.noPickup) {
      const dx = (p.x + p.w / 2) - (item.x + 4);
      const dy = (p.y + p.h / 2) - (item.y + 4);
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24 && item.age > 50) {
        addItem(item.id, item.count);
        game.droppedItems.splice(i, 1);
        sfx('pickup');
        continue;
      }
    }

    if (item.life <= 0) game.droppedItems.splice(i, 1);
  }
}

// ==================== 粒子系统 ====================
const MAX_PARTICLES = 600; // 粒子数量上限（防战斗/挖矿密集时累积拖垮帧率）
function spawnParticles(x, y, color, count) {
  if (game.particles.length >= MAX_PARTICLES) return; // 已达上限，丢弃新粒子
  const n = Math.min(count, MAX_PARTICLES - game.particles.length); // 截断到剩余容量
  for (let i = 0; i < n; i++) {
    game.particles.push({
      x, y,
      vx: (Math.random() - 0.5) * 6,
      vy: (Math.random() - 0.5) * 6 - 2,
      life: 0.5 + Math.random() * 0.5,
      maxLife: 0.5 + Math.random() * 0.5,
      size: 2 + Math.random() * 4,
      color,
      gravity: 0.3,
    });
  }
}

function updateParticles(dt) {
  const dts = dt / 16.67;
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const p = game.particles[i];
    p.vy += p.gravity * dts;
    p.x += p.vx * dts;
    p.y += p.vy * dts;
    p.vx *= 0.96;
    p.life -= dt / 1000;
    if (p.life <= 0) game.particles.splice(i, 1);
  }
}

// ==================== 主更新循环 ====================
// 流体模拟：基于元胞自动机的水位扩散（向下流 + 横向铺开），水位范围 0~4
// 流体统一步进：仅遍历“含流体”的活跃格（active set），代价与水量成正比，与世界尺寸解耦。
// updateWater/updateLava 每拍只跑这一份逻辑，避免整张世界网格遍历导致帧率崩塌。
// 流体统一步进（双缓冲元胞自动机）：
//  - 整拍只读快照 levels，所有改动写入 buf（净增量），提交时一次性回写，杜绝“同拍级联”→ 波浪/震荡
//  - 横向两侧对称外流（各 1 格），消除处理顺序带来的单向偏移（行波）
function stepFluid(levels, blockId, isLava) {
  const W = WORLD_W, H = WORLD_H, world = game.world;
  let active = isLava ? game._lavaActive : game._waterActive;
  if (!active) {
    active = new Set();
    for (let i = 0; i < levels.length; i++) if (levels[i] > 0) active.add(i);
    if (isLava) game._lavaActive = active; else game._waterActive = active;
  }
  const buf = isLava
    ? (game._lavaBuf || (game._lavaBuf = new Int8Array(W * H)))
    : (game._waterBuf || (game._waterBuf = new Int8Array(W * H)));
  buf.fill(0);
  const next = new Set();
  const dirty = new Set(); // 本拍发生过水量变化的格子，提交时统一刷新
  for (const i of active) {
    const c = levels[i];
    if (c <= 0) continue;
    if (game.bucketFluid && game.bucketFluid.has(i)) continue; // 桶倒出的流体静止不动，不扩散（守恒、不通胀）

    const x = i % W, y = (i / W) | 0;
    let rem = c; // 本格“流出后剩余”预算
    let flowedDown = false;
    // 向下流（写入 buf，不直接改 levels）
    if (y + 1 < H) {
      const d = i + W;
      const wb = world[d];
      if (isLava && wb === 12) {
        // 落水 → 黑曜石：消耗本格全部岩浆，互不污染 level 数组
        world[d] = 25;
        if (game.waterLevels) game.waterLevels[d] = 0;
        if (game._waterActive) game._waterActive.delete(d);
        buf[i] -= c; dirty.add(i);
        rem = 0; flowedDown = true;
      } else if (wb === 0 && levels[d] === 0) {
        const f = Math.min(rem, isLava ? 1 : c); // 水落入空气整格下移；岩浆粘稠每拍只下移 1 级
        if (f > 0) { buf[d] += f; buf[i] -= f; dirty.add(d); dirty.add(i); next.add(d); rem -= f; flowedDown = true; }
      } else if (levels[d] > 0 && levels[d] < 4) {
        const f = Math.min(rem, isLava ? 1 : Math.ceil((c - levels[d]) / 2)); // 与下方水均流
        if (f > 0 && levels[d] < c) { buf[d] += f; buf[i] -= f; dirty.add(d); dirty.add(i); rem -= f; flowedDown = true; }
      }
    }
    // 向两侧流：仅当下方被挡（形成水洼）、本格水量达标；两侧各 1 格对称外流（满级才外溢）
    const canSide = isLava ? (c === 4 && !flowedDown) : (rem > 0 && c >= 2);
    if (canSide) {
      const give = 1; // 每侧每拍最多 1 级，避免单向灌水产生行波
      const nbrs = [];
      if (x > 0) nbrs.push(i - 1);
      if (x < W - 1) nbrs.push(i + 1);
      for (const n of nbrs) {
        const nl = levels[n], nb = world[n];
        if (isLava && nb === 12) {
          world[n] = 25;
          if (game.waterLevels) game.waterLevels[n] = 0;
          if (game._waterActive) game._waterActive.delete(n);
          buf[i] -= c; dirty.add(i);
          rem = 0; break;
        }
        if (nl === 0 && nb === 0) {
          const f = Math.min(rem, give);
          if (f > 0) { buf[n] += f; buf[i] -= f; dirty.add(n); dirty.add(i); next.add(n); rem -= f; }
        } else if (nl > 0 && nl < 4) {
          // 流入已有水邻居：用 floor((c-nl)/2)，差 1 级时得 0 → 不流动，消除相邻格永久来回交换(seesaw)的波浪
          if (nl < c) { const f = Math.min(rem, Math.floor((c - nl) / 2)); if (f > 0) { buf[n] += f; buf[i] -= f; dirty.add(n); dirty.add(i); rem -= f; } }
        }
      }
    }
    if (rem > 0) next.add(i); // 仍有水的格保留在活跃集中（可响应后续邻居变化）
  }
  // 提交：把净增量回写 levels，并刷新 world 中变动的格子
  // 关键修复：流体流动本应只经 setTile 写入 world，但 stepFluid 必须保留分级水位(0~4)，
  // 不能直接用 setTile（它会强制把流体设为满级4，破坏模拟）。故在此手动同步 lightSet 与
  // tileCache.dirty：否则岩浆流动后「旧位置假光源残留(叠加→地下过亮)+新位置漏光(光晕错位)」，
  // 且 world 已变而画面不刷新。水(blockId=12)本身 light=0，对 lightSet 无副作用。
  for (const i of dirty) {
    let v = levels[i] + buf[i];
    if (v < 0) v = 0; else if (v > 4) v = 4;
    if (v !== levels[i]) {
      levels[i] = v;
      const willHave = v > 0;
      const had = (world[i] === blockId);
      if (willHave !== had) {
        if (game.lightSet) { if (willHave) game.lightSet.add(i); else game.lightSet.delete(i); }
        if (game.tileCache && game.tileCache.dirty) game.tileCache.dirty.add(i);
      }
      world[i] = willHave ? blockId : 0;
    }
  }
  if (isLava) game._lavaActive = next; else game._waterActive = next;
}

// 由分级数组重建流体活跃集（生成世界 / 读取存档后调用一次）
function rebuildFluidActive() {
  game._waterActive = new Set();
  game._lavaActive = new Set();
  const wlv = game.waterLevels, llv = game.lavaLevels;
  for (let i = 0; i < wlv.length; i++) {
    if (wlv[i] > 0) game._waterActive.add(i);
    if (llv[i] > 0) game._lavaActive.add(i);
  }
}

function updateWater() {
  stepFluid(game.waterLevels, 12, false);
}

// 岩浆流体模拟（与 updateWater 同源的元胞自动机，但更粘稠，且遇水生成黑曜石）
// 与水同步在每 ~90ms 调用一次；粘稠体现在：每 tick 仅下移/外溢 1 级，且侧流仅在满级(c===4)时触发
function updateLava() {
  stepFluid(game.lavaLevels, 63, true);
}

// ==================== 植物生长系统 ====================
// 地表泥土是否被“暴露”：上方为非固体且非水的方块（空气/树叶/火把等）；埋在地下或被水盖住的泥土不蔓延草
function isSurfaceExposed(x, y) {
  const above = getTile(x, y - 1);
  if (above === 12) return false;             // 水下方不蔓延
  const b = BLOCKS[above];
  return !b || !b.solid;                       // 空气(0)或落叶/火把等非固体 → 暴露
}

// 四邻是否存在草地（id 1）
function hasGrassNeighbor(x, y) {
  return getTile(x + 1, y) === 1 || getTile(x - 1, y) === 1 ||
         getTile(x, y + 1) === 1 || getTile(x, y - 1) === 1;
}

// 重建草蔓延前沿：扫描全图，把所有“与草地相邻且暴露的泥土”加入集合（载入/生成世界后调用一次）
function rebuildGrassFrontier() {
  game.grassFrontier = new Set();
  for (let y = 0; y < WORLD_H; y++) {
    for (let x = 0; x < WORLD_W; x++) {
      if (getTile(x, y) === 2 && isSurfaceExposed(x, y) && hasGrassNeighbor(x, y)) {
        game.grassFrontier.add(y * WORLD_W + x);
      }
    }
  }
}

// 草蔓延：从前沿集合取若干泥土草化为草地，并补入其泥土邻居
function spreadGrass() {
  const f = game.grassFrontier;
  if (!f || f.size === 0) return;
  const arr = Array.from(f);
  // 随机洗牌，避免蔓延方向偏置（左上→右下）
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  let converted = 0;
  for (let i = 0; i < arr.length && converted < GRASS_SPREAD_PER_TICK; i++) {
    const key = arr[i];
    const tx = key % WORLD_W;
    const ty = (key / WORLD_W) | 0;
    if (getTile(tx, ty) !== 2) { f.delete(key); continue; }
    if (!isSurfaceExposed(tx, ty) || !hasGrassNeighbor(tx, ty)) { f.delete(key); continue; }
    setTile(tx, ty, 1);                  // 本环境变化不触发联机同步（仅本地可见的缓慢生长）
    f.delete(key);
    // 邻接泥土补入前沿
    if (tx + 1 < WORLD_W && getTile(tx + 1, ty) === 2 && isSurfaceExposed(tx + 1, ty)) f.add(ty * WORLD_W + tx + 1);
    if (tx - 1 >= 0      && getTile(tx - 1, ty) === 2 && isSurfaceExposed(tx - 1, ty)) f.add(ty * WORLD_W + tx - 1);
    if (ty + 1 < WORLD_H && getTile(tx, ty + 1) === 2 && isSurfaceExposed(tx, ty + 1)) f.add((ty + 1) * WORLD_W + tx);
    if (ty - 1 >= 0      && getTile(tx, ty - 1) === 2 && isSurfaceExposed(tx, ty - 1)) f.add((ty - 1) * WORLD_W + tx);
    converted++;
  }
}

// 树苗生长：种植满 SAPLING_GROW_DAYS 天且头顶有空间则长成树
function growSaplings() {
  const m = game.saplings;
  if (!m || m.size === 0) return;
  for (const [key, plantedDay] of m) {
    if ((game.day + game.time) - plantedDay < SAPLING_GROW_DAYS) continue;
    const tx = key % WORLD_W;
    const ty = (key / WORLD_W) | 0;
    if (getTile(tx, ty) !== 64) { m.delete(key); continue; } // 已被挖掉/覆盖
    if (canGrowTree(tx, ty)) {
      buildTree(tx, ty);
      m.delete(key);
    }
    // 空间不足则保留，等腾出再长
  }
}

// 头顶到树冠区域需为空气，避免顶到天花板/建筑里
function canGrowTree(tx, ty) {
  // 头顶到树干顶需为空气（检查到 TREE_MAX_H，比原 TREE_MAX_H+1 宽松一格，避免“略挤就不发芽”）
  for (let i = 1; i <= TREE_MAX_H; i++) {
    const yy = ty - i;
    if (yy < 0) return false;
    if (getTile(tx, yy) !== 0) return false; // 仅允许空气
  }
  for (let dx = -2; dx <= 2; dx++) {
    const id = getTile(tx + dx, ty - TREE_MAX_H);
    if (id !== 0 && id !== 5) return false;
  }
  return true;
}

// 在树苗位置生成一棵小树（树干=原木4，树冠=树叶5）；环境生长不触发联机同步
function buildTree(tx, ty) {
  const H = TREE_MIN_H + ((Math.random() * (TREE_MAX_H - TREE_MIN_H + 1)) | 0);
  setTile(tx, ty, 4); // 树苗格本身变为树干底
  for (let i = 1; i <= H; i++) setTile(tx, ty - i, 4);
  const crownY = ty - H;
  for (let dy = -2; dy <= 1; dy++) {
    const width = (dy === -2) ? 2 : (dy === 1 ? 1 : 2);
    for (let dx = -width; dx <= width; dx++) {
      const px = tx + dx, py = crownY + dy;
      if (px < 0 || px >= WORLD_W || py < 0 || py >= WORLD_H) continue;
      if (getTile(px, py) === 0) setTile(px, py, 5);
    }
  }
  if (crownY - 1 >= 0 && getTile(tx, crownY - 1) === 0) setTile(tx, crownY - 1, 5);
  spawnParticles(tx * TILE + TILE / 2, ty * TILE, '#5fd850', 6);
}

function update(dt) {
  // 昼夜
  game.time += dt / 1000 / game.dayLength;
  if (game.time >= 1) { game.time -= 1; game.day++; } // 走满一天 → 天数 +1（驱动树苗生长）

  // 植物生长定时触发（与帧率解耦，用累加器节流）
  game._plantAccum += dt;
  if (game._plantAccum >= 1000) { game._plantAccum = 0; growSaplings(); }     // 每秒体检一次树苗
  game._grassAccum += dt;
  if (game._grassAccum >= GRASS_SPREAD_INTERVAL) { game._grassAccum = 0; spreadGrass(); } // 草缓慢蔓延

  // 昼夜切换音效（白天<->夜晚）
  const ph = game.time < 0.5 ? 0 : 1;
  if (game._phase === undefined) game._phase = ph;
  else if (ph !== game._phase) {
    game._phase = ph;
    if (window.Sound) Sound.play(ph ? 'night' : 'day');
  }

  // 音频系统每帧推进（环境/动态音乐，随昼夜变化）
  if (window.Sound) Sound.update(dt, game.time);

  updatePlayer(dt);
  updateRemotePlayers(dt);
  updateEnemies(dt);
  updateDroppedItems(dt);
  updateParticles(dt);

  // 全屏白闪衰减（闪光弹效果，约 0.3 秒淡出）
  if (game.flashAlpha > 0) {
    game.flashAlpha = Math.max(0, game.flashAlpha - dt / 1000 * 3.2);
  }

  // 流体（水 + 岩浆）模拟：节流到约每 90ms 一次，水与岩浆同步更新
  game._waterAcc = (game._waterAcc || 0) + dt;
  if (game._waterAcc >= 90) {
    game._waterAcc = 0;
    updateWater();
    updateLava();
  }

  // 摄像机跟随
  const targetCamX = game.player.x + game.player.w / 2 - game.cw / 2;
  const targetCamY = game.player.y + game.player.h / 2 - game.ch / 2;
  game.camX += (targetCamX - game.camX) * 0.1;
  game.camY += (targetCamY - game.camY) * 0.1;
  game.camX = Math.max(0, Math.min(WORLD_W * TILE - game.cw, game.camX));
  game.camY = Math.max(0, Math.min(WORLD_H * TILE - game.ch, game.camY));

  // 更新鼠标世界坐标
  game.mouse.worldX = game.camX + game.mouse.x;
  game.mouse.worldY = game.camY + game.mouse.y;

  // 更新UI
  updateUI();

  // 联机：发送位置（节流约14次/秒）
  if (game.multiplayer.connected && game.multiplayer.myId !== null) {
    game.multiplayer.sendAccum += dt;
    if (game.multiplayer.sendAccum >= 70) {
      game.multiplayer.sendAccum = 0;
      const p = game.player;
      const mp = game.multiplayer;
      if (mp.ws && mp.ws.readyState === 1) {
        mp.ws.send(JSON.stringify({
          type: 'move',
          x: p.x, y: p.y, vx: p.vx, vy: p.vy,
          facing: p.facing, walkPhase: p.walkPhase, health: p.health,
        }));
      }
    }
  }
}

function findSafeSpawnColumn() {
  const cx = WORLD_W >> 1;
  const isSafe = (tx) => {
    if (tx < 2 || tx > WORLD_W - 3) return false;
    const sy = game.surface[tx];
    if (sy == null || sy < 2 || sy >= WORLD_H - 3) return false;
    const top = game.world[sy * WORLD_W + tx];
    if (top === 12 || top === 63) return false;          // 地表本身不能是水/岩浆
    for (let d = 1; d <= 2; d++) {                        // 头顶 2 格须为空气（玩家站立/下落区）
      const t = game.world[(sy - d) * WORLD_W + tx];
      if (t !== 0) return false;
    }
    return true;
  };
  if (isSafe(cx)) return cx;
  for (let d = 1; d < WORLD_W / 2; d++) {
    if (isSafe(cx + d)) return cx + d;
    if (isSafe(cx - d)) return cx - d;
  }
  return cx; // 兜底：极端情况下仍用中央列
}

// 死亡惩罚：有几率从背包随机掉落物品（在死亡位置生成可拾取掉落物，玩家可跑回尸体处捡回）
// 每次每种只掉 1 个，掉落的物品种数随机在 [DEATH_DROP_MIN, DEATH_DROP_MAX] 区间。
const DEATH_DROP_CHANCE = 0.4;     // 触发概率（40%）
const DEATH_DROP_MIN = 1;          // 掉落物品种数下限
const DEATH_DROP_MAX = 2;          // 掉落物品种数上限
// 返回实际掉落的件数（0 = 没触发/没得掉），供 respawn 精确提示
function dropItemsOnDeath() {
  const p = game.player;
  const inv = game.inventory;
  if (!inv) return 0;
  // 收集背包中可掉落的物品（有货且是可拾取方块）
  const candidates = [];
  for (const [id, count] of Object.entries(inv)) {
    const bid = parseInt(id);
    if (count > 0 && BLOCKS[bid] && BLOCKS[bid].item) candidates.push(bid);
  }
  if (candidates.length === 0) return 0;

  // DEATH_DROP_CHANCE 触发掉落，掉 1-2 件
  if (Math.random() >= DEATH_DROP_CHANCE) return 0;
  const n = DEATH_DROP_MIN + Math.floor(Math.random() * (DEATH_DROP_MAX - DEATH_DROP_MIN + 1));

  // 洗牌取前 n 件（Fisher-Yates）
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
  let dropped = 0;
  for (let k = 0; k < Math.min(n, candidates.length); k++) {
    const id = candidates[k];
    if (!inv[id] || inv[id] <= 0) continue;
    removeItem(id, 1);
    game.droppedItems.push({
      x: cx + (Math.random() - 0.5) * 16,
      y: cy - 12,
      id, count: 1,
      vx: (Math.random() - 0.5) * 3, vy: -4,
      life: 60000, // 60 秒内可捡回
    });
    dropped++;
  }
  return dropped;
}

// 从床正上方一格起向上找第一个可站立格（该格空且上一格也空，确保站得下、不被卡头）
// 找不到（床上整列被填埋）→ 返回 null，由 respawn 回退默认出生列
function findBedStandCell(bedTx, bedTy) {
  for (let y = bedTy - 1; y >= 1; y--) {
    if (getTile(bedTx, y) === 0 && getTile(bedTx, y - 1) === 0) return { tx: bedTx, ty: y };
  }
  return null;
}

function respawn() {
  const p = game.player;
  // 坠出世界底部（虚空）死亡：掉落物会生成在无法到达的世界之下，必然丢失，故掉落惩罚跳过
  const fellOut = !!game._voidFall;
  game._voidFall = false;
  // 死亡惩罚：有几率从背包随机掉落（须在传送前调用，使用死亡坐标生成可拾回掉落物）
  const dropped = fellOut ? 0 : dropItemsOnDeath();
  // 床重生点优先：站床上方的站立空间；不可用则回退默认安全出生列
  let spawnTx, spawnTy;
  if (game.spawnPoint) {
    const cell = findBedStandCell(game.spawnPoint.tx, game.spawnPoint.ty);
    if (cell) { spawnTx = cell.tx; spawnTy = cell.ty; }
  }
  if (spawnTx === undefined) {
    spawnTx = findSafeSpawnColumn();
    spawnTy = game.surface[spawnTx] - 2;
  }
  p.x = spawnTx * TILE;
  p.y = spawnTy * TILE - p.h;
  p.vx = 0; p.vy = 0;
  p.health = p.maxHealth;
  p.oxygen = p.maxOxygen;
  p.invuln = 2000;
  game.enemies = [];
  if (fellOut) showToast('🕳️ 坠入了世界深渊，幸无物品损失', 2200);
  else if (dropped > 0) showToast(`☠️ 重生中：掉落了 ${dropped} 件物品（快回去捡！）`, 2600);
  else showToast('重生中...（背包物品完整保留）', 2000);
}

// ==================== 渲染系统 ====================
function render() {
  const ctx = game.ctx;

  // 天空
  drawSky(ctx);

  // 地图
  drawTiles(ctx);

  // 掉落物
  drawDroppedItems(ctx);

  // 敌人
  drawEnemies(ctx);

  // 其他联机玩家
  drawOtherPlayers(ctx);

  // 玩家
  drawPlayer(ctx);

  // 粒子
  drawParticles(ctx);

  // 光照
  drawLighting(ctx);

  // 挖掘进度
  drawMiningProgress(ctx);

  // 触屏挖掘指针：显示当前实际瞄准的挖掘/放置目标格（手机端用，替代桌面鼠标悬停框）
  drawTouchAimPointer(ctx);

  // 鼠标指示
  drawMouseTarget(ctx);

  // UI
  drawUI(ctx);

  // 全屏白闪覆盖（闪光弹致盲，画在 UI 之上达到"被闪"效果）
  if (game.flashAlpha > 0.01) {
    ctx.fillStyle = `rgba(255,255,255,${game.flashAlpha})`;
    ctx.fillRect(0, 0, game.cw, game.ch);
  }
}

function drawSky(ctx) {
  // 昼夜颜色
  const t = game.time;
  let r, g, b;
  if (t < 0.1) { // 黎明
    const k = t / 0.1;
    r = lerp(20, 100, k); g = lerp(20, 160, k); b = lerp(60, 220, k);
  } else if (t < 0.4) { // 白天
    r = 100; g = 160; b = 220;
  } else if (t < 0.5) { // 黄昏
    const k = (t - 0.4) / 0.1;
    r = lerp(100, 200, k); g = lerp(160, 100, k); b = lerp(220, 60, k);
  } else if (t < 0.6) { // 暮色
    const k = (t - 0.5) / 0.1;
    r = lerp(200, 20, k); g = lerp(100, 20, k); b = lerp(60, 60, k);
  } else { // 夜晚
    r = 15; g = 15; b = 40;
  }

  ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
  ctx.fillRect(0, 0, game.cw, game.ch);

  // 太阳/月亮
  const sunX = game.cw * (t * 2 - 0.5);
  const sunY = game.ch * 0.15 + Math.sin(t * Math.PI) * -30;
  if (t < 0.5) {
    ctx.fillStyle = `rgba(255,240,100,0.8)`;
    ctx.beginPath();
    ctx.arc(sunX, Math.max(20, sunY), 25, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const moonX = game.cw * ((t - 0.5) * 2 - 0.5);
    ctx.fillStyle = `rgba(200,200,220,0.8)`;
    ctx.beginPath();
    ctx.arc(moonX, Math.max(20, sunY), 18, 0, Math.PI * 2);
    ctx.fill();
  }

  // 星星（夜晚）：预渲染到离屏贴图（位置确定性），每帧 1 次 drawImage 替代 50 次 fillRect
  if (t > 0.55) {
    const starAlpha = Math.min(1, (t - 0.55) / 0.1);
    let stars = game._starsCanvas;
    if (!stars || stars.width !== game.cw || stars.height !== Math.ceil(game.ch * 0.5)) {
      stars = document.createElement('canvas');
      stars.width = game.cw;
      stars.height = Math.ceil(game.ch * 0.5);
      const sc = stars.getContext('2d');
      sc.fillStyle = 'rgba(255,255,255,1)';
      for (let i = 0; i < 50; i++) {
        const sx = (i * 73 + 13) % game.cw;
        const sy = (i * 37 + 7) % (game.ch * 0.5);
        sc.fillRect(sx, sy, 1.5, 1.5);
      }
      game._starsCanvas = stars;
    }
    ctx.globalAlpha = starAlpha * 0.6;
    ctx.drawImage(stars, 0, 0);
    ctx.globalAlpha = 1;
  }
}

// 方块表面纹理：让放置后的方块更有质感、彼此更易辨认
// 跳过已有专属精细渲染的方块（矿/水/岩浆/工作站/家具/光源等），避免叠加杂乱
const _SKIP_TEX = new Set([1,7,8,9,10,11,12,15,17,18,23,26,27,28,32,33,36,37,38,39,40,41,50,52,53,54,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81]);
// 金属类方块（锭块/金属砖/合金块）：统一光滑反光处理，靠各自颜色互相区分
const _METAL_TEX = new Set([19,20,21,29,30,31,34,35,42,43,44,45,46,47,48,49,51,55]);

function drawBlockSurface(ctx, id, sx, sy, tx, ty, block) {
  if (_SKIP_TEX.has(id)) return;
  const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0; // 确定性伪随机（同格不闪烁）

  // 通用立体倒角：左上受光高亮、右下背光暗边，方块像立方体，相邻同块边界更清晰
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(sx, sy, TILE, 2);
  ctx.fillRect(sx, sy, 2, TILE);
  ctx.fillStyle = 'rgba(0,0,0,0.20)';
  ctx.fillRect(sx, sy + TILE - 2, TILE, 2);
  ctx.fillRect(sx + TILE - 2, sy, 2, TILE);

  const shade = block.shade || block.color;

  // 金属块：斜向高光 + 四角铆钉，呈现光滑反光质感
  if (_METAL_TEX.has(id)) {
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(sx + 3, sy + TILE - 3);
    ctx.lineTo(sx + TILE - 6, sy + 3);
    ctx.lineTo(sx + TILE - 3, sy + 3);
    ctx.lineTo(sx + 6, sy + TILE - 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const r = 1.5;
    ctx.fillRect(sx + 3, sy + 3, r, r);
    ctx.fillRect(sx + TILE - 5, sy + 3, r, r);
    ctx.fillRect(sx + 3, sy + TILE - 5, r, r);
    ctx.fillRect(sx + TILE - 5, sy + TILE - 5, r, r);
    return;
  }

  switch (id) {
    case 2: { // 泥土：颗粒感
      ctx.fillStyle = shade;
      for (let i = 0; i < 6; i++) {
        const px = sx + 3 + ((h >> (i*3)) & 0x0f) % (TILE - 6);
        const py = sy + 3 + ((h >> (i*3+2)) & 0x0f) % (TILE - 6);
        ctx.fillRect(px, py, 2, 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(sx + 4 + (h & 7), sy + 5 + ((h>>4)&7), 2, 1);
      break;
    }
    case 3: { // 石头：斑驳 + 裂纹
      ctx.fillStyle = shade;
      for (let i = 0; i < 5; i++) {
        const px = sx + 2 + ((h >> (i*3)) & 0x0f) % (TILE - 5);
        const py = sy + 2 + ((h >> (i*3+1)) & 0x0f) % (TILE - 5);
        ctx.fillRect(px, py, 2, 2);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + 11, sy + 14); ctx.lineTo(sx + 17, sy + 20);
      ctx.stroke();
      break;
    }
    case 4: { // 原木：竖纹 + 年轮
      ctx.fillStyle = shade;
      for (let i = 0; i < 3; i++) ctx.fillRect(sx + 4 + i * 7, sy + 2, 2, TILE - 4);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(sx + TILE/2 - 1, sy + 4, 2, TILE - 8);
      break;
    }
    case 6: { // 沙子：细密点
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let i = 0; i < 10; i++) {
        const px = sx + 2 + ((h >> (i*2)) & 0x1f) % (TILE - 4);
        const py = sy + 2 + ((h >> (i*2+1)) & 0x1f) % (TILE - 4);
        ctx.fillRect(px, py, 1, 1);
      }
      break;
    }
    case 13: { // 木板：横纹 + 端纹
      ctx.fillStyle = shade;
      ctx.fillRect(sx, sy + Math.floor(TILE/2) - 1, TILE, 2);
      ctx.fillRect(sx + 2, sy + 4, 2, TILE - 8);
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(sx + 6, sy + 6, TILE - 12, 1);
      break;
    }
    case 14:   // 石砖
    case 22: { // 红砖：砖缝网格（错缝）
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(sx, sy + Math.floor(TILE/2) - 1, TILE, 2);
      ctx.fillRect(sx + Math.floor(TILE/2) - 1, sy, 2, Math.floor(TILE/2));
      ctx.fillRect(sx + Math.floor(TILE/4) - 1, sy + Math.floor(TILE/2), 2, Math.floor(TILE/2));
      ctx.fillRect(sx + Math.floor(3*TILE/4) - 1, sy + Math.floor(TILE/2), 2, Math.floor(TILE/2));
      break;
    }
    case 16: { // 玻璃：亮框 + 斜高光
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx + 1.5, sy + 1.5, TILE - 3, TILE - 3);
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(sx + 4, sy + 4, 2, TILE - 8);
      break;
    }
    case 25: { // 黑曜石：紫蓝发光脉
      ctx.strokeStyle = 'rgba(120,90,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + 3, sy + TILE - 4); ctx.lineTo(sx + TILE - 6, sy + 5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(80,200,255,0.25)';
      ctx.fillRect(sx + 6, sy + 6, 2, 2);
      break;
    }
    case 5: { // 树叶：斑驳叶簇
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (let i = 0; i < 6; i++) {
        const px = sx + 3 + ((h >> (i*3)) & 0x0f) % (TILE - 6);
        const py = sy + 3 + ((h >> (i*3+2)) & 0x0f) % (TILE - 6);
        ctx.fillRect(px, py, 2, 2);
      }
      ctx.fillStyle = 'rgba(120,230,90,0.5)';
      ctx.fillRect(sx + 5 + (h&3), sy + 6 + ((h>>3)&3), 2, 2);
      break;
    }
    case 24: { // 冰：裂纹 + 高光
      ctx.strokeStyle = 'rgba(220,245,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx + 4, sy + 4); ctx.lineTo(sx + 12, sy + 14); ctx.lineTo(sx + 18, sy + 10);
      ctx.stroke();
      break;
    }
    default: { // 兜底：浅色噪点，避免纯色块太平
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(sx + 4 + (h & 7), sy + 4 + ((h>>3)&7), 2, 2);
      ctx.fillRect(sx + 12 + ((h>>5)&7), sy + 10 + ((h>>8)&7), 2, 2);
    }
  }
}

// ==================== 瓦片渲染缓存（帧率优化核心） ====================
// 世界静态层画到离屏 canvas，每帧只 drawImage 一次（约 1 次绘制 vs 原来 3 万次逐格调用）。
// 玩家移动：缓存内平移复用 + 只补画新露出的边缘；方块变化：只重绘脏格。
// 注：熔炉火焰/水波等含 performance.now() 的动态细节在缓存中会"冻结"——这些格子已标记为动态
// 强制每次走脏格重绘（见 _DYN_TILES），保证动态方块保持动画。
const TILE_CACHE_MARGIN = 5;      // 缓存四周余量（格）：玩家移出余量才触发全量重建
const _DYN_TILES = new Set([15, 18, 12, 63]); // 火把/熔炉/水/岩浆——动态方块每次重绘保持动画

// 玩家是否处于地下（判定与刷怪/光照一致：玩家中心深度 > 地表 + 3 格）
function isPlayerUnderground() {
  const p = game.player;
  if (!p) return false;
  const pTy = Math.floor((p.y + p.h / 2) / TILE);
  const surf = game.surface[Math.floor(p.x / TILE)] || WORLD_H * 0.35;
  return pTy > surf + 3;
}

// 地下渲染垂直窗口（格）：玩家在地下时只限制【垂直方向】的渲染深度——
// 上方可见 UP 格、下方可见 DOWN 格，水平方向保持视口全宽（不裁剪左右视野）。
// 效果：地表玩家脚下 DOWN=22 格正好覆盖视口下半（完整俯瞰地下剖面，"在地表加载地下的渲染"）；
// 地下时垂直窗口 14+22+1=37 格 < 视口 45 格，上下边缘用深色遮罩（省约 18% 绘制）。
const UNDERGROUND_VIEW_UP = 14;   // [PLACEHOLDER]：玩家上方可见格数（洞穴天花板通常 <14 格）
const UNDERGROUND_VIEW_DOWN = 22; // [PLACEHOLDER]：玩家下方可见格数（=视口半高，保证地表俯瞰完整）

// 地下渲染：深色"黑暗岩层"背景 + 垂直深度窗口内绘制方块（帧率优化）
// 水平全宽（视口左右完整），只裁垂直方向超出窗口的区域。
// 不经过瓦片缓存（地下挖矿高频变化，且绘制量已减少；从地下回到地表时缓存强制重建）
function drawUndergroundTiles(ctx) {
  // 背景：窗口外未绘制的视口区域铺深岩色，配合 drawLighting 的暗层呈现"未探索的黑暗"
  ctx.fillStyle = 'rgba(30,30,38,1)';
  ctx.fillRect(0, 0, game.cw, game.ch);

  const p = game.player;
  const pTy = Math.floor((p.y + p.h / 2) / TILE);
  // 垂直窗口：玩家上方 UP 格 ～ 玩家下方 DOWN 格（clamp 世界边界）
  const startTy = Math.max(0, pTy - UNDERGROUND_VIEW_UP);
  const endTy = Math.min(WORLD_H - 1, pTy + UNDERGROUND_VIEW_DOWN);
  // 水平：视口全宽（不裁剪）
  const startTx = Math.max(0, Math.floor(game.camX / TILE));
  const endTx = Math.min(WORLD_W - 1, Math.ceil((game.camX + game.cw) / TILE));
  const world = game.world;
  for (let ty = startTy; ty <= endTy; ty++) {
    const rowBase = ty * WORLD_W;
    for (let tx = startTx; tx <= endTx; tx++) {
      const id = world[rowBase + tx];
      if (id === 0) continue;
      drawTilesDirect(ctx, tx, ty, Math.floor(tx * TILE - game.camX), Math.floor(ty * TILE - game.camY));
    }
  }
}

function drawTiles(ctx) {
  // 地下：减少渲染（玩家周围 R 格 + 深色背景），帧率优化；地表走全视口瓦片缓存（不变）
  if (isPlayerUnderground()) {
    game._lastUnderground = true;
    drawUndergroundTiles(ctx);
    return;
  }
  // 刚从地下回到地表：缓存已过期（地下期间方块变化走单格绘制，未入缓存）→ 强制全量重建
  if (game._lastUnderground) {
    game._lastUnderground = false;
    if (game.tileCache) {
      game.tileCache.anchorTx = -1; // 触发重建
      if (game.tileCache.dirty) game.tileCache.dirty.clear(); // 丢弃地下期间累积的脏格
    }
  }

  const startTx = Math.max(0, Math.floor(game.camX / TILE));
  const endTx = Math.min(WORLD_W - 1, Math.ceil((game.camX + game.cw) / TILE));
  const startTy = Math.max(0, Math.floor(game.camY / TILE));
  const endTy = Math.min(WORLD_H - 1, Math.ceil((game.camY + game.ch) / TILE));
  const viewW = endTx - startTx + 1;
  const viewH = endTy - startTy + 1;

  // 初始化/尺寸变化时重建缓存
  let tc = game.tileCache;
  if (!tc || !tc.canvas || tc.viewW !== viewW || tc.viewH !== viewH) {
    tc = {
      canvas: document.createElement('canvas'),
      ctx: null,
      viewW, viewH,
      anchorTx: -1, anchorTy: -1, // 缓存覆盖区域的左上角瓦片坐标
      dirty: new Set(),
    };
    tc.canvas.width = (viewW + TILE_CACHE_MARGIN * 2) * TILE;
    tc.canvas.height = (viewH + TILE_CACHE_MARGIN * 2) * TILE;
    tc.ctx = tc.canvas.getContext('2d');
    game.tileCache = tc;
  }
  const cctx = tc.ctx;

  const wantAnchorTx = startTx - TILE_CACHE_MARGIN;
  const wantAnchorTy = startTy - TILE_CACHE_MARGIN;
  const needRebuild = tc.anchorTx < 0;

  if (needRebuild ||
      Math.abs(wantAnchorTx - tc.anchorTx) >= TILE_CACHE_MARGIN ||
      Math.abs(wantAnchorTy - tc.anchorTy) >= TILE_CACHE_MARGIN) {
    // 全量重建：整个缓存区重画
    tc.anchorTx = wantAnchorTx;
    tc.anchorTy = wantAnchorTy;
    cctx.clearRect(0, 0, tc.canvas.width, tc.canvas.height);
    const cStartTx = Math.max(0, tc.anchorTx);
    const cStartTy = Math.max(0, tc.anchorTy);
    const cEndTx = Math.min(WORLD_W - 1, tc.anchorTx + viewW + TILE_CACHE_MARGIN * 2 - 1);
    const cEndTy = Math.min(WORLD_H - 1, tc.anchorTy + viewH + TILE_CACHE_MARGIN * 2 - 1);
    for (let ty = cStartTy; ty <= cEndTy; ty++) {
      for (let tx = cStartTx; tx <= cEndTx; tx++) {
        const sx = (tx - tc.anchorTx) * TILE;
        const sy = (ty - tc.anchorTy) * TILE;
        drawTilesDirectOnCache(cctx, tx, ty, sx, sy);
      }
    }
    tc.dirty.clear();
    // 首次全量后直接输出，跳过脏格
    ctx.drawImage(tc.canvas,
      (startTx - tc.anchorTx) * TILE, (startTy - tc.anchorTy) * TILE, viewW * TILE, viewH * TILE,
      Math.floor(startTx * TILE - game.camX), Math.floor(startTy * TILE - game.camY), viewW * TILE, viewH * TILE);
    return;
  }

  // 脏格重绘（含动态方块——每次都标记，保证火焰/水波动画）
  // 只扫视口范围内（而非整个缓存），把扫描开销压到最小
  const world = game.world;
  for (let ty = startTy; ty <= endTy; ty++) {
    for (let tx = startTx; tx <= endTx; tx++) {
      const id = world[ty * WORLD_W + tx];
      if (_DYN_TILES.has(id)) tc.dirty.add(ty * WORLD_W + tx);
    }
  }
  const cwTiles = viewW + TILE_CACHE_MARGIN * 2; // 缓存宽（格）
  if (tc.dirty.size > 0) {
    // 重画脏格 + 其邻居（边缘判定依赖邻居类型）
    const toRedraw = new Set();
    for (const idx of tc.dirty) {
      const tx = idx % WORLD_W, ty = Math.floor(idx / WORLD_W);
      for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = tx + dx, ny = ty + dy;
        if (nx < tc.anchorTx || ny < tc.anchorTy) continue;
        if (nx >= tc.anchorTx + cwTiles || ny >= tc.anchorTy + viewH + TILE_CACHE_MARGIN * 2) continue;
        toRedraw.add(ny * WORLD_W + nx);
      }
    }
    tc.dirty.clear();
    for (const idx of toRedraw) {
      const tx = idx % WORLD_W, ty = Math.floor(idx / WORLD_W);
      const sx = (tx - tc.anchorTx) * TILE;
      const sy = (ty - tc.anchorTy) * TILE;
      cctx.clearRect(sx, sy, TILE, TILE);
      drawTilesDirectOnCache(cctx, tx, ty, sx, sy);
    }
  }

  // 缓存 → 主画布（每帧一次 drawImage）
  ctx.drawImage(tc.canvas,
    (startTx - tc.anchorTx) * TILE, (startTy - tc.anchorTy) * TILE, viewW * TILE, viewH * TILE,
    Math.floor(startTx * TILE - game.camX), Math.floor(startTy * TILE - game.camY), viewW * TILE, viewH * TILE);
}

// 画单格到缓存画布：把动态方块（火焰/水波）强制重画，其余正常
function drawTilesDirectOnCache(cctx, tx, ty, sx, sy) {
  drawTilesDirect(cctx, tx, ty, sx, sy);
}

// 逐格直接渲染（单格）。由 drawTiles（缓存层）调用——绘制坐标已算好，只画 (tx,ty) 这一格
function drawTilesDirect(ctx, tx, ty, sx, sy) {
  const world = game.world;
  const id = world[ty * WORLD_W + tx];
  if (id === 0) return;

  {
    const rowBase = ty * WORLD_W;
    {
      const block = BLOCKS[id];

      // 主色
      ctx.fillStyle = block.color;
      ctx.fillRect(sx, sy, TILE, TILE);

      // 纹理变化
      const shade = getBlockShade(id, tx, ty);
      if (shade && shade.variation !== 0) {
        const v = shade.variation;
        if (v > 0) {
          ctx.fillStyle = `rgba(255,255,255,${Math.abs(v)})`;
        } else {
          ctx.fillStyle = `rgba(0,0,0,${Math.abs(v)})`;
        }
        ctx.fillRect(sx, sy, TILE, TILE);
      }

      // 矿石：矿岩 + 大块亮脉（确定性位置，不闪烁）
      if (id >= 7 && id <= 11 || id >= 36 && id <= 41 || id >= 66 && id <= 70) {
        const isCoal = (id === 7);
        const vein = isCoal ? '#a8a8a8' : block.shade;
        const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
        const mirror = (h & 1) === 1; // 相邻矿镜像，避免贴瓷砖感
        const spots = [
          [5, 4, 9, 9, true],
          [13, 11, 7, 6, false],
          [4, 14, 6, 6, false],
        ];
        for (const [bx, by, w, ht, dia] of spots) {
          const ox = mirror ? (TILE - bx - w) : bx;
          ctx.fillStyle = vein;
          if (dia) {
            const cx = sx + ox + w/2, cy = sy + by + ht/2;
            ctx.beginPath();
            ctx.moveTo(cx, cy - ht/2); ctx.lineTo(cx + w/2, cy);
            ctx.lineTo(cx, cy + ht/2); ctx.lineTo(cx - w/2, cy);
            ctx.closePath(); ctx.fill();
          } else {
            ctx.fillRect(sx + ox, sy + by, w, ht);
          }
          ctx.fillStyle = 'rgba(255,255,255,0.35)'; // 结晶高光
          ctx.fillRect(sx + ox + 1, sy + by + 1, 2, 2);
        }
        // 特殊矿强对比点缀
        if (id === 40) { ctx.fillStyle = '#e8e040'; ctx.fillRect(sx + 3, sy + TILE - 8, TILE - 6, 3); }
        if (id === 11) { ctx.fillStyle = 'rgba(220,255,255,0.85)'; ctx.fillRect(sx + 14, sy + 4, 2, 2); }
        if (id === 37) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(sx + 7, sy + 7, 2, 2); }
      }

      // 方块边缘：仅当与相邻方块类型不同时才画边框（同色大片区域省掉 stroke 调用——帧率优化）
      // 视觉上只保留"不同方块分界"的网格感，大片泥土/石头不再被 3000 次/帧的 strokeRect 拖累
      const idL = tx > 0 ? world[rowBase + tx - 1] : -1;
      const idR = tx < WORLD_W - 1 ? world[rowBase + tx + 1] : -1;
      const idU = ty > 0 ? world[(ty - 1) * WORLD_W + tx] : -1;
      const idD = ty < WORLD_H - 1 ? world[(ty + 1) * WORLD_W + tx] : -1;
      if (idL !== id || idR !== id || idU !== id || idD !== id) {
        ctx.strokeStyle = `rgba(0,0,0,0.15)`;
        ctx.lineWidth = 1;
        ctx.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
      }

      // 表面纹理（倒角 + 材质细节），让放置后的方块更立体、易辨认
      drawBlockSurface(ctx, id, sx, sy, tx, ty, block);

      // 草地顶部
      if (id === 1) {
        ctx.fillStyle = '#5fb850';
        ctx.fillRect(sx, sy, TILE, 3);
      }
      // 雪地顶部
      if (id === 23) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(sx, sy, TILE, 2);
      }
      // 火把
      if (id === 15) {
        ctx.fillStyle = '#6d4423';
        ctx.fillRect(sx + TILE/2 - 2, sy + TILE/4, 4, TILE * 3/4);
        ctx.fillStyle = '#ffcc40';
        ctx.beginPath();
        ctx.arc(sx + TILE/2, sy + TILE/4, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff8800';
        ctx.beginPath();
        ctx.arc(sx + TILE/2, sy + TILE/4, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // 树苗：底土嫩茎 + 两片小叶 + 顶芽
      if (id === 64) {
        ctx.fillStyle = '#5a3a1e';
        ctx.fillRect(sx + TILE / 2 - 1, sy + TILE - 9, 2, 9);            // 茎
        ctx.fillStyle = '#3fae3a';
        ctx.beginPath(); ctx.ellipse(sx + TILE / 2 - 4, sy + TILE - 10, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(sx + TILE / 2 + 4, sy + TILE - 12, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5fd850';
        ctx.beginPath(); ctx.arc(sx + TILE / 2, sy + TILE - 13, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      // 工作台：木作台 + 3x3 合成网格
      if (id === 17) {
        ctx.fillStyle = '#a87238';                       // 桌面亮带
        ctx.fillRect(sx, sy, TILE, 4);
        ctx.fillStyle = '#6e4620';                       // 台体暗部
        ctx.fillRect(sx, sy + TILE - 5, TILE, 5);
        const gx0 = sx + 4, gy0 = sy + 5, gw = TILE - 8, gh = TILE - 11;
        ctx.fillStyle = 'rgba(255,224,176,0.6)';        // 网格浅线
        ctx.fillRect(gx0 + Math.floor(gw/3), gy0, 1, gh);
        ctx.fillRect(gx0 + Math.floor(2*gw/3), gy0, 1, gh);
        ctx.fillRect(gx0, gy0 + Math.floor(gh/3), gw, 1);
        ctx.fillRect(gx0, gy0 + Math.floor(2*gh/3), gw, 1);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(gx0 + 0.5, gy0 + 0.5, gw - 1, gh - 1);
      }
      // 熔炉：石炉 + 闪烁炉火
      if (id === 18) {
        const flick = 0.5 + 0.5 * Math.sin(performance.now() / 180);
        ctx.fillStyle = '#3a2818';                       // 顶部炉盖
        ctx.fillRect(sx, sy, TILE, 4);
        const ox = sx + 6, oy = sy + 7, ow = TILE - 12, oh = TILE - 12;
        ctx.fillStyle = '#140a04';                        // 炉口内腔
        ctx.fillRect(ox, oy, ow, oh);
        ctx.fillStyle = `rgba(255,${110 + Math.floor(flick*60)},20,${0.7 + 0.3*flick})`; // 火焰
        ctx.fillRect(ox + 2, oy + 3, ow - 4, oh - 5);
        ctx.fillStyle = `rgba(255,200,80,${0.4 + 0.4*flick})`;                          // 火焰高光
        ctx.fillRect(ox + 3, oy + 4, ow - 6, 2);
        ctx.strokeStyle = '#2a1a10';                      // 炉口石框
        ctx.lineWidth = 1;
        ctx.strokeRect(ox + 0.5, oy + 0.5, ow - 1, oh - 1);
        ctx.fillStyle = '#1a0a04';                        // 底部灰烬
        ctx.fillRect(sx, sy + TILE - 3, TILE, 3);
      }
      // 水：按水位分级绘制（流体物理），露出水面线
      if (id === 12) {
        const lvl = game.waterLevels[ty * WORLD_W + tx] || 4;
        const wh = Math.max(4, Math.round((lvl / 4) * TILE)); // 水体高度
        const top = sy + (TILE - wh);
        // 整格淡蓝（背后的景物透出一点水感）
        ctx.fillStyle = 'rgba(40,96,168,0.55)';
        ctx.fillRect(sx, sy, TILE, TILE);
        // 水体本体
        ctx.fillStyle = block.color;
        ctx.fillRect(sx, top, TILE, wh);
        // 水面高光线
        ctx.fillStyle = 'rgba(150,205,255,0.55)';
        ctx.fillRect(sx, top, TILE, 2);
        // 细微波纹
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(sx + ((tx * 7 + ty * 3) % (TILE - 6)), top + 4, 4, 1);
      }
      // 岩浆：按岩浆量分级绘制（流体物理），露出熔岩面，深度越浅露出的底越多
      if (id === 63) {
        const l = game.lavaLevels[ty * WORLD_W + tx] || 4;
        const wh = Math.max(4, Math.round((l / 4) * TILE)); // 岩浆体高度
        const top = sy + (TILE - wh);
        // 暗红基底（整格）
        ctx.fillStyle = '#3a1205';
        ctx.fillRect(sx, sy, TILE, TILE);
        // 岩浆体
        ctx.fillStyle = block.color; // #e0581a
        ctx.fillRect(sx, top, TILE, wh);
        // 顶部熔岩亮面（橙黄）
        ctx.fillStyle = 'rgba(255,150,40,0.9)';
        ctx.fillRect(sx, top, TILE, 2);
        ctx.fillStyle = 'rgba(255,90,20,0.5)';
        ctx.fillRect(sx, top + 2, TILE, 2);
        // 底部辉光
        ctx.fillStyle = 'rgba(255,200,60,0.22)';
        ctx.fillRect(sx + 2, sy + TILE - 4, TILE - 4, 4);
      }
      // 灯笼（光源）
      if (id === 32) {
        ctx.fillStyle = '#ffcc40';
        ctx.beginPath();
        ctx.arc(sx + TILE/2, sy + TILE/2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff8800';
        ctx.beginPath();
        ctx.arc(sx + TILE/2, sy + TILE/2, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      // 床（右键/点按可睡过夜晚）
      if (id === 59) {
        ctx.fillStyle = '#a08050';                 // 木架
        ctx.fillRect(sx, sy + TILE - 6, TILE, 6);
        ctx.fillStyle = '#e8e8f0';                 // 床单
        ctx.fillRect(sx, sy + TILE - 12, TILE, 6);
        ctx.fillStyle = '#d05050';                 // 被子
        ctx.fillRect(sx + TILE/2, sy + TILE - 12, TILE/2, 6);
        ctx.fillStyle = '#ffffff';                 // 枕头
        ctx.fillRect(sx + 2, sy + TILE - 12, 6, 6);
      }
      // 木门（占 2 格：下半+上半，合起来是一扇高门）
      if (id === 26) {
        const topHalf = getTile(tx, ty - 1) === 26; // 上方还有门板→本格为下半
        const open = game.openDoors && game.openDoors.has(ty * WORLD_W + tx);
        if (open) {
          // 开启：门板贴到右侧，留出可通行的开口
          ctx.fillStyle = '#5a3a1a';
          ctx.fillRect(sx + TILE - 5, sy + 1, 4, TILE - 2);
          ctx.fillStyle = '#3a2a10';
          ctx.fillRect(sx + TILE - 5, sy + TILE / 2 - 1, 4, 2);
        } else {
          // 关闭：整扇门板
          ctx.fillStyle = '#6a4a20';
          ctx.fillRect(sx + 2, sy + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = '#4a3018';
          ctx.fillRect(sx + 2, sy + TILE / 2 - 1, TILE - 4, 2); // 门板中缝
          ctx.fillStyle = '#3a2a10';
          if (topHalf) {
            ctx.fillRect(sx + TILE - 7, sy + TILE - 9, 3, 5); // 下半：门把手
          } else {
            ctx.fillRect(sx + 2, sy + 3, TILE - 4, 3);        // 上半：门楣横木
          }
        }
      }
      // 箱子
      if (id === 27) {
        ctx.fillStyle = '#5a3a1a';
        ctx.fillRect(sx, sy + TILE/3, TILE, 2);
        ctx.fillStyle = '#3a2a10';
        ctx.fillRect(sx + TILE/2 - 2, sy + TILE/2 - 2, 4, 4);
      }
      // 木栅栏
      if (id === 28) {
        ctx.fillStyle = '#4a2e15';
        ctx.fillRect(sx + 3, sy, 3, TILE);
        ctx.fillRect(sx + TILE/2, sy, 3, TILE);
        ctx.fillRect(sx + TILE - 6, sy, 3, TILE);
      }
      // 书架
      if (id === 33) {
        ctx.fillStyle = '#5a3a1a';
        ctx.fillRect(sx, sy + TILE/3, TILE, 1);
        ctx.fillRect(sx, sy + (TILE*2)/3, TILE, 1);
        ctx.fillStyle = '#aa3333';
        ctx.fillRect(sx + 3, sy + 4, 3, TILE/3 - 6);
        ctx.fillStyle = '#3333aa';
        ctx.fillRect(sx + TILE/2, sy + 4, 3, TILE/3 - 6);
        ctx.fillStyle = '#33aa33';
        ctx.fillRect(sx + 3, sy + TILE/3 + 3, 3, TILE/3 - 6);
      }
    }
  }
}

function drawPlayer(ctx) {
  const p = game.player;
  const sx = p.x - game.camX;
  const sy = p.y - game.camY;

  // 头顶用户名（始终显示，即使闪烁）
  if (game.nickname) {
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(game.nickname).width;
    const nx = sx + p.w / 2;
    const ny = sy - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(nx - tw / 2 - 4, ny - 8, tw + 8, 16);
    ctx.fillStyle = '#00d4ff';
    ctx.fillText(game.nickname, nx, ny);
  }

  // 无敌闪烁
  if (p.invuln > 0 && Math.floor(p.invuln / 100) % 2 === 0) return;

  ctx.save();

  // 走路动画
  const walkOffset = p.onGround && Math.abs(p.vx) > 0.5 ? Math.sin(p.walkPhase * 10) * 2 : 0;
  const armSwing = p.onGround && Math.abs(p.vx) > 0.5 ? Math.sin(p.walkPhase * 10) * 8 : 0;

  // 身体
  ctx.fillStyle = '#3a6ab8';
  ctx.fillRect(sx + 2, sy + 10 + walkOffset, p.w - 4, p.h - 14);

  // 头
  ctx.fillStyle = '#e8b888';
  ctx.fillRect(sx + 3, sy, p.w - 6, 12);

  // 头发
  ctx.fillStyle = '#3a2a1a';
  ctx.fillRect(sx + 3, sy, p.w - 6, 4);

  // 眼睛
  ctx.fillStyle = '#222';
  if (p.facing > 0) {
    ctx.fillRect(sx + 9, sy + 6, 2, 2);
  } else {
    ctx.fillRect(sx + 7, sy + 6, 2, 2);
  }

  // 手臂（挖掘时挥动）
  let armY = sy + 12 + walkOffset;
  if (game.mining.target) {
    armY += Math.sin(performance.now() * 0.03) * 4;
  }
  ctx.fillStyle = '#e8b888';
  ctx.fillRect(sx + (p.facing > 0 ? p.w - 4 : 0), armY, 4, 10);

  // 腿
  ctx.fillStyle = '#2a4a8a';
  const legOffset = walkOffset;
  ctx.fillRect(sx + 2, sy + p.h - 6 + legOffset, 6, 6);
  ctx.fillRect(sx + p.w - 8, sy + p.h - 6 - legOffset, 6, 6);

  ctx.restore();
}

function drawEnemies(ctx) {
  for (const e of game.enemies) {
    const sx = e.x - game.camX;
    const sy = e.y - game.camY;
    const sq = Math.sin(e.animPhase * 10) * 2;

    if (e.type === 'spider') {
      // 洞穴蜘蛛：暗紫圆身 + 8 足 + 红眼（体型 26×22，腿部用细矩形模拟步足）
      const w = e.w, h = e.h;
      // 腿（左右各 4 条，随 animPhase 摆动）
      ctx.strokeStyle = '#3a2050';
      ctx.lineWidth = 2;
      const legSwing = Math.sin(e.animPhase * 14) * 3;
      for (let k = 0; k < 4; k++) {
        const ly = sy + 5 + k * 4;
        ctx.beginPath();
        ctx.moveTo(sx + 2, ly); ctx.lineTo(sx - 5, ly + legSwing * (k % 2 ? 1 : -1)); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx + w - 2, ly); ctx.lineTo(sx + w + 5, ly - legSwing * (k % 2 ? 1 : -1)); ctx.stroke();
      }
      // 身体
      ctx.fillStyle = '#7a4a9a';
      ctx.fillRect(sx, sy, w, h);
      ctx.fillStyle = '#5a3078';
      ctx.fillRect(sx + 3, sy + 3, w - 6, h - 6);
      // 眼睛（红色，集中在头顶）
      ctx.fillStyle = '#ff2222';
      ctx.fillRect(sx + 5, sy + 3, 4, 4);
      ctx.fillRect(sx + w - 9, sy + 3, 4, 4);
    } else if (e.type === 'golem') {
      // 石魔像：灰色巨石身 + 裂纹 + 亮眼（体型 32×32）
      const w = e.w, h = e.h;
      // 身体（轻微呼吸感）
      const bw = w + sq * 0.5, bh = h - sq * 0.5;
      ctx.fillStyle = '#8a8a92';
      ctx.fillRect(sx + (w - bw) / 2, sy + (h - bh), bw, bh);
      ctx.fillStyle = '#6a6a72';
      ctx.fillRect(sx + 4, sy + h - 8, w - 8, 6); // 底部基座
      // 裂纹
      ctx.strokeStyle = '#4a4a52';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx + 8, sy + 6); ctx.lineTo(sx + 13, sy + 12); ctx.lineTo(sx + 9, sy + 18);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx + w - 9, sy + 4); ctx.lineTo(sx + w - 14, sy + 10); ctx.lineTo(sx + w - 10, sy + 16);
      ctx.stroke();
      // 眼睛（橙黄亮光）
      ctx.fillStyle = '#ffcc40';
      ctx.fillRect(sx + 8, sy + 8, 5, 4);
      ctx.fillRect(sx + w - 13, sy + 8, 5, 4);
    } else {
      // 史莱姆：弹性绿色方块（原样）
      const w = e.w + sq;
      const h = e.h - sq;
      ctx.fillStyle = '#44cc44';
      ctx.fillRect(sx + (e.w - w) / 2, sy + (e.h - h), w, h);
      ctx.fillStyle = '#222';
      ctx.fillRect(sx + 6, sy + 8, 4, 4);
      ctx.fillRect(sx + e.w - 10, sy + 8, 4, 4);
      ctx.fillStyle = '#226622';
      ctx.fillRect(sx + 8, sy + 16, e.w - 16, 2);
    }

    // 血条
    if (e.health < e.maxHealth) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(sx, sy - 6, e.w, 3);
      ctx.fillStyle = '#ff3333';
      ctx.fillRect(sx, sy - 6, e.w * (e.health / e.maxHealth), 3);
    }
  }
}

function drawDroppedItems(ctx) {
  for (const item of game.droppedItems) {
    const block = BLOCKS[item.id];
    if (!block) continue;
    const sx = item.x - game.camX;
    const sy = item.y - game.camY;
    // 视口裁剪：屏外掉落物直接跳过（连 fillText/strokeRect 都不画）。
    // 否则挖矿/战斗累积数百个掉落物时，每帧对所有掉落物做 measureText+fillText（Canvas2D 最慢操作）会直接拖垮帧率。
    if (sx < -32 || sx > game.cw + 32 || sy < -32 || sy > game.ch + 32) continue;
    const bob = Math.sin(performance.now() * 0.005 + item.x) * 3;
    // 物品图标
    ctx.fillStyle = block.color;
    ctx.fillRect(sx, sy + bob, 8, 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.strokeRect(sx + 0.5, sy + bob + 0.5, 7, 7);
    // 名字标签（带底色保证任意背景下可读）
    const nm = block.name + (item.count > 1 ? ` ×${item.count}` : '');
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const nw = ctx.measureText(nm).width + 8;
    const ny = sy + bob + 18;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(sx + 4 - nw / 2, ny - 7, nw, 14);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(nm, sx + 4, ny);
  }
}

function drawParticles(ctx) {
  for (const p of game.particles) {
    const psx = p.x - game.camX, psy = p.y - game.camY;
    if (psx < -16 || psx > game.cw + 16 || psy < -16 || psy > game.ch + 16) continue;
    const alpha = Math.max(0, p.life / p.maxLife);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - game.camX, p.y - game.camY, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

// 径向渐变贴图：一次性预渲染"中心亮→边缘透明"的 128px 圆，之后光照层用 drawImage 缩放复用
// 替代每帧每光源 createRadialGradient（Canvas2D 最贵操作之一）——GPU 加速、零渐变创建
function makeRadialSprite(inner, outer) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, inner);
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, outer);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}
// 光照用共享贴图（黑色挖洞 / 橙黄光晕），懒加载
function getLightSprites() {
  if (!game._lightSprites) {
    game._lightSprites = {
      hole: makeRadialSprite('rgba(0,0,0,1)', 'rgba(0,0,0,0)'),          // 挖洞（黑→透明）
      glow: makeRadialSprite('rgba(255,180,60,1)', 'rgba(255,80,0,0)'),  // 暖色光晕（橙→透明）
    };
  }
  return game._lightSprites;
}

function drawLighting(ctx) {
  const t = game.time;
  let darkness = 0;

  // 夜晚暗度
  if (t > 0.5 && t < 0.95) {
    if (t < 0.6) darkness = (t - 0.5) / 0.1 * 0.5;
    else if (t < 0.85) darkness = 0.5;
    else darkness = (0.95 - t) / 0.1 * 0.5;
  }

  // 玩家在地下时大幅加暗（地下整体变暗，火把成为必需光源）
  // 关键：地下加暗必须【无条件】执行（无论白天黑夜），不能放在“白天提前 return”之后——
  // 否则白天 darkness=0 直接 return，会连地下加暗一起跳过，玩家在地下也不黑，火把失去意义。
  const p = game.player;
  const pTy = Math.floor((p.y + p.h / 2) / TILE);
  const surface = game.surface[Math.floor(p.x / TILE)] || WORLD_H * 0.35;
  let underground = false;
  if (pTy > surface + 3) {
    underground = true;
    const depth = (pTy - surface) / 15;
    darkness = Math.max(darkness, Math.min(0.92, depth * 0.5 + 0.45));
  }

  // 白天且玩家在【地表】：无暗化层，直接跳过整层光照（省掉全视口 getTile 遍历与暖色光晕）。
  // 地下时无论白天黑夜都保持黑暗，绝不可因白天而跳过。
  if (!underground && darkness < 0.01) return;

  // 收集视野内光源：遍历【光源缓存集合】过滤视口——替代原每帧全视口 1800 格 getTile 扫描
  // （火把/灯笼等带 light 的方块通常仅几十个，遍历开销可忽略；集合由 setupWorld 初始化、setTile 维护）
  const lightSources = [];
  const camTx0 = Math.floor(game.camX / TILE) - 1;
  const camTy0 = Math.floor(game.camY / TILE) - 1;
  const camTx1 = Math.ceil((game.camX + game.cw) / TILE) + 1;
  const camTy1 = Math.ceil((game.camY + game.ch) / TILE) + 1;
  const lsSet = game.lightSet;
  if (lsSet && lsSet.size > 0) {
    for (const idx of lsSet) {
      const tx = idx % WORLD_W;
      if (tx < camTx0 || tx > camTx1) continue;
      const ty = (idx / WORLD_W) | 0;
      if (ty < camTy0 || ty > camTy1) continue;
      const tileId = game.world[idx];
      const block = BLOCKS[tileId];
      if (!block || !block.light) continue;
      lightSources.push({
        x: tx * TILE + TILE / 2 - game.camX,
        y: ty * TILE + TILE / 2 - game.camY,
        radius: block.light,
        id: tileId,
      });
    }
  } else {
    // 兜底（lightSet 未初始化时）：退化为原全视口扫描
    for (let ty = startTy; ty <= endTy; ty++) {
      for (let tx = startTx; tx <= endTx; tx++) {
        const tileId = getTile(tx, ty);
        const block = BLOCKS[tileId];
        if (!block || !block.light || block.light === 0) continue;
        lightSources.push({
          x: tx * TILE + TILE / 2 - game.camX,
          y: ty * TILE + TILE / 2 - game.camY,
          radius: block.light,
          id: tileId,
        });
      }
    }
  }

  const now = performance.now();

  // 暖色光晕（始终叠加，营造灯笼/熔炉氛围）——渐变贴图 drawImage，替代每帧 createRadialGradient
  const sprites = getLightSprites();
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const src of lightSources) {
    // 火把(id 15)不再叠加暖色光晕，去掉其周围那圈橙黄色"边框"
    if (src.id === 15) continue;
    // 火焰闪烁
    let flicker = 1;
    if (src.id === 15 || src.id === 32 || src.id === 18) {
      flicker = 0.82 + Math.sin(now * 0.012 + src.x * 0.1) * 0.06 + Math.sin(now * 0.028 + src.y * 0.07) * 0.04 + (Math.random() - 0.5) * 0.08;
    }
    const r = TILE * src.radius * flicker;
    const glowAlpha = src.id === 15 ? 0.18 : src.id === 32 ? 0.22 : 0.12;
    ctx.globalAlpha = glowAlpha * flicker;
    ctx.drawImage(sprites.glow, src.x - r, src.y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  if (darkness < 0.01) return;

  // —— 关键修复：暗层画在离屏画布上，挖洞后再叠加到主画布 ——
  // 旧实现直接在主画布上挖洞（destination-out），会把已绘制的世界一起擦掉、露出页面背景（黑屏）。
  // 现改为：离屏暗层挖洞 → 透明处叠回主画布时露出下面的世界，火把/玩家周围才真正“照亮”。
  const lc = game.lightCanvas;
  if (!lc || lc.width !== game.cw || lc.height !== game.ch) {
    game.lightCanvas = document.createElement('canvas');
    game.lightCanvas.width = game.cw;
    game.lightCanvas.height = game.ch;
    game.lightCtx = game.lightCanvas.getContext('2d');
  }
  const l = game.lightCtx;
  l.globalCompositeOperation = 'source-over';
  l.clearRect(0, 0, game.cw, game.ch);
  l.fillStyle = `rgba(5,5,20,${darkness})`;
  l.fillRect(0, 0, game.cw, game.ch);

  // 玩家处挖洞：核心完全透出世界（地下时光圈缩小，逼迫玩家使用火把照明）
  const pSx = p.x + p.w / 2 - game.camX;
  const pSy = p.y + p.h / 2 - game.camY;
  const lightR = underground ? TILE * 3.2 : TILE * 5.5;
  l.globalCompositeOperation = 'destination-out';
  l.globalAlpha = 1;
  l.drawImage(sprites.hole, pSx - lightR, pSy - lightR, lightR * 2, lightR * 2);

  // 火把/灯笼等光源挖洞（带闪烁）：核心 alpha=1 让该区域完全透出世界 → 夜晚真正发亮
  for (const src of lightSources) {
    let flicker = 1;
    if (src.id === 15 || src.id === 32 || src.id === 18) {
      flicker = 0.82 + Math.sin(now * 0.012 + src.x * 0.1) * 0.06 + Math.sin(now * 0.028 + src.y * 0.07) * 0.04 + (Math.random() - 0.5) * 0.08;
    }
    const r = TILE * src.radius * flicker;
    l.drawImage(sprites.hole, src.x - r, src.y - r, r * 2, r * 2);
  }

  // 把暗层叠回主画布：未挖洞处保持黑暗，挖洞处露出已绘制的世界
  l.globalCompositeOperation = 'source-over';
  ctx.drawImage(game.lightCanvas, 0, 0);
}

function drawMiningProgress(ctx) {
  if (!game.mining.target) return;
  const tx = game.mining.x;
  const ty = game.mining.y;
  const block = BLOCKS[getTile(tx, ty)];
  if (!block) return;

  const sx = tx * TILE - game.camX;
  const sy = ty * TILE - game.camY;
  const prog = game.mining.progress / (block.hardness * 8);

  // 裂纹
  ctx.fillStyle = `rgba(0,0,0,${prog * 0.5})`;
  ctx.fillRect(sx, sy, TILE, TILE);

  // 裂纹线条
  ctx.strokeStyle = `rgba(0,0,0,${prog * 0.8})`;
  ctx.lineWidth = 1;
  if (prog > 0.2) {
    ctx.beginPath();
    ctx.moveTo(sx + 4, sy + 4);
    ctx.lineTo(sx + TILE - 4, sy + TILE - 4);
    ctx.moveTo(sx + TILE - 4, sy + 4);
    ctx.lineTo(sx + 4, sy + TILE - 4);
    ctx.stroke();
  }
  if (prog > 0.5) {
    ctx.beginPath();
    ctx.moveTo(sx, sy + TILE / 2);
    ctx.lineTo(sx + TILE, sy + TILE / 2);
    ctx.moveTo(sx + TILE / 2, sy);
    ctx.lineTo(sx + TILE / 2, sy + TILE);
    ctx.stroke();
  }
}

// 触屏挖掘指针：高亮显示当前实际瞄准的挖掘/放置目标格
// 与 getMobileTargetTile 用同一函数取目标，保证"看到的 = 实际挖/放的"：
// 玩家点选格 → 高亮点选格；点选格被挖空/超范围 → 自动回退到摇杆方向格并高亮之
function drawTouchAimPointer(ctx) {
  const ti = game.touchInput;
  if (!ti.isTouch) return;
  const p = game.player;
  const px = Math.floor((p.x + p.w / 2) / TILE);
  const py = Math.floor((p.y + p.h / 2) / TILE);
  const target = getMobileTargetTile(px, py);
  if (!target) return;
  const atx = target.tx, aty = target.ty;

  const sx = atx * TILE - game.camX;
  const sy = aty * TILE - game.camY;
  if (sx < -TILE || sx > game.cw || sy < -TILE || sy > game.ch) return; // 屏外不画

  const tileId = getTile(atx, aty);
  const block = BLOCKS[tileId];

  // 颜色：超范围=红；空气（可放置）=绿；实体方块且工具够=白；工具不够=红
  let color = 'rgba(255,255,255,0.7)';
  if (tileId === 0) {
    color = 'rgba(100,255,100,0.8)';
  } else if (block && block.tool) {
    const equippedId = game.hotbar[game.selectedSlot];
    const eqBlock = equippedId > 0 ? BLOCKS[equippedId] : null;
    const toolTier = (eqBlock && eqBlock.tool === 'pickaxe' && eqBlock.toolTier) ? eqBlock.toolTier : 0;
    color = toolTier < block.tool ? 'rgba(255,80,80,0.8)' : 'rgba(255,255,255,0.7)';
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
  // 四角小标记，强化"指针"感（手机屏上比细框更易辨认）
  ctx.fillStyle = color;
  const m = 4, L = 7;
  ctx.fillRect(sx, sy, L, m); ctx.fillRect(sx, sy, m, L);
  ctx.fillRect(sx + TILE - L, sy, L, m); ctx.fillRect(sx + TILE - m, sy, m, L);
  ctx.fillRect(sx, sy + TILE - m, L, m); ctx.fillRect(sx, sy + TILE - L, m, L);
  ctx.fillRect(sx + TILE - L, sy + TILE - m, L, m); ctx.fillRect(sx + TILE - m, sy + TILE - L, m, L);
}

function drawMouseTarget(ctx) {
  const tx = Math.floor(game.mouse.worldX / TILE);
  const ty = Math.floor(game.mouse.worldY / TILE);
  const p = game.player;
  const px = Math.floor((p.x + p.w / 2) / TILE);
  const py = Math.floor((p.y + p.h / 2) / TILE);
  const dist = Math.abs(tx - px) + Math.abs(ty - py);
  if (dist > REACH) return;

  const tileId = getTile(tx, ty);
  const sx = tx * TILE - game.camX;
  const sy = ty * TILE - game.camY;

  // 检查工具需求
  const block = BLOCKS[tileId];
  let canMine = true;
  if (block && block.tool) {
    const equippedId = game.hotbar[game.selectedSlot];
    const eqBlock = equippedId > 0 ? BLOCKS[equippedId] : null;
    const toolTier = (eqBlock && eqBlock.tool === 'pickaxe' && eqBlock.toolTier) ? eqBlock.toolTier : 0;
    if (toolTier < block.tool) canMine = false;
  }

  if (tileId === 0) {
    ctx.strokeStyle = 'rgba(100,255,100,0.5)';
  } else if (!canMine) {
    ctx.strokeStyle = 'rgba(255,80,80,0.7)';
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  }
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, TILE, TILE);

  // 显示工具需求
  if (!canMine && block) {
    const tierNames = ['', '木镐', '石镐', '铁镐'];
    ctx.fillStyle = 'rgba(255,80,80,0.9)';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`需要${tierNames[block.tool]}`, sx + TILE / 2, sy - 6);
  }
}

// ==================== UI ====================
function drawUI(ctx) {
  // 生命值（纵坐标整体跟随手机刘海/安全区，避免全面屏血条被系统栏遮挡）
  const hudY = 10 + game.safeArea.top;
  const healthBarW = 200;
  const healthBarH = 18;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(10, hudY, healthBarW + 4, healthBarH + 4);
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(12, hudY + 2, healthBarW, healthBarH);
  const hpct = game.player.health / game.player.maxHealth;
  ctx.fillStyle = hpct > 0.5 ? '#22cc44' : (hpct > 0.25 ? '#ccaa22' : '#cc3333');
  ctx.fillRect(12, hudY + 2, healthBarW * hpct, healthBarH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`❤ ${Math.ceil(game.player.health)} / ${game.player.maxHealth}`, 12 + healthBarW / 2, hudY + 15);

  // 血量回复指示
  const timeSinceDamage = performance.now() - (game.player.lastDamageTime || 0);
  if (game.player.health < game.player.maxHealth && timeSinceDamage > 4000 && game.player.invuln <= 0) {
    const pulse = 0.4 + Math.sin(performance.now() * 0.005) * 0.3;
    ctx.strokeStyle = `rgba(34,255,68,${pulse})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(10, hudY, healthBarW + 4, healthBarH + 4);
    ctx.fillStyle = `rgba(34,255,68,${pulse})`;
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('＋回复中', 12, hudY + 26);
  }

  // 氧气值（仅头部没入水中才消耗；清空后持续扣血）—— 显示在血条右侧同一行
  if (game.player.oxygen < game.player.maxOxygen || game.player.headInWater) {
    const oxX = 218, oxBarW = 160, oxBarH = 18;
    const oxY = hudY;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(oxX - 2, oxY, oxBarW + 4, oxBarH + 4);
    ctx.fillStyle = '#0a2233';
    ctx.fillRect(oxX, oxY + 2, oxBarW, oxBarH);
    const opct = Math.max(0, game.player.oxygen / game.player.maxOxygen);
    ctx.fillStyle = opct > 0.3 ? '#33b5ff' : '#ff6644';
    ctx.fillRect(oxX, oxY + 2, oxBarW * opct, oxBarH);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`🫧 O₂ ${Math.ceil(game.player.oxygen)}`, oxX + oxBarW / 2, oxY + 2 + oxBarH / 2 + 1);
    ctx.textBaseline = 'alphabetic';
  }

  // 装备工具显示
  const equippedId = game.hotbar[game.selectedSlot];
  if (equippedId > 0) {
    const eqBlock = BLOCKS[equippedId];
    if (eqBlock && eqBlock.toolTier) {
      const tierNames = ['', '木镐', '石镐', '铁镐'];
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(10, 50, 130, 20);
      ctx.fillStyle = '#ffaa44';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⛏️ ${tierNames[eqBlock.toolTier]} Lv.${eqBlock.toolTier}`, 16, 61);
    }
  }

  // 昼夜指示（避开刘海/系统栏 + 右侧留边距，防被遮挡）
  const uiRight = game.cw - 110 - game.safeArea.right;
  const timeText = game.time < 0.5 ? `☀ 白天` : `🌙 夜晚`;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(game.cw - 120 - game.safeArea.right, 10 + game.safeArea.top, 110, 22);
  ctx.fillStyle = '#fff';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(timeText, uiRight, 25 + game.safeArea.top);

  // 已发现元素计数
  const totalElements = Object.keys(PERIODIC_TABLE).length;
  const foundCount = game.discoveredElements.size;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(game.cw - 120 - game.safeArea.right, 36 + game.safeArea.top, 110, 22);
  ctx.fillStyle = '#88ffcc';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`🔬 ${foundCount}/${totalElements} 元素`, uiRight, 51 + game.safeArea.top);

  // FPS
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(game.cw - 60, game.ch - 24, 50, 18);
  ctx.fillStyle = '#88ff88';
  ctx.font = '11px monospace';
  ctx.fillText(`${game.fps}fps`, game.cw - 55, game.ch - 11);

  // 热栏
  drawHotbar(ctx);

  // 操作提示
  if (game.time === 0 || performance.now() < 8000) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(game.cw / 2 - 180, game.ch - 60, 360, 36);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    if (game.touchInput.isTouch) {
      ctx.fillText('摇杆移动 | ⬆️跳跃 | ⛏️挖掘(面前方块) | 🧱放置 | 点怪对战', game.cw / 2, game.ch - 42);
      ctx.fillText('🎒背包 | 🔧合成 | 点击热栏选栏 | 右键工作台/熔炉打开UI', game.cw / 2, game.ch - 28);
    } else {
      ctx.fillText('A/D移动 | W/空格跳跃 | 左键挖掘 | 右键放置/使用工作站 | 1-0选栏 | E背包 | Tab合成', game.cw / 2, game.ch - 42);
      ctx.fillText('右键工作台/熔炉打开独立UI | 挖矿获得材料合成工具 | 挖掘新矿石发现化学元素', game.cw / 2, game.ch - 28);
    }
  }
}

function drawHotbar(ctx) {
  const slotSize = 44;
  const gap = 4;
  const totalW = 10 * slotSize + 9 * gap;
  const startX = (game.cw - totalW) / 2;
  // 触屏设备热栏上移，避免与摇杆/按钮重叠
  const y = game.ch - slotSize - (game.touchInput.isTouch ? 20 : 14);

  for (let i = 0; i < 10; i++) {
    const x = startX + i * (slotSize + gap);
    const isSelected = i === game.selectedSlot;
    const isHovered = i === game.hoveredSlot;

    // 背景
    ctx.fillStyle = isSelected ? 'rgba(0,212,255,0.25)' : (isHovered ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.55)');
    ctx.fillRect(x, y, slotSize, slotSize);

    // 边框
    ctx.strokeStyle = isSelected ? '#00d4ff' : (isHovered ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)');
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.strokeRect(x + 1, y + 1, slotSize - 2, slotSize - 2);

    // 方块图标
    const blockId = game.hotbar[i];
    if (blockId > 0 && game.hotbarCounts[i] > 0) {
      const iconSize = 28;
      const iconX = x + (slotSize - iconSize) / 2;
      const iconY = y + (slotSize - iconSize) / 2 - 2;
      drawBlockIcon(ctx, iconX, iconY, iconSize, blockId);

      // 元素指示器
      const element = BLOCK_ELEMENTS[blockId];
      if (element) {
        const elemInfo = ELEMENT_INFO[element];
        ctx.fillStyle = elemInfo.color;
        ctx.beginPath();
        ctx.arc(x + 7, y + 7, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 数量
      const count = game.hotbarCounts[i];
      if (count > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(x + slotSize - 20, y + slotSize - 16, 18, 14);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(count, x + slotSize - 4, y + slotSize - 9);
      }

      // 工具耐久条（带 durability 的工具：剑等）：槽底细条，绿→黄→红
      const maxDur = BLOCKS[blockId] ? BLOCKS[blockId].durability : 0;
      if (maxDur > 0) {
        const cur = (game.toolDur && game.toolDur[i] != null) ? game.toolDur[i] : maxDur;
        const pct = Math.max(0, Math.min(1, cur / maxDur));
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x + 3, y + slotSize - 5, slotSize - 6, 3);
        ctx.fillStyle = pct > 0.4 ? '#44cc44' : (pct > 0.2 ? '#ccaa22' : '#cc3333');
        ctx.fillRect(x + 3, y + slotSize - 5, (slotSize - 6) * pct, 3);
      }
    }

    // 槽位号
    ctx.fillStyle = isSelected ? 'rgba(0,212,255,0.9)' : 'rgba(255,255,255,0.35)';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(i === 9 ? '0' : String(i + 1), x + 4, y + 4);
  }

  // 悬停提示
  if (game.hoveredSlot >= 0) {
    const blockId = game.hotbar[game.hoveredSlot];
    if (blockId > 0 && game.hotbarCounts[game.hoveredSlot] > 0) {
      const block = BLOCKS[blockId];
      const element = BLOCK_ELEMENTS[blockId];
      const elemInfo = element ? ELEMENT_INFO[element] : null;
      let tipText = block.name;
      if (elemInfo) tipText += ` [${elemInfo.icon}${elemInfo.name}]`;
      if (block.toolTier) {
        const tierNames = ['', '木镐', '石镐', '铁镐'];
        tipText += ` [⛏ Lv.${block.toolTier} ${tierNames[block.toolTier]}]`;
      }
      tipText += ` x${game.hotbarCounts[game.hoveredSlot]}`;

      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tipW = ctx.measureText(tipText).width + 20;
      const tipX = startX + game.hoveredSlot * (slotSize + gap) + slotSize / 2;
      const tipY = y - 30;

      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.fillRect(tipX - tipW / 2, tipY - 13, tipW, 26);
      ctx.strokeStyle = 'rgba(0,212,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tipX - tipW / 2 + 0.75, tipY - 12.25, tipW - 1.5, 24.5);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tipText, tipX, tipY);
    }
  }

  // 工作站提示：靠近熔炉/工作台时，用彩色胶囊分别提示（更醒目），点击/右键打开
  const stationHints = [];
  if (hasWB) stationHints.push({ label: '🔨 工作台', color: '#00d4ff' });
  if (hasFN) stationHints.push({ label: '🔥 熔炉', color: '#ff7a1e' });

  // 箱子提示：附近有箱子时提示右键打开（独立扫描，不依赖其它提示变量）
  {
    const pTx = Math.floor(game.player.x / TILE);
    const pTy = Math.floor(game.player.y / TILE);
    let nearChest = false;
    for (let dx = -4; dx <= 4 && !nearChest; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        if (getTile(pTx + dx, pTy + dy) === 27) { nearChest = true; break; }
      }
    }
    if (nearChest) stationHints.push({ label: '📦 箱子', color: '#f0c070' });
  }
  if (stationHints.length) {
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const padX = 12, gap = 10, h = 28, boxY = y - h - 34;
    let curX = startX;
    for (const s of stationHints) {
      const full = s.label + '  右键打开';
      const w = ctx.measureText(full).width + padX * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.82)';
      ctx.fillRect(curX, boxY, w, h);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(curX + 1, boxY + 1, w - 2, h - 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(full, curX + padX, boxY + h / 2);
      curX += w + gap;
    }
  }
}

// 绘制方块像素图标（热栏/合成界面通用）
function drawBlockIcon(ctx, x, y, size, blockId) {
  const block = BLOCKS[blockId];
  if (!block || !block.color) return;

  const s = size;
  // 底色
  ctx.fillStyle = block.color;
  ctx.fillRect(x, y, s, s);

  const shade = block.shade || block.color;
  const id = blockId;

  // 根据方块类型绘制不同的像素纹理
  if (id === 4) {
    // 原木：年轮纹理
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + 2, s, 2);
    ctx.fillRect(x, y + s - 4, s, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + s/2 - 1, y + 4, 2, s - 8);
  } else if (id === 3) {
    // 石头：随机斑点
    ctx.fillStyle = shade;
    ctx.fillRect(x + 3, y + 4, 4, 3);
    ctx.fillRect(x + s - 8, y + 6, 3, 4);
    ctx.fillRect(x + 5, y + s - 8, 4, 3);
  } else if (id === 2) {
    // 泥土：深色颗粒
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y + 3, 3, 3);
    ctx.fillRect(x + s - 6, y + 5, 3, 2);
    ctx.fillRect(x + 4, y + s - 6, 2, 3);
  } else if (id === 1) {
    // 草地：绿色顶部
    ctx.fillStyle = '#5fb850';
    ctx.fillRect(x, y, s, 4);
    ctx.fillStyle = shade;
    ctx.fillRect(x + 3, y + s - 4, 3, 3);
  } else if (id === 6) {
    // 沙子：亮点
    ctx.fillStyle = 'rgba(255,255,200,0.4)';
    ctx.fillRect(x + 2, y + 3, 2, 2);
    ctx.fillRect(x + s - 5, y + 5, 2, 2);
    ctx.fillRect(x + 4, y + s - 4, 2, 2);
  } else if (id === 13) {
    // 木板：水平纹路
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/3, s, 1);
    ctx.fillRect(x, y + (s*2)/3, s, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(x + s/2, y, 1, s/3);
    ctx.fillRect(x + s/3, y + s/3, 1, s/3);
  } else if (id >= 7 && id <= 11) {
    // 矿石：大块亮脉（与世界上矿一致）
    const vein = (id === 7) ? '#a8a8a8' : shade;
    ctx.fillStyle = vein;
    ctx.fillRect(x + 4, y + 5, 10, 10);
    ctx.fillRect(x + s - 12, y + 13, 7, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(x + 5, y + 6, 3, 3);
    if (id === 11) { ctx.fillStyle = 'rgba(220,255,255,0.9)'; ctx.fillRect(x + 12, y + 6, 2, 2); }
    if (id === 10) { ctx.fillStyle = 'rgba(255,240,180,0.5)'; ctx.fillRect(x + s - 10, y + 15, 2, 2); }
  } else if (id === 15) {
    // 火把
    ctx.fillStyle = '#6d4423';
    ctx.fillRect(x + s/2 - 2, y + s/3, 4, s * 2/3);
    ctx.fillStyle = '#ffcc40';
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/3, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/3, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 59) {
    // 床
    ctx.fillStyle = '#a08050';
    ctx.fillRect(x, y + s - 5, s, 5);
    ctx.fillStyle = '#e8e8f0';
    ctx.fillRect(x, y + s - 10, s, 5);
    ctx.fillStyle = '#d05050';
    ctx.fillRect(x + s/2, y + s - 10, s/2, 5);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + 2, y + s - 10, 5, 5);
  } else if (id === 17) {
    // 工作台：木作台 + 3x3 网格
    ctx.fillStyle = '#a87238';
    ctx.fillRect(x, y, s, Math.round(s/8));
    ctx.fillStyle = '#6e4620';
    ctx.fillRect(x, y + s - Math.round(s/6), s, Math.round(s/6));
    const gx0 = x + s*0.16, gy0 = y + s*0.22, gw = s*0.68, gh = s*0.56;
    ctx.fillStyle = 'rgba(255,224,176,0.6)';
    ctx.fillRect(gx0 + gw/3, gy0, 1, gh);
    ctx.fillRect(gx0 + 2*gw/3, gy0, 1, gh);
    ctx.fillRect(gx0, gy0 + gh/3, gw, 1);
    ctx.fillRect(gx0, gy0 + 2*gh/3, gw, 1);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(gx0 + 0.5, gy0 + 0.5, gw - 1, gh - 1);
  } else if (id === 18) {
    // 熔炉：石炉 + 炉火
    ctx.fillStyle = '#3a2818';
    ctx.fillRect(x, y, s, Math.round(s/8));
    const ox = x + s*0.25, oy = y + s*0.28, ow = s*0.5, oh = s*0.5;
    ctx.fillStyle = '#140a04';
    ctx.fillRect(ox, oy, ow, oh);
    ctx.fillStyle = '#ff7a1e';
    ctx.fillRect(ox + ow*0.16, oy + oh*0.25, ow*0.68, oh*0.55);
    ctx.fillStyle = 'rgba(255,200,80,0.7)';
    ctx.fillRect(ox + ow*0.2, oy + oh*0.3, ow*0.6, 2);
    ctx.strokeStyle = '#2a1a10';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, ow - 1, oh - 1);
  } else if (id === 16) {
    // 玻璃：高光
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x + 2, y + 2, 3, s - 4);
  } else if (id === 14 || id === 22) {
    // 砖块/石砖：砖缝
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/2, s, 1);
    ctx.fillRect(x + s/2, y, 1, s/2);
    ctx.fillRect(x + s/4, y + s/2, 1, s/2);
  } else if (id === 12) {
    // 水：波纹
    ctx.fillStyle = 'rgba(100,180,255,0.4)';
    ctx.fillRect(x, y + 2, s, 2);
    ctx.fillRect(x, y + s/2, s, 1);
  } else if (id === 60) {
    // 空桶
    ctx.fillStyle = '#8a8a90';
    ctx.fillRect(x + s*0.25, y + s*0.30, s*0.5, s*0.55);
    ctx.fillStyle = '#5a5a60';
    ctx.fillRect(x + s*0.22, y + s*0.26, s*0.56, s*0.08);
    ctx.fillRect(x + s*0.20, y + s*0.26, s*0.08, s*0.12);
    ctx.fillRect(x + s*0.72, y + s*0.26, s*0.08, s*0.12);
  } else if (id === 61) {
    // 水桶
    ctx.fillStyle = '#7a7a82';
    ctx.fillRect(x + s*0.25, y + s*0.30, s*0.5, s*0.55);
    ctx.fillStyle = '#2f6fc0';
    ctx.fillRect(x + s*0.27, y + s*0.40, s*0.46, s*0.42);
    ctx.fillStyle = '#5a5a60';
    ctx.fillRect(x + s*0.22, y + s*0.26, s*0.56, s*0.08);
  } else if (id === 62) {
    // 岩浆桶
    ctx.fillStyle = '#7a7a82';
    ctx.fillRect(x + s*0.25, y + s*0.30, s*0.5, s*0.55);
    ctx.fillStyle = '#e0581a';
    ctx.fillRect(x + s*0.27, y + s*0.40, s*0.46, s*0.42);
    ctx.fillStyle = '#5a5a60';
    ctx.fillRect(x + s*0.22, y + s*0.26, s*0.56, s*0.08);
  } else if (id === 63) {
    // 岩浆
    ctx.fillStyle = '#e0581a';
    ctx.fillRect(x, y, s, s);
    ctx.fillStyle = '#ffae3a';
    ctx.fillRect(x, y, s, 3);
  } else if (id === 23) {
    // 雪：白点
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, s, 3);
  } else if (id === 24) {
    // 冰：裂纹
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x + 2, y + 3, 4, 1);
    ctx.fillRect(x + s - 6, y + s - 4, 4, 1);
  } else if (id === 25) {
    // 黑曜石：紫色斑点
    ctx.fillStyle = '#3a1a4e';
    ctx.fillRect(x + 3, y + 4, 3, 3);
    ctx.fillRect(x + s - 6, y + s - 7, 3, 3);
  } else if (id === 26) {
    // 木门
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y + 2, s - 4, s - 4);
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(x + s - 8, y + s/2 - 1, 3, 3);
  } else if (id === 27) {
    // 箱子
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/3, s, 2);
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(x + s/2 - 2, y + s/2 - 1, 4, 3);
  } else if (id === 28) {
    // 栅栏
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y, 2, s);
    ctx.fillRect(x + s/2 - 1, y, 2, s);
    ctx.fillRect(x + s - 4, y, 2, s);
    ctx.fillRect(x, y + s/3, s, 2);
    ctx.fillRect(x, y + (s*2)/3, s, 2);
  } else if (id === 29 || id === 30 || id === 34) {
    // 金属砖：光泽
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s - 3, s, 3);
  } else if (id === 31 || id === 35) {
    // 晶体砖：闪光
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x + 3, y + 3, 3, 3);
    ctx.fillRect(x + s - 6, y + s - 6, 2, 2);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/2, s, 1);
  } else if (id === 32) {
    // 灯笼
    ctx.fillStyle = '#6d4423';
    ctx.fillRect(x + 2, y, s - 4, 3);
    ctx.fillRect(x + 2, y + s - 3, s - 4, 3);
    ctx.fillStyle = '#ffcc40';
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/2, s/3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff8800';
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/2, s/4, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 33) {
    // 书架
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/3, s, 1);
    ctx.fillRect(x, y + (s*2)/3, s, 1);
    ctx.fillStyle = '#aa3333';
    ctx.fillRect(x + 3, y + 4, 3, s/3 - 6);
    ctx.fillStyle = '#3333aa';
    ctx.fillRect(x + s/2, y + 4, 3, s/3 - 6);
    ctx.fillStyle = '#33aa33';
    ctx.fillRect(x + 3, y + s/3 + 3, 3, s/3 - 6);
  } else if (id === 19 || id === 20 || id === 21) {
    // 锭块：金属光泽
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s - 4, s, 4);
  } else if (id === 5) {
    // 树叶
    ctx.fillStyle = shade;
    ctx.fillRect(x + 3, y + 3, 3, 3);
    ctx.fillRect(x + s - 6, y + 5, 3, 3);
    ctx.fillRect(x + 5, y + s - 6, 3, 2);
  } else if (id === 64) {
    // 树苗
    ctx.fillStyle = '#5a3a1e';
    ctx.fillRect(x + s / 2 - 1, y + s * 0.55, 2, s * 0.4);
    ctx.fillStyle = '#3fae3a';
    ctx.beginPath(); ctx.ellipse(x + s * 0.35, y + s * 0.45, s * 0.16, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + s * 0.65, y + s * 0.38, s * 0.16, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5fd850';
    ctx.beginPath(); ctx.arc(x + s / 2, y + s * 0.34, s * 0.1, 0, Math.PI * 2); ctx.fill();
  } else if (id >= 36 && id <= 41 || id >= 66 && id <= 70) {
    // 新矿石：大块亮脉（与世界上矿一致）
    const vein = (id === 37) ? '#d6d6e6' : shade;
    ctx.fillStyle = vein;
    ctx.fillRect(x + 4, y + 5, 10, 10);
    ctx.fillRect(x + s - 12, y + 13, 7, 7);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillRect(x + 5, y + 6, 3, 3);
    if (id === 40) { ctx.fillStyle = '#e8e040'; ctx.fillRect(x + 3, y + s - 6, s - 6, 3); }
    if (id === 37) { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(x + 7, y + 7, 2, 2); }
    if (id === 41) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(x + s - 6, y + s - 7, 2, 2); }
    // 新元素矿：铝(66)锌(67)银灰亮点 / 钛(69)蓝紫高光 / 镁(70)白亮结晶
    if (id === 66 || id === 67) { ctx.fillStyle = 'rgba(220,230,240,0.5)'; ctx.fillRect(x + s - 6, y + 4, 2, 2); }
    if (id === 69) { ctx.fillStyle = 'rgba(180,200,255,0.6)'; ctx.fillRect(x + 6, y + 14, 2, 2); }
    if (id === 70) { ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(x + 4, y + 8, 2, 2); }
  } else if (id >= 42 && id <= 46) {
    // 新冶炼锭块
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s - 4, s, 4);
    if (id === 43) { // 银锭高光
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x + 4, y + 4, 3, 2);
    }
  } else if (id >= 71 && id <= 75) {
    // 新元素锭块（铝/锌/镍/钛/镁）：金属光泽横纹
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s - 4, s, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(x, y + s / 2, s, 1);
    if (id === 75) { // 镁锭白亮高光
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(x + 4, y + 5, 3, 2);
    }
  } else if (id === 76) {
    // 黄铜块（Cu+Zn 合金）
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s / 2, s, 1);
    ctx.fillStyle = 'rgba(255,220,120,0.35)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
  } else if (id === 77) {
    // 不锈钢块（Fe+Ni 合金）
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x + 2, y + 2, 3, s - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(x + s - 5, y + 2, 3, s - 4);
  } else if (id === 47) {
    // 青铜块
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + s/2, s, 1);
    ctx.fillStyle = 'rgba(255,180,80,0.3)';
    ctx.fillRect(x + 2, y + 2, s - 4, 2);
  } else if (id === 48) {
    // 焊料块
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y + 2, 3, 3);
    ctx.fillRect(x + s - 5, y + s - 5, 3, 3);
  } else if (id === 49) {
    // 琥珀金
    ctx.fillStyle = 'rgba(255,255,200,0.4)';
    ctx.fillRect(x + 3, y + 3, 3, 3);
    ctx.fillRect(x + s - 6, y + s - 6, 2, 2);
  } else if (id === 50) {
    // 透镜
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/2, s/3, 0, Math.PI * 2);
    ctx.fill();
  } else if (id === 51) {
    // 导电板
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y + 2, 3, 3);
    ctx.fillRect(x + s - 5, y + 2, 3, 3);
    ctx.fillStyle = 'rgba(0,200,255,0.3)';
    ctx.fillRect(x + 5, y + s/2 - 1, s - 10, 2);
  } else if (id === 52) {
    // 硫磺弹
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/2, s/3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff6600';
    ctx.fillRect(x + s/2 - 1, y + 2, 2, 4);
  } else if (id === 53) {
    // 毒药瓶
    ctx.fillStyle = shade;
    ctx.fillRect(x + s/3, y, s/3, 4);
    ctx.fillStyle = block.color;
    ctx.beginPath();
    ctx.arc(x + s/2, y + s/2 + 2, s/3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(155,89,182,0.5)';
    ctx.fillRect(x + 4, y + s/2, 3, 2);
  } else if (id === 54) {
    // 半导体
    ctx.fillStyle = shade;
    ctx.fillRect(x + 2, y + s/2 - 1, s - 4, 2);
    ctx.fillStyle = 'rgba(0,255,100,0.3)';
    ctx.fillRect(x + 3, y + 3, 3, 3);
    ctx.fillStyle = 'rgba(255,0,0,0.3)';
    ctx.fillRect(x + s - 6, y + s - 6, 3, 3);
  } else if (id === 55) {
    // 电池组
    ctx.fillStyle = shade;
    ctx.fillRect(x, y + 2, s, s - 4);
    ctx.fillStyle = '#ff3333';
    ctx.fillRect(x + 2, y + 4, s/2 - 2, s - 8);
    ctx.fillStyle = '#3333ff';
    ctx.fillRect(x + s/2, y + 4, s/2 - 2, s - 8);
    ctx.fillStyle = '#888';
    ctx.fillRect(x + s/2 - 1, y, 2, 3);
  } else if (id === 56 || id === 57 || id === 58) {
    // 镐子工具
    // 颜色根据等级变化
    const headColors = { 56:'#9a6b3a', 57:'#7a7a80', 58:'#c0c0c8' };
    const headDark = { 56:'#6d4423', 57:'#5a5a5f', 58:'#909098' };
    const hc = headColors[id];
    const hd = headDark[id];
    // 手柄
    ctx.fillStyle = '#6d4423';
    ctx.fillRect(x + s/2 - 1, y + s/3, 3, s * 2/3);
    // 镐头
    ctx.fillStyle = hc;
    ctx.fillRect(x + 2, y + 2, s - 4, 5);
    ctx.fillStyle = hd;
    ctx.fillRect(x + 2, y + 5, s - 4, 2);
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x + 3, y + 3, s - 6, 1);
  } else if (id === 79 || id === 80 || id === 81) {
    // 剑（近战武器）：斜持剑刃 + 护手 + 柄尾，颜色按等级
    const bladeColors = { 79:'#9a6b3a', 80:'#7a7a80', 81:'#c0c0c8' };
    const bladeDark = { 79:'#6d4423', 80:'#5a5a5f', 81:'#909098' };
    const bc = bladeColors[id], bd = bladeDark[id];
    // 剑刃（从左上到右下的斜刃）
    ctx.fillStyle = bc;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.22, y + s * 0.08);
    ctx.lineTo(x + s * 0.62, y + s * 0.48);
    ctx.lineTo(x + s * 0.52, y + s * 0.58);
    ctx.lineTo(x + s * 0.12, y + s * 0.18);
    ctx.closePath();
    ctx.fill();
    // 刃中线高光
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(x + s * 0.2, y + s * 0.16, s * 0.3, 2);
    // 护手（横档）
    ctx.fillStyle = bd;
    ctx.fillRect(x + s * 0.08, y + s * 0.52, s * 0.56, 4);
    // 剑柄
    ctx.fillStyle = '#6d4423';
    ctx.fillRect(x + s * 0.22, y + s * 0.56, 4, s * 0.26);
    // 柄尾圆头
    ctx.fillStyle = '#8a5a2a';
    ctx.beginPath();
    ctx.arc(x + s * 0.24, y + s * 0.86, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // 边框
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
}

// ==================== 合成界面 ====================
function drawCrafting() {
  const overlay = document.getElementById('crafting-overlay');
  const panel = document.getElementById('crafting-panel');
  overlay.style.display = 'flex';

  // 设置面板样式
  panel.className = '';
  panel.classList.add('mode-' + game.craftingMode);

  const mode = game.craftingMode;
  const modeConfig = {
    'hand':      { title: '✋ 手工合成', icon: '✋', needStation: false },
    'workbench': { title: '🔨 工作台', icon: '🔨', needStation: true, station: 'workbench' },
    'furnace':   { title: '🔥 熔炉', icon: '🔥', needStation: true, station: 'furnace' },
  };
  const cfg = modeConfig[mode] || modeConfig['hand'];

  const hasStation = cfg.needStation ? hasCraftingStation(cfg.station) : true;

  // 筛选当前模式的配方：
  //   手工模式   -> 仅手工配方(needs:'none')
  //   工作台模式 -> 工作台配方 + 手工配方（手工基础件在工作台旁也能做）
  //   熔炉模式   -> 仅熔炼配方(needs:'furnace')，不混入任何"合成/手工"配方（熔炉只熔炼）
  const needKey = mode === 'hand' ? 'none' : mode;
  const filteredRecipes = (mode === 'furnace')
    ? RECIPES.filter(r => r.needs === 'furnace')
    : RECIPES.filter(r => r.needs === needKey || r.needs === 'none');

  let html = `<div class="craft-title"><span>${cfg.title}</span><span class="craft-close-x" id="craft-close-x" title="关闭">✕</span></div>`;

  if (cfg.needStation) {
    html += `<div class="craft-stations">`;
    html += `<span class="station-badge ${hasStation ? 'active' : 'inactive'}">${cfg.icon} ${cfg.station === 'workbench' ? '工作台' : '熔炉'} ${hasStation ? '✓ 附近' : '✗ 不在附近'}</span>`;
    html += `</div>`;

    // 工作站专属视觉装饰（纯美化，不影响合成机制）
    if (mode === 'workbench') {
      html += `<div class="station-visual wb-visual">
        <div class="wb-grid"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        <div class="station-visual-tip">🪵 组合木材与材料，合成工具与结构件</div>
      </div>`;
    } else if (mode === 'furnace') {
      html += `<div class="station-visual furnace-visual">
        <div class="furnace-flow">
          <div class="ff-slot">⛏️</div>
          <div class="ff-arrow">→</div>
          <div class="ff-flame">🔥</div>
          <div class="ff-arrow">→</div>
          <div class="ff-slot">📦</div>
        </div>
        <div class="ff-progress"><div class="ff-progress-fill"></div></div>
        <div class="station-visual-tip">🌡️ 高温烧炼矿石，熔出金属锭</div>
      </div>`;
    }
  }

  if (filteredRecipes.length === 0) {
    html += '<div class="craft-empty">暂无可用配方</div>';
  } else {
    html += '<div class="craft-list">';

    for (const r of filteredRecipes) {
      const outId = parseInt(Object.keys(r.output)[0]);
      const outCount = r.output[outId];
      const outBlock = BLOCKS[outId];
      let inputs = '';
      let canCraft = hasStation;
      for (const [id, count] of Object.entries(r.input)) {
        const b = BLOCKS[parseInt(id)];
        const have = game.inventory[parseInt(id)] || 0;
        const enough = have >= count;
        if (!enough) canCraft = false;
        inputs += `<span class="recipe-item ${enough ? '' : 'missing'}">${b.name}×${count}</span>`;
      }

      // 化学方程式
      let chemHtml = '';
      if (r.chem) {
        chemHtml = `<div class="recipe-chem">⚗ ${r.chem}</div>`;
      }

      // 工具需求提示
      let toolHtml = '';
      if (outBlock && outBlock.toolTier) {
        const tierNames = ['', '木镐', '石镐', '铁镐'];
        toolHtml = `<div class="recipe-tool-req">⛏ 挖掘等级 ${outBlock.toolTier}（${tierNames[outBlock.toolTier]}）</div>`;
      }

      html += `
        <div class="recipe-card ${canCraft ? '' : 'dimmed'}" data-idx="${RECIPES.indexOf(r)}">
          <canvas class="recipe-icon-canvas" width="32" height="32" data-block="${outId}"></canvas>
          <div class="recipe-info">
            <div class="recipe-name">${r.name} ×${outCount}</div>
            <div class="recipe-inputs">${inputs}</div>
            ${chemHtml}
            ${toolHtml}
          </div>
          <div class="recipe-btn ${canCraft ? '' : 'disabled'}">${canCraft ? '合成' : '🔒'}</div>
        </div>`;
    }

    html += '</div>';
  }

  html += `<div class="craft-close-btn" id="craft-close-btn">关闭 (Tab/Esc)</div>`;

  panel.innerHTML = html;

  // 绘制配方图标
  panel.querySelectorAll('.recipe-icon-canvas').forEach(cv => {
    const bid = parseInt(cv.dataset.block);
    const c = cv.getContext('2d');
    drawBlockIcon(c, 0, 0, 32, bid);
  });

  // 绑定合成按钮
  panel.querySelectorAll('.recipe-card[data-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx);
      craftRecipe(RECIPES[idx]);
    });
  });

  // 关闭按钮
  const closeBtn = document.getElementById('craft-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => { game.craftingOpen = false; });
  }
  // 标题栏关闭按钮（✕）
  const closeX = document.getElementById('craft-close-x');
  if (closeX) {
    closeX.addEventListener('click', () => { game.craftingOpen = false; });
  }
}

function craftRecipe(r) {
  // 再次检查
  if (r.needs === 'workbench' && !hasCraftingStation('workbench')) { showToast('需要工作台！', 1000); return; }
  if (r.needs === 'furnace' && !hasCraftingStation('furnace')) { showToast('需要熔炉！', 1000); return; }
  for (const [id, count] of Object.entries(r.input)) {
    if ((game.inventory[parseInt(id)] || 0) < count) { showToast('材料不足！', 1000); return; }
  }

  // 消耗材料
  for (const [id, count] of Object.entries(r.input)) {
    removeItem(parseInt(id), count);
  }
  // 获得产物
  for (const [id, count] of Object.entries(r.output)) {
    addItem(parseInt(id), count);
  }
  // 元素发现（S6 学习层）：合成带 element 属性的产物（如电解水制氢块）触发元素卡
  for (const [id] of Object.entries(r.output)) {
    const el = BLOCKS[parseInt(id)];
    if (el && el.element && !game.discoveredElements.has(el.element)) {
      game.discoveredElements.add(el.element);
      showElementDiscovery(el.element);
    }
  }
  sfx(r.needs === 'furnace' ? 'smelt' : 'craft');
  showToast(`合成成功：${r.name}！`, 1500);
  updateHotbar();
  game.craftingDirty = true;
}

// ==================== 背包界面 ====================
function drawInventory() {
  const overlay = document.getElementById('inventory-overlay');
  const panel = document.getElementById('inventory-panel');
  overlay.style.display = 'flex';

  const items = Object.entries(game.inventory).filter(([id, c]) => c > 0);

  let html = '<div class="inv-title"><span>🎒 背包</span><span class="inv-close-x" id="inv-close-x" title="关闭">✕</span></div>';

  if (items.length === 0) {
    html += '<div class="inv-empty">背包空空如也<br>去挖掘收集资源吧！</div>';
  } else {
    html += '<div class="inv-grid">';
    for (const [id, count] of items) {
      const blockId = parseInt(id);
      const block = BLOCKS[blockId];
      if (!block) continue;
      const inHotbar = game.hotbar.includes(blockId);
      const element = BLOCK_ELEMENTS[blockId];
      const elemInfo = element ? ELEMENT_INFO[element] : null;

      html += `<div class="inv-slot ${inHotbar ? 'in-hotbar' : ''}" data-id="${blockId}" data-dragzone="bag">`;
      if (elemInfo) {
        html += `<div class="inv-slot-elem" style="background:${elemInfo.color}"></div>`;
      }
      html += `<canvas class="inv-icon-canvas" width="32" height="32" data-block="${blockId}"></canvas>`;
      html += `<div class="inv-slot-name">${block.name}</div>`;
      html += `<div class="inv-slot-count">${count}</div>`;
      html += `<button class="inv-discard" data-id="${blockId}" title="丢弃 1 个">🗑</button>`;
      html += '</div>';
    }
    html += '</div>';
  }

  // 热栏展示
  html += '<div class="inv-hotbar-section">';
  html += '<div class="inv-hotbar-title">⬇ 热栏（拿起物品后点/拖到槽位放入；点击已有槽可选中）</div>';
  html += '<div class="inv-hotbar-grid">';
  for (let i = 0; i < 10; i++) {
    const blockId = game.hotbar[i];
    const isSelected = i === game.selectedSlot;
    html += `<div class="inv-hotbar-slot ${isSelected ? 'selected' : ''}" data-slot="${i}" data-dragzone="hotbar">`;
    html += `<span class="inv-hotbar-num">${i === 9 ? '0' : i + 1}</span>`;
    if (blockId > 0 && game.hotbarCounts[i] > 0) {
      html += `<canvas class="inv-hotbar-icon" width="32" height="32" data-block="${blockId}"></canvas>`;
    }
    html += '</div>';
  }
  html += '</div>';
  html += '</div>';

  html += '<div class="inv-close-btn" id="inv-close-btn">关闭背包 (E)</div>';

  panel.innerHTML = html;

  // 绘制物品图标
  panel.querySelectorAll('.inv-icon-canvas').forEach(cv => {
    const bid = parseInt(cv.dataset.block);
    const c = cv.getContext('2d');
    drawBlockIcon(c, 0, 0, 32, bid);
  });
  panel.querySelectorAll('.inv-hotbar-icon').forEach(cv => {
    const bid = parseInt(cv.dataset.block);
    const c = cv.getContext('2d');
    drawBlockIcon(c, 0, 0, 32, bid);
  });

  // 丢弃按钮（手机/桌面通用）：点一下丢 1 个（不计入拾起/放下搬运）
  panel.querySelectorAll('.inv-discard[data-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const blockId = parseInt(btn.dataset.id);
      discardItem(blockId, 1);
    });
  });

  // 桌面右键丢弃：右键丢 1 个，Shift+右键清空
  panel.querySelectorAll('.inv-slot[data-id]').forEach(slot => {
    slot.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const blockId = parseInt(slot.dataset.id);
      discardItem(blockId, e.shiftKey ? Infinity : 1);
    });
  });

  // 关闭按钮
  const closeBtn = document.getElementById('inv-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      game.inventoryOpen = false;
    });
  }
  // 标题栏关闭按钮（✕）
  const closeX = document.getElementById('inv-close-x');
  if (closeX) {
    closeX.addEventListener('click', () => { game.inventoryOpen = false; });
  }
}

// ==================== 箱子界面 ====================
// 左栏：玩家物品（点一下整组存入）；右栏：箱子格子（点一下整组取出）
function drawChest() {
  const overlay = document.getElementById('chest-overlay');
  const panel = document.getElementById('chest-panel');
  if (!overlay || !panel) return;
  overlay.style.display = 'flex';

  const idx = game.chestIdx;
  const arr = getChest(idx);

  // 左侧：玩家物品
  const items = Object.entries(game.inventory).filter(([id, c]) => c > 0);
  let playerHtml = '<div class="chest-empty">背包是空的</div>';
  if (items.length > 0) {
    playerHtml = '';
    for (const [id, count] of items) {
      const blockId = parseInt(id);
      const block = BLOCKS[blockId];
      if (!block) continue;
      playerHtml += `<div class="inv-slot chest-player-slot" data-id="${blockId}" data-dragzone="bag">`;
      playerHtml += `<canvas class="inv-icon-canvas" width="32" height="32" data-block="${blockId}"></canvas>`;
      playerHtml += `<div class="inv-slot-name">${block.name}</div>`;
      playerHtml += `<div class="inv-slot-count">${count}</div>`;
      playerHtml += '</div>';
    }
  }

  // 右侧：箱子格子
  let chestHtml = '';
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (s) {
      const block = BLOCKS[s.id];
      chestHtml += `<div class="chest-slot filled" data-slot="${i}" data-dragzone="chest">`;
      chestHtml += `<canvas class="inv-icon-canvas" width="32" height="32" data-block="${s.id}"></canvas>`;
      chestHtml += `<div class="chest-slot-count">${s.count}</div>`;
      chestHtml += '</div>';
    } else {
      chestHtml += `<div class="chest-slot" data-slot="${i}" data-dragzone="chest"></div>`;
    }
  }

  panel.innerHTML = `
    <div class="chest-title"><span>📦 箱子</span><span class="chest-close-x" id="chest-close-x" title="关闭">✕</span></div>
    <div class="chest-body">
      <div class="chest-col">
        <div class="chest-col-title">🎒 你的物品（拿起后拖/点到右边格子放入）</div>
        <div class="chest-grid chest-player">${playerHtml}</div>
      </div>
      <div class="chest-col">
        <div class="chest-col-title">📦 箱子（点击拿起，拖到左边/空白放回背包）</div>
        <div class="chest-grid chest-slots">${chestHtml}</div>
      </div>
    </div>
    <div class="chest-close-btn" id="chest-close-btn">关闭 (E / Esc)</div>
  `;

  // 绘制图标
  panel.querySelectorAll('.inv-icon-canvas').forEach(cv => {
    const bid = parseInt(cv.dataset.block);
    const c = cv.getContext('2d');
    drawBlockIcon(c, 0, 0, 32, bid);
  });

  // 玩家物品 → 箱子
  // 玩家物品↔箱子的搬运统一由全局指针拖放处理（拿起→拖/点到目标格放下）
  // 箱子 → 玩家
  // 箱子格“点一下取出”等操作同上，由全局指针事件统一处理

  const closeBtn = document.getElementById('chest-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => { game.chestOpen = false; });
  const closeX = document.getElementById('chest-close-x');
  if (closeX) closeX.addEventListener('click', () => { game.chestOpen = false; });
}

// 玩家整组物品搬入箱子（优先合并同 id，再填空位；满则尽量搬并提示）
function playerToChest(blockId) {
  const have = game.inventory[blockId] || 0;
  if (have <= 0) return;
  const arr = getChest(game.chestIdx);
  let remain = have;
  for (const s of arr) {
    if (remain <= 0) break;
    if (s && s.id === blockId) { s.count += remain; remain = 0; break; }
  }
  if (remain > 0) {
    for (let i = 0; i < arr.length; i++) {
      if (remain <= 0) break;
      if (!arr[i]) { arr[i] = { id: blockId, count: remain }; remain = 0; break; }
    }
  }
  const moved = have - remain;
  if (moved > 0) {
    removeItem(blockId, moved);
    game.chestDirty = true;
    updateHotbar();
  } else {
    showToast('箱子满了！', 1000);
  }
}

// 箱子某格物品整组搬回玩家
function chestToPlayer(slot) {
  const arr = getChest(game.chestIdx);
  const s = arr[slot];
  if (!s) return;
  addItem(s.id, s.count);
  arr[slot] = null;
  game.chestDirty = true;
  updateHotbar();
}

// 将物品切换进/出热栏
function toggleHotbarItem(blockId) {
  const existingSlot = game.hotbar.indexOf(blockId);
  if (existingSlot >= 0) {
    // 已在热栏中 → 从热栏移除
    game.hotbar[existingSlot] = 0;
    game.hotbarCounts[existingSlot] = 0;
    sfx('click');
  } else {
    // 不在热栏 → 找空槽放入
    const emptySlot = game.hotbar.indexOf(0);
    if (emptySlot >= 0) {
      game.hotbar[emptySlot] = blockId;
      game.hotbarCounts[emptySlot] = game.inventory[blockId] || 0;
      sfx('pickup');
    } else {
      showToast('热栏已满！', 1000);
    }
  }
}

// ==================== 背包管理 ====================
function addItem(id, count) {
  game.inventory[id] = (game.inventory[id] || 0) + count;
  // 自动加入热栏
  let slot = game.hotbar.indexOf(id);
  if (slot === -1) {
    slot = game.hotbar.indexOf(0);
    if (slot !== -1) {
      game.hotbar[slot] = id;
    }
  }
  if (slot !== -1) {
    game.hotbarCounts[slot] = (game.hotbarCounts[slot] || 0) + count;
  }
  game.inventoryDirty = true;
  game.craftingDirty = true;
}

function removeItem(id, count) {
  if (!game.inventory[id]) return;
  game.inventory[id] -= count;
  if (game.inventory[id] < 0) game.inventory[id] = 0;
  // 从热栏扣除
  let remaining = count;
  for (let i = 0; i < game.hotbar.length && remaining > 0; i++) {
    if (game.hotbar[i] === id) {
      const take = Math.min(remaining, game.hotbarCounts[i]);
      game.hotbarCounts[i] -= take;
      remaining -= take;
      if (game.hotbarCounts[i] <= 0) game.hotbar[i] = 0;
    }
  }
  game.inventoryDirty = true;
  game.craftingDirty = true;
}

// ==================== 鼠标搬运物品（Java 版“拿起→跟随→放下”） ====================
// 数据模型与 Java 一致：game.inventory 是 id→总数 的物品种类表；热栏 10 槽只是对背包物品的
// 快捷引用。交互：单击有物品的格子 = 拿起挂到光标上（图标跟手）；再单击/拖到目标格 = 放下；
// 放到不同物品格上 = 旧物放回背包并拿起新格物品（Java 的交换）；点空白 = 放回背包。
const DRAG_PICK_PX = 7;   // 按住移动超过此像素判定为“拖动”而非点击
let _drag = null;         // 当前一次指针按压的中间状态

function getDragCursorEl() {
  let el = document.getElementById('drag-cursor');
  if (!el) {
    el = document.createElement('div');
    el.id = 'drag-cursor';
    el.style.display = 'none';
    el.innerHTML = '<canvas width="34" height="34"></canvas><span class="cnt"></span>';
    document.body.appendChild(el);
  }
  return el;
}

function refreshDragCursor() {
  const el = getDragCursorEl();
  const has = game.cursorId > 0;
  el.style.display = has ? 'block' : 'none';
  if (!has) return;
  el.style.left = ((typeof game._ptrX === 'number') ? game._ptrX : window.innerWidth / 2) + 'px';
  el.style.top = ((typeof game._ptrY === 'number') ? game._ptrY : window.innerHeight / 2) + 'px';
  const cv = el.querySelector('canvas');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, 34, 34);
  if (game.cursorId > 0 && BLOCKS[game.cursorId]) drawBlockIcon(c, 0, 0, 34, game.cursorId);
  el.querySelector('.cnt').textContent = game.cursorCount > 1 ? game.cursorCount : '';
}

function posDragCursor(x, y) {
  game._ptrX = x; game._ptrY = y;
  if (game.cursorId > 0) {
    const el = document.getElementById('drag-cursor');
    if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; }
  }
}

function setCursorItem(id, count) {
  game.cursorId = id; game.cursorCount = count;
  refreshDragCursor();
}

function clearCursorItem() {
  game.cursorId = 0; game.cursorCount = 0;
  refreshDragCursor();
}

function markCursorDropTs() {
  game._cursorDropTs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
}

// 从事件目标找到所属的槽：bag=背包物品卡(hotbar 引用物总量)，hotbar=热栏槽，chest=箱子格
function uiSlotFromTarget(target) {
  if (!target || !target.closest) return null;
  if (target.closest('.inv-discard')) return null; // 垃圾桶按钮不参与搬运
  const el = target.closest('[data-dragzone]');
  if (!el) return null;
  const zone = el.getAttribute('data-dragzone');
  if (zone === 'bag') {
    const id = parseInt(el.getAttribute('data-id'), 10);
    if (!id || !(id > 0)) return null;
    return { zone, id, slot: -1 };
  }
  const slot = parseInt(el.getAttribute('data-slot'), 10);
  if (!(slot >= 0)) return null;
  return { zone, id: 0, slot };
}

// —— 各动作 ——
function pickBagItem(id) {          // 从背包整类拿起（同时移除热栏引用槽）
  if (game.cursorId > 0) return false;
  const c = game.inventory[id] || 0;
  if (c <= 0) return false;
  delete game.inventory[id];
  const f = game.hotbar.indexOf(id);
  if (f >= 0) { game.hotbar[f] = 0; game.hotbarCounts[f] = 0; }
  game.inventoryDirty = true;
  game.craftingDirty = true;
  setCursorItem(id, c);
  return true;
}

function chestPick(slot) {          // 从箱子某格拿起（格子变空）
  if (game.cursorId > 0) return false;
  const arr = getChest(game.chestIdx);
  const s = arr && arr[slot];
  if (!s) return false;
  setCursorItem(s.id, s.count);
  arr[slot] = null;
  game.chestDirty = true;
  return true;
}

function giveCursorToBag() {        // 光标物品放回背包（自动放热栏空引用槽）
  if (game.cursorId <= 0) return;
  const id = game.cursorId, count = game.cursorCount;
  game.inventory[id] = (game.inventory[id] || 0) + count;
  const f = game.hotbar.indexOf(id);
  if (f >= 0) {
    game.hotbarCounts[f] += count;
  } else {
    const s = game.hotbar.indexOf(0);
    if (s >= 0) { game.hotbar[s] = id; game.hotbarCounts[s] = game.inventory[id] || 0; }
  }
  clearCursorItem();
  markCursorDropTs();
  game.inventoryDirty = true;
  game.craftingDirty = true;
}
function dropCursorBackToBag() { giveCursorToBag(); }

function placeOrSwapBagCard(id) {   // 放到一张背包卡上：同物=放回；异物=旧物放回并拿起这张卡
  if (game.cursorId <= 0) return;
  if (id === game.cursorId) { giveCursorToBag(); return; }
  giveCursorToBag();
  if ((game.inventory[id] || 0) > 0) pickBagItem(id);
}

function placeCursorToHotbarSlot(slot) {   // 光标物品放到热栏某槽（同 Java：槽只是快捷引用）
  if (game.cursorId <= 0) return;
  if (!(slot >= 0) || slot > 9) { giveCursorToBag(); return; }
  const id = game.cursorId;
  game.inventory[id] = (game.inventory[id] || 0) + game.cursorCount;
  const f = game.hotbar.indexOf(id);       // 当前该物品所在的引用槽（-1=没在热栏）
  const other = game.hotbar[slot];         // 目标槽里的物品引用（可能为 0）
  if (f >= 0 && f !== slot) {
    if (other === 0) {
      // 物品已有引用槽且目标是空槽 → 把引用槽移过去（相当于热栏内换位置）
      game.hotbar[slot] = id; game.hotbarCounts[slot] = game.inventory[id] || 0;
      game.hotbar[f] = 0; game.hotbarCounts[f] = 0;
    } else {
      // 两边都占用 → 直接交换两个槽的引用（两物换位置）
      game.hotbar[f] = other; game.hotbarCounts[f] = game.inventory[other] || 0;
      game.hotbar[slot] = id; game.hotbarCounts[slot] = game.inventory[id] || 0;
    }
    clearCursorItem();
  } else if (f < 0) {
    if (other === 0) {
      // 目标槽空 → 直接放入
      game.hotbar[slot] = id;
      game.hotbarCounts[slot] = game.inventory[id] || 0;
      clearCursorItem();
    } else {
      // 目标槽被别的物品占用 → 两物交换：新物品占槽，原槽物品进光标
      const oc = game.inventory[other] || 0;
      game.hotbar[slot] = id; game.hotbarCounts[slot] = game.inventory[id] || 0;
      setCursorItem(other, oc);
    }
  } else {
    game.hotbarCounts[slot] = game.inventory[id] || 0; // f===slot，数值同步
    clearCursorItem();
  }
  markCursorDropTs();
  game.inventoryDirty = true;
  game.craftingDirty = true;
}

function placeCursorIntoChestSlot(slot) {  // 光标物品放进箱子某格（空/同物合并/异物交换）
  if (game.cursorId <= 0) return;
  const arr = getChest(game.chestIdx);
  if (!arr || !(slot >= 0) || slot >= arr.length) { giveCursorToBag(); return; }
  const old = arr[slot];
  if (!old) {
    arr[slot] = { id: game.cursorId, count: game.cursorCount };
    clearCursorItem();
  } else if (old.id === game.cursorId) {
    old.count += game.cursorCount;
    clearCursorItem();
  } else {
    const cid = game.cursorId, cc = game.cursorCount;
    setCursorItem(old.id, old.count);        // 把目标格里的东西换到手里
    arr[slot] = { id: cid, count: cc };
  }
  markCursorDropTs();
  game.chestDirty = true;
}

function placeDragCursorAt(t) {
  if (game.cursorId <= 0) return;
  if (!t) { giveCursorToBag(); return; }
  if (t.zone === 'bag') placeOrSwapBagCard(t.id);
  else if (t.zone === 'hotbar') placeCursorToHotbarSlot(t.slot);
  else if (t.zone === 'chest') placeCursorIntoChestSlot(t.slot);
}

// —— 指针事件（背包/箱子面板上的 点击-拿起 / 按住拖动-放下）——
function pressDragPointer(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const uiOn = game.craftingOpen || game.inventoryOpen || game.chestOpen;
  if (!uiOn || _drag) return;
  if (e.target && e.target.closest && e.target.closest('.inv-discard')) return;
  posDragCursor(e.clientX, e.clientY);
  const s = uiSlotFromTarget(e.target);
  if (s) _drag = { zone: s.zone, id: s.id, slot: s.slot, x: e.clientX, y: e.clientY, dragged: false };
  else _drag = { zone: '', id: 0, slot: -1, x: e.clientX, y: e.clientY, dragged: false };
}

function moveDragPointer(e) {
  if (game.cursorId > 0) posDragCursor(e.clientX, e.clientY);
  else { game._ptrX = e.clientX; game._ptrY = e.clientY; }
  if (!_drag || _drag.dragged) return;
  const dist = Math.hypot(e.clientX - _drag.x, e.clientY - _drag.y);
  if (dist < DRAG_PICK_PX) return;
  // 移动超过阈值：视为“按住拖动”。手里没东西且源格有物→立刻拿起
  if (game.cursorId <= 0) {
    if (_drag.zone === 'bag' && (game.inventory[_drag.id] || 0) > 0) _drag.dragged = pickBagItem(_drag.id);
    else if (_drag.zone === 'chest') _drag.dragged = chestPick(_drag.slot);
    else _drag.dragged = true; // 热栏槽等无可拿起的格子，单纯标记为拖动
  } else {
    _drag.dragged = true;
  }
}

function releaseDragPointer(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const p = _drag;
  if (!p) return;
  _drag = null;
  const t = uiSlotFromTarget(e.target);
  if (p.dragged) { placeDragCursorAt(t); return; }   // 拖动后松手→放到目标格
  if (game.cursorId > 0) { placeDragCursorAt(t); return; } // 未拖动但有持有物→视为“点目标格放下”
  if (!p.zone) return;                                 // 空白单击
  if (p.zone === 'bag' && (game.inventory[p.id] || 0) > 0) pickBagItem(p.id);
  else if (p.zone === 'chest') chestPick(p.slot);
  else if (p.zone === 'hotbar' && game.hotbar[p.slot] > 0) { game.selectedSlot = p.slot; game.inventoryDirty = true; sfx('click'); }
}

function cancelDragPointer() {
  if (_drag) _drag = null;
  if (game.cursorId > 0) giveCursorToBag(); // 触摸手势被打断时安全放回，避免“物品被吞”
}

function bindCursorDrag() {
  window.addEventListener('pointerdown', pressDragPointer, true);
  window.addEventListener('pointermove', moveDragPointer);
  window.addEventListener('pointerup', releaseDragPointer, true);
  window.addEventListener('pointercancel', cancelDragPointer);
}

// 硫磺弹(52)与闪光弹(78)是可引爆投掷物
function isThrowable(id) { return id === 52 || id === 78; }

// 丢弃方向：优先朝准星(鼠标/触屏瞄准)水平方向，与挖掘/攻击一致；
// 准星未初始化或几乎正对玩家时回退到键盘 facing，避免 NaN 误判一直向左。
function dropFacingSign() {
  const p = game.player;
  const mx = (game.mouse && typeof game.mouse.worldX === 'number') ? game.mouse.worldX : null;
  if (mx === null) return p.facing || 1;
  const dx = mx - (p.x + p.w / 2);
  if (!isFinite(dx) || Math.abs(dx) < 1) return p.facing || 1;
  return dx > 0 ? 1 : -1;
}

// 在玩家朝向 2 格处生成掉落物（用于丢弃/甩落）。硫磺弹会被标记为可引爆。
function dropAtFacing(id, count) {
  const p = game.player;
  const f = dropFacingSign();
  const tx = Math.floor((p.x + p.w / 2) / TILE) + f * 2;
  const ty = Math.floor((p.y + p.h / 2) / TILE);
  const x = tx * TILE + TILE / 2;
  const y = ty * TILE + TILE / 2;
  const isBomb = isThrowable(id);
  // 掉落物总量上限：防止挖矿/战斗长时间累积后每帧遍历与绘制拖垮帧率
  if (game.droppedItems.length > 400) game.droppedItems.splice(0, game.droppedItems.length - 400);
  if (isBomb) {
    const n = Math.min(count, 16); // 限制同时引爆数量，避免卡顿
    for (let k = 0; k < n; k++) {
      game.droppedItems.push({
        x: x + (Math.random() - 0.5) * 14,
        y: y + (Math.random() - 0.5) * 14,
        id, count: 1,
        vx: (Math.random() - 0.5) * 2, vy: -2,
        life: 2000, noPickup: true, isBomb: true, fuse: 800,
      });
    }
  } else {
    game.droppedItems.push({ x, y, id, count, vx: 0, vy: 0, life: 60000 }); // 60 秒内可重新捡起
  }
}

// 丢弃物品：直接在玩家朝向 2 格处落地为可拾取掉落物（不再凭空消失）
// count 不传则丢弃 1 个；传 Infinity 则全部丢弃。硫磺弹丢弃后会引爆。
function discardItem(id, count) {
  const have = game.inventory[id] || 0;
  if (have <= 0) return;
  const isBomb = isThrowable(id);
  const maxN = isBomb ? 16 : have; // 硫磺弹限制单次引爆数量
  const n = Math.min(count == null ? 1 : count, have, maxN);
  removeItem(id, n);
  dropAtFacing(id, n);
  const name = BLOCKS[id] ? BLOCKS[id].name : '物品';
  showToast(isBomb ? `💣 丢弃 ${name} ×${n}（即将引爆）` : `🗑 丢弃 ${name} ×${n}`, 900);
  sfx('click');
  game.inventoryDirty = true;
  if (game.inventoryOpen) drawInventory();
}

// 甩落当前手持物品：从热栏扣 1 个，朝玩家面向 2 格处抛出为掉落物（可再拾取）
function dropSelected() {
  const slot = game.selectedSlot;
  const id = game.hotbar[slot];
  if (!id || game.hotbarCounts[slot] <= 0) return;
  const p = game.player;
  const f = dropFacingSign();
  const tx = Math.floor((p.x + p.w / 2) / TILE) + f * 2;
  const ty = Math.floor((p.y + p.h / 2) / TILE);
  removeItem(id, 1);
  const isBomb = isThrowable(id);
  game.droppedItems.push({
    x: tx * TILE + TILE / 2,
    y: ty * TILE + TILE / 2,
    id: id,
    count: 1,
    vx: f * 4,
    vy: -4,
    life: isBomb ? 2000 : 60000,
    noPickup: isBomb,
    isBomb: isBomb,
    fuse: isBomb ? 800 : 0,
  });
  sfx(isBomb ? 'lava' : 'drop', { pan: audioPan(p.x + p.w / 2) });
}

// 爆炸：摧毁半径内方块、按距离伤害玩家与敌人、产生粒子反馈
function explode(cx, cy, R) {
  const ctx0 = Math.floor(cx / TILE), cty0 = Math.floor(cy / TILE);
  for (let y = cty0 - R; y <= cty0 + R; y++) {
    for (let x = ctx0 - R; x <= ctx0 + R; x++) {
      if (x < 0 || y < 0 || x >= WORLD_W || y >= WORLD_H) continue;
      const d = Math.hypot(x - ctx0, y - cty0);
      if (d > R) continue;
      const t = getTile(x, y);
      if (t !== 0 && t !== 12 && t !== 63) { setTile(x, y, 0); syncBlockChange(x, y, 0); } // 液体保留，其余炸空
    }
  }
  // 玩家伤害（按距离衰减）
  const p = game.player;
  const pd = Math.hypot((p.x + p.w / 2) - cx, (p.y + p.h / 2) - cy);
  const reach = (R + 1) * TILE;
  if (pd < reach && p.invuln <= 0) {
    const dmg = Math.round(BOMB_PLAYER_DAMAGE * (1 - pd / reach));
    if (dmg > 0) {
      p.health -= dmg;
      p.invuln = 800;
      p.lastDamageTime = performance.now();
      const ang = Math.atan2((p.y + p.h / 2) - cy, (p.x + p.w / 2) - cx);
      p.vx = Math.cos(ang) * 8; p.vy = Math.sin(ang) * 8 - 4;
      sfx('hurt');
    }
  }
  // 敌人伤害
  for (const e of game.enemies) {
    const ed = Math.hypot((e.x + e.w / 2) - cx, (e.y + e.h / 2) - cy);
    if (ed < reach) {
      e.health -= 60;
      if (e.health <= 0) sfx('enemyDie', { pan: audioPan(e.x + e.w / 2) });
      const ang = Math.atan2((e.y + e.h / 2) - cy, (e.x + e.w / 2) - cx);
      e.vx = Math.cos(ang) * 8; e.vy = Math.sin(ang) * 8 - 4;
    }
  }
  // 视觉反馈
  spawnParticles(cx, cy, '#ffcc44', 28);
  spawnParticles(cx, cy, '#ff5522', 18);
  spawnParticles(cx, cy, '#888888', 10);
  sfx('lava', { pan: audioPan(cx) });
}

// 闪光弹（镁弹）：镁燃烧 2Mg+O₂→2MgO 产生耀眼白光——范围内玩家全屏白闪、敌人短暂眩晕
// 不破坏方块，只致盲（设计：非致命控场，区别于硫磺弹的爆破）
function flashBang(cx, cy) {
  const R = 4; // 致盲半径（格）
  const reach = (R + 1) * TILE;

  // 玩家：全屏白闪 + 轻微击退
  const p = game.player;
  const pd = Math.hypot((p.x + p.w / 2) - cx, (p.y + p.h / 2) - cy);
  if (pd < reach) {
    game.flashAlpha = 0.95; // 全屏白闪（render 末尾绘制，随时间衰减）
    if (p.invuln <= 0) {
      const ang = Math.atan2((p.y + p.h / 2) - cy, (p.x + p.w / 2) - cx);
      p.vx += Math.cos(ang) * 3; p.vy += Math.sin(ang) * 3 - 2;
    }
  }

  // 敌人：眩晕 2 秒（停止移动/攻击，AI 判定 e.stun 期间跳过）
  for (const e of game.enemies) {
    const ed = Math.hypot((e.x + e.w / 2) - cx, (e.y + e.h / 2) - cy);
    if (ed < reach) e.stun = Math.max(e.stun || 0, 2000);
  }

  // 视觉反馈：白光爆闪粒子
  spawnParticles(cx, cy, '#ffffff', 40);
  spawnParticles(cx, cy, '#f0f0ff', 30);
  sfx('lava', { pan: audioPan(cx) });

  // 联机：广播闪光事件，其他客户端按距离自己判定是否被闪
  const mp = game.multiplayer;
  if (mp.ws && mp.ws.readyState === 1) {
    mp.ws.send(JSON.stringify({ type: 'flash', x: cx, y: cy }));
  }
}

// 睡床跳过夜晚：仅在夜晚可睡，睡后时间跳到早晨(time=0)
// 右键/点按床：锚定重生点（无论昼夜）+ 夜晚跳夜。tx/ty 为床的世界格坐标
function sleepInBed(tx, ty) {
  game.spawnPoint = { tx, ty }; // 床 = 重生点（放置/点按即锚定，单人&联机均为本端状态）
  if (game.time >= 0.5 && game.time < 0.95) {
    game.time = 0; // 本地立即跳到早晨（下一帧 update 自然切换昼夜音效 + 渲染变亮）
    showToast('💤 设好重生点，睡了一觉跳过夜晚', 1500);
    sfx('click');
    // 联机：通知服务端把权威时钟也跳到早晨，全员同步跳过黑夜
    const mp = game.multiplayer;
    if (mp && mp.connected) {
      if (mp.ws && mp.ws.readyState === 1) {
        mp.ws.send(JSON.stringify({ type: 'sleep' }));
      } else if (mp.httpMode && mp.myId !== null) {
        httpPost('/api/sleep', { id: mp.myId });
      }
    }
  } else {
    showToast('已设置床为重生点', 1200);
  }
}

function updateHotbar() {
  // 重建热栏数据
  const items = Object.entries(game.inventory).filter(([id, c]) => c > 0);
  game.hotbar = [0,0,0,0,0,0,0,0,0,0];
  game.hotbarCounts = [0,0,0,0,0,0,0,0,0,0];
  items.slice(0, 10).forEach(([id, count], i) => {
    game.hotbar[i] = parseInt(id);
    game.hotbarCounts[i] = count;
  });
  game.inventoryDirty = true;
  game.craftingDirty = true;
}

// ==================== UI 更新 ====================
// 在线玩家栏：完整列出所有在线玩家，超出可视高度时由 CSS 的 overflow-y 滚动
function updatePlayerList() {
  // 缓存 DOM 引用（每帧 getElementById 是浪费——帧率优化）
  if (!game._playerListDom) {
    game._playerListDom = {
      body: document.getElementById('player-list-body'),
      count: document.getElementById('player-count'),
    };
  }
  const body = game._playerListDom.body;
  const countEl = game._playerListDom.count;
  if (!body || !countEl) return;

  const mp = game.multiplayer;

  // 脏检查：玩家列表内容没变化就不重建 DOM（每帧重建 innerHTML 是帧率杀手）
  const keyParts = [mp.connected ? '1' : '0', game.nickname || '', String(game.multiplayer.players.size)];
  for (const [id, rp] of mp.players) {
    if (id === mp.myId) continue;
    keyParts.push(id + ':' + (rp.nickname || '') + ':' + (rp.hasPosition ? '1' : '0'));
  }
  const key = keyParts.join('|');
  if (game._playerListKey === key) return; // 无变化，跳过 DOM 重建
  game._playerListKey = key;

  if (!mp.connected) {
    body.innerHTML = `<div class="player-list-item other"><span class="dot" style="background:#f80"></span>连接中...</div>`;
    countEl.textContent = '...';
    return;
  }

  // 收集所有要展示的玩家（自己优先，再按加入顺序排其它玩家）
  const entries = [];
  if (game.nickname) {
    entries.push({ nick: game.nickname + ' (我)', color: '#00d4ff', self: true });
  }
  for (const [id, rp] of mp.players) {
    if (id === mp.myId) continue;
    entries.push({ nick: rp.nickname || '玩家', color: rp.hasPosition ? '#ff6b9d' : '#666', self: false });
  }

  const total = entries.length;
  let html = '';
  for (const en of entries) {
    html += `<div class="player-list-item ${en.self ? 'self' : 'other'}"><span class="dot" style="background:${en.color}"></span>${escapeHtml(en.nick)}</div>`;
  }

  body.innerHTML = html;
  countEl.textContent = total;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function updateUI() {
  // 在线玩家列表
  updatePlayerList();

  // 同步 body class（控制手机控件显隐）——仅在状态变化时改，避免每帧触发样式重算
  const cls = ['crafting-open', 'inventory-open', 'battle-open'];
  const cur = (game.craftingOpen ? 1 : 0) | (game.inventoryOpen ? 2 : 0) | (game.battleOpen ? 4 : 0);
  if (game._uiClassKey !== cur) {
    game._uiClassKey = cur;
    document.body.classList.toggle('crafting-open', game.craftingOpen);
    document.body.classList.toggle('inventory-open', game.inventoryOpen);
    document.body.classList.toggle('battle-open', game.battleOpen);
  }

  // 缓存 overlay DOM 引用（每帧 getElementById 是浪费——帧率优化）
  if (!game._uiOverlays) {
    game._uiOverlays = {
      craft: document.getElementById('crafting-overlay'),
      inv: document.getElementById('inventory-overlay'),
      chest: document.getElementById('chest-overlay'),
    };
  }
  const { craft: overlay, inv: invOverlay, chest: chestOverlay } = game._uiOverlays;

  // 安全兜底：三个面板都关闭时，如果手里还拿着物品，自动放回背包（防丢失）
  if (game.cursorId > 0 && !game.craftingOpen && !game.inventoryOpen && !game.chestOpen) {
    giveCursorToBag();
  }

  if (!game.craftingOpen && overlay.style.display !== 'none') {
    overlay.style.display = 'none';
  } else if (game.craftingOpen) {
    if (game.craftingDirty || overlay.style.display === 'none') {
      overlay.style.display = 'flex';
      game.craftingDirty = false;
      drawCrafting();
    }
  }

  if (!game.inventoryOpen && invOverlay.style.display !== 'none') {
    invOverlay.style.display = 'none';
  } else if (game.inventoryOpen) {
    if (game.inventoryDirty || invOverlay.style.display === 'none') {
      invOverlay.style.display = 'flex';
      game.inventoryDirty = false;
      drawInventory();
    }
  }

  // 箱子界面（与背包/合成同样的按需重绘调度）
  if (chestOverlay) {
    if (!game.chestOpen && chestOverlay.style.display !== 'none') {
      chestOverlay.style.display = 'none';
    } else if (game.chestOpen) {
      if (game.chestDirty || chestOverlay.style.display === 'none') {
        chestOverlay.style.display = 'flex';
        game.chestDirty = false;
        drawChest();
      }
    }
  }
}

// ==================== 近战攻击（剑）与耐久 ====================
// 击杀掉落按怪物类型（公共逻辑，供卡牌对战与近战共用）：史莱姆=煤炭；蜘蛛=铁锭(60%)/煤炭(40%)；石魔像=钻石(20%)/金矿(35%)/铁矿(45%)
function dropEnemyLoot(en) {
  let dropId = 7, dropCount = 1, dropName = '煤矿';
  if (en.type === 'spider') {
    const r = Math.random();
    if (r < 0.6) { dropId = 20; dropName = '铁锭'; }
  } else if (en.type === 'golem') {
    const r = Math.random();
    if (r < 0.2) { dropId = 11; dropName = '钻石'; }
    else if (r < 0.55) { dropId = 10; dropName = '金矿'; }
    else { dropId = 9; dropName = '铁矿'; }
  }
  // 修复战利品 0.6 秒就消失的 bug：life 单位为毫秒，原 600ms 几乎来不及捡。
  // 统一为 60 秒（与丢弃/死亡掉落一致），并给战利品一个朝玩家方向的小初速，击杀后更容易滚到脚边。
  const p = game.player;
  const dir = p ? Math.sign((p.x + p.w / 2) - (en.x + en.w / 2)) : 1;
  game.droppedItems.push({
    x: en.x + en.w / 2 - 4, y: en.y,
    id: dropId, count: dropCount,
    vx: (dir || 1) * (0.8 + Math.random() * 1.4), vy: -4,
    life: 60000,
  });
  return { id: dropId, count: dropCount, name: dropName };
}

// 消耗当前手持工具的耐久（剑等带 durability 的工具）；归零则工具损坏消失
function consumeToolDurability() {
  const slot = game.selectedSlot;
  const id = game.hotbar[slot];
  const b = BLOCKS[id];
  if (!b || !b.durability) return;
  if (!game.toolDur) game.toolDur = {};
  const cur = (game.toolDur[slot] == null) ? b.durability : game.toolDur[slot];
  const next = cur - 1;
  game.toolDur[slot] = next;
  if (next <= 0) {
    game.toolDur[slot] = 0;
    const name = b.name;
    removeItem(id, 1);
    showToast(`💥 ${name} 损坏了！`, 1500);
    sfx('hurt');
    if (game.inventoryOpen) drawInventory();
    if (game.hotbarCounts[slot] <= 0) game.hotbar[slot] = 0;
  }
}

// 近战攻击：手持剑点击敌人直接造成伤害（有耐久），击杀掉战利品
function meleeAttack(en) {
  const held = game.hotbar[game.selectedSlot];
  const heldBlock = BLOCKS[held];
  if (!heldBlock || heldBlock.tool !== 'sword') return;
  const dmg = heldBlock.damage || 5;
  en.health -= dmg;
  const ex = en.x + en.w / 2, ey = en.y + en.h / 2;
  spawnParticles(ex, ey, '#ff8844', 12);
  sfx('attack');
  consumeToolDurability(); // 每次挥击消耗 1 耐久

  if (en.health <= 0) {
    en.health = 0;
    spawnParticles(ex, ey, '#44ff00', 25);
    const loot = dropEnemyLoot(en);
    showToast(`🎉 击败${ENEMY_NAMES[en.type] || '敌人'}！+${loot.count} ${loot.name}`, 1500);
    if (window.Sound) Sound.play('enemyDie', { pan: audioPan(ex) });
    const idx = game.enemies.indexOf(en);
    if (idx >= 0) game.enemies.splice(idx, 1);
  } else {
    showToast(`⚔️ ${ENEMY_NAMES[en.type] || '敌人'}受到 ${dmg} 伤害！`, 900);
  }
  game.battleCooldown = 300; // 近战短暂冷却，防止连点帧杀
}

// ==================== 卡牌对战系统 ====================
function openBattle(enemy) {
  game.battleTarget = enemy;
  game.battleCards = [];
  game.battleOpen = true;
  game.paused = true;
  game.battleAnimating = false;
  sfx('battle');
  drawBattle();
}

function closeBattle() {
  game.battleTarget = null;
  game.battleCards = [];
  game.battleOpen = false;
  game.battleAnimating = false;
  game.paused = false;
  game.battleCooldown = 500;
  const overlay = document.getElementById('battle-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ==================== 元素发现系统 ====================
function showElementDiscovery(symbol) {
  const elem = PERIODIC_TABLE[symbol];
  if (!elem) return;

  game.elementPopupActive = true;
  const overlay = document.getElementById('element-overlay');
  const panel = document.getElementById('element-panel');
  if (!overlay || !panel) return;

  // 周期表分类颜色
  const catColors = {
    '非金属':       '#3acc5a',
    '过渡金属':     '#3a9bff',
    'post-transition': '#9b59b6',
    '类金属':       '#30d0d0',
  };
  const catColor = catColors[elem.category] || '#888';

  let html = '';
  html += '<div class="element-popup-header">';
  html += `<div class="element-discover-badge">🔬 新元素发现！</div>`;
  html += '</div>';

  html += '<div class="element-card-outer">';
  html += `<div class="element-card" style="border-color:${catColor};box-shadow:0 0 30px ${catColor}40">`;
  html += `<div class="element-number" style="color:${catColor}">${elem.number}</div>`;
  html += `<div class="element-symbol" style="color:${catColor}">${elem.symbol}</div>`;
  html += `<div class="element-name-cn">${elem.name}</div>`;
  html += `<div class="element-name-en">${elem.nameEn}</div>`;
  html += `<div class="element-mass">${elem.mass}</div>`;
  html += `</div>`;
  html += '</div>';

  html += '<div class="element-details">';
  html += `<div class="element-detail-row"><span class="detail-label">原子序数</span><span class="detail-val">${elem.number}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">元素符号</span><span class="detail-val" style="color:${catColor};font-weight:700">${elem.symbol}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">中文名称</span><span class="detail-val">${elem.name}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">英文名称</span><span class="detail-val">${elem.nameEn}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">相对原子质量</span><span class="detail-val">${elem.mass}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">元素分类</span><span class="detail-val" style="color:${catColor}">${elem.category}</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">族 / 周期</span><span class="detail-val">第${elem.group}族 / 第${elem.period}周期</span></div>`;
  html += `<div class="element-detail-row"><span class="detail-label">电子构型</span><span class="detail-val" style="font-family:monospace;font-size:11px">${elem.config}</span></div>`;
  html += '</div>';

  html += `<div class="element-desc">${elem.desc}</div>`;

  // 已发现元素统计
  const total = Object.keys(PERIODIC_TABLE).length;
  const found = game.discoveredElements.size;
  html += `<div class="element-progress">已发现 ${found} / ${total} 种化学元素</div>`;

  html += '<div class="element-close-btn" id="element-close-btn">继续探索</div>';

  panel.innerHTML = html;
  overlay.style.display = 'flex';

  // 添加粒子庆祝效果
  const cx = game.cw / 2;
  const cy = game.ch / 2;
  for (let i = 0; i < 30; i++) {
    spawnParticles(cx, cy, catColor, 1);
  }
  sfx('discover');

  // 绑定关闭
  const closeBtn = document.getElementById('element-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeElementPopup);
  }
  overlay.addEventListener('click', function handler(e) {
    if (e.target === overlay) {
      closeElementPopup();
      overlay.removeEventListener('click', handler);
    }
  });
}

function closeElementPopup() {
  game.elementPopupActive = false;
  const overlay = document.getElementById('element-overlay');
  if (overlay) overlay.style.display = 'none';
}

function drawBattle() {
  const overlay = document.getElementById('battle-overlay');
  const panel = document.getElementById('battle-panel');
  if (!overlay || !panel) return;
  overlay.style.display = 'flex';

  const en = game.battleTarget;
  if (!en) { closeBattle(); return; }

  const enHpPct = Math.max(0, en.health / en.maxHealth);
  const pHpPct = Math.max(0, game.player.health / game.player.maxHealth);
  const enemyName = ENEMY_NAMES[en.type] || '怪物';

  let html = '<div class="battle-title">⚔️ 元素对战</div>';

  // 敌人信息
  html += '<div class="battle-combatant">';
  html += `<span class="battle-combatant-name">🟢 ${enemyName}</span>`;
  html += `<div class="battle-hp-bar"><div class="battle-hp-fill" style="width:${enHpPct*100}%;background:#ff3333"></div><span class="battle-hp-text">${Math.ceil(en.health)}/${en.maxHealth}</span></div>`;
  html += '</div>';

  // 玩家信息
  html += '<div class="battle-combatant">';
  html += '<span class="battle-combatant-name">🧑 玩家</span>';
  html += `<div class="battle-hp-bar"><div class="battle-hp-fill" style="width:${pHpPct*100}%;background:#22cc44"></div><span class="battle-hp-text">${Math.ceil(game.player.health)}/${game.player.maxHealth}</span></div>`;
  html += '</div>';

  // 卡牌选择区
  html += '<div class="battle-section-title">📋 选择攻击卡牌（最多3种）</div>';
  html += '<div class="battle-cards">';

  let availableCards = 0;
  for (let i = 0; i < game.hotbar.length; i++) {
    const blockId = game.hotbar[i];
    const count = game.hotbarCounts[i];
    if (blockId === 0 || count <= 0) continue;
    availableCards++;
    const block = BLOCKS[blockId];
    const element = BLOCK_ELEMENTS[blockId];
    const elemInfo = element ? ELEMENT_INFO[element] : null;
    const selected = game.battleCards.includes(i);

    html += `<div class="battle-card ${selected ? 'selected' : ''}" data-slot="${i}" style="${selected ? 'border-color:' + (elemInfo ? elemInfo.color : '#00d4ff') : ''}">`;
    html += `<div class="battle-card-icon" style="background:${block.color}">${BLOCK_EMOJI[blockId] || '🧱'}</div>`;
    html += `<div class="battle-card-name">${block.name}</div>`;
    if (elemInfo) {
      html += `<div class="battle-card-elem" style="color:${elemInfo.color}">${elemInfo.icon} ${elemInfo.name}</div>`;
    } else {
      html += '<div class="battle-card-elem" style="color:#666">无属性</div>';
    }
    html += `<div class="battle-card-count">×${count}</div>`;
    html += '</div>';
  }

  if (availableCards === 0) {
    html += '<div class="battle-no-cards">背包中没有可用物品！<br>挖掘收集材料后再来挑战</div>';
  }
  html += '</div>';

  // 已选卡牌槽
  html += '<div class="battle-selected-area">';
  html += '<span class="battle-selected-label">已选卡牌：</span>';
  for (let s = 0; s < 3; s++) {
    if (s < game.battleCards.length) {
      const slot = game.battleCards[s];
      const blockId = game.hotbar[slot];
      const block = BLOCKS[blockId];
      const element = BLOCK_ELEMENTS[blockId];
      const elemInfo = element ? ELEMENT_INFO[element] : null;
      const borderColor = elemInfo ? elemInfo.color : '#666';
      html += `<div class="battle-selected-card" data-slot="${slot}" style="border-color:${borderColor}">`;
      html += `${BLOCK_EMOJI[blockId] || '🧱'} ${block.name}`;
      if (elemInfo) html += ` <span style="color:${elemInfo.color}">${elemInfo.icon}</span>`;
      html += '</div>';
    } else {
      html += '<div class="battle-selected-card empty">＋</div>';
    }
  }
  html += '</div>';

  // 元素反应检测
  const reaction = checkElementReaction();
  html += '<div class="battle-reaction">';
  if (reaction) {
    html += `<div class="reaction-found" style="border-color:${ELEMENT_INFO[reaction.a].color}">`;
    html += `✨ ${reaction.icon} <b>${reaction.name}</b> — ${reaction.desc}！<br>伤害 ×2`;
    html += '</div>';
  } else if (game.battleCards.length >= 2) {
    html += '<div class="reaction-none">⚪ 无元素反应，仅基础伤害</div>';
  } else if (game.battleCards.length === 1) {
    html += '<div class="reaction-hint">💡 再选1~2张卡牌可能触发元素反应</div>';
  } else {
    html += '<div class="reaction-hint">👆 点击上方卡牌选择攻击</div>';
  }
  html += '</div>';

  // 预计伤害
  if (game.battleCards.length > 0) {
    const baseDmg = game.battleCards.length * 10;
    const totalDmg = reaction ? baseDmg * 2 : baseDmg;
    html += `<div class="battle-damage">预计伤害：<b class="dmg-num">${totalDmg}</b>${reaction ? ' ✨含反应加成' : ''}</div>`;
  }

  // 按钮
  const canAttack = game.battleCards.length > 0 && !game.battleAnimating;
  const canPunch = !game.battleAnimating;
  html += '<div class="battle-buttons">';
  html += `<button class="battle-btn attack" ${canAttack ? '' : 'disabled'}>⚔️ 攻击</button>`;
  html += `<button class="battle-btn punch" ${canPunch ? '' : 'disabled'}>✊ 拳击(5)</button>`;
  html += `<button class="battle-btn flee" ${game.battleAnimating ? 'disabled' : ''}>🏃 逃跑</button>`;
  html += '</div>';

  // 元素反应速查
  html += '<details class="battle-cheatsheet"><summary>📖 元素反应速查</summary><div class="cheatsheet-grid">';
  for (const r of ELEMENT_REACTIONS) {
    const ea = ELEMENT_INFO[r.a];
    const eb = ELEMENT_INFO[r.b];
    html += `<div class="cheatsheet-item"><span style="color:${ea.color}">${ea.icon}${ea.name}</span> + <span style="color:${eb.color}">${eb.icon}${eb.name}</span> → <b>${r.icon} ${r.name}</b></div>`;
  }
  html += '</div></details>';

  panel.innerHTML = html;

  // 绑定事件
  panel.querySelectorAll('.battle-card[data-slot]').forEach(card => {
    card.addEventListener('click', () => {
      if (game.battleAnimating) return;
      const slot = parseInt(card.dataset.slot);
      toggleBattleCard(slot);
    });
  });
  panel.querySelectorAll('.battle-selected-card[data-slot]').forEach(card => {
    card.addEventListener('click', () => {
      if (game.battleAnimating) return;
      const slot = parseInt(card.dataset.slot);
      toggleBattleCard(slot);
    });
  });
  const atkBtn = panel.querySelector('.battle-btn.attack');
  if (atkBtn && !atkBtn.disabled) atkBtn.addEventListener('click', executeBattleAttack);
  const punchBtn = panel.querySelector('.battle-btn.punch');
  if (punchBtn && !punchBtn.disabled) punchBtn.addEventListener('click', executePunch);
  const fleeBtn = panel.querySelector('.battle-btn.flee');
  if (fleeBtn && !fleeBtn.disabled) fleeBtn.addEventListener('click', () => {
    closeBattle();
    showToast('逃跑成功！', 1000);
  });
}

function toggleBattleCard(slot) {
  const idx = game.battleCards.indexOf(slot);
  if (idx >= 0) {
    game.battleCards.splice(idx, 1);
  } else if (game.battleCards.length < 3) {
    game.battleCards.push(slot);
  }
  sfx('click');
  drawBattle();
}

function checkElementReaction() {
  if (game.battleCards.length < 2) return null;
  const elements = game.battleCards
    .map(slot => BLOCK_ELEMENTS[game.hotbar[slot]])
    .filter(e => e);
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      for (const r of ELEMENT_REACTIONS) {
        if ((r.a === a && r.b === b) || (r.a === b && r.b === a)) {
          return r;
        }
      }
    }
  }
  return null;
}

function executeBattleAttack() {
  if (game.battleCards.length === 0 || game.battleAnimating) return;
  const en = game.battleTarget;
  if (!en) return;

  game.battleAnimating = true;

  // 计算伤害
  const baseDmg = game.battleCards.length * 10;
  const reaction = checkElementReaction();
  const totalDmg = reaction ? baseDmg * 2 : baseDmg;

  // 消耗物品
  game.battleCards.forEach(slot => {
    const blockId = game.hotbar[slot];
    removeItem(blockId, 1);
  });

  sfx('attack');

  // 粒子效果
  const ex = en.x + en.w / 2;
  const ey = en.y + en.h / 2;
  if (reaction) {
    spawnParticles(ex, ey, '#ffaa00', 20);
    spawnParticles(ex, ey, ELEMENT_INFO[reaction.a].color, 15);
    showToast(`✨ ${reaction.name}！伤害×2 → ${totalDmg}`, 1500);
  } else {
    spawnParticles(ex, ey, '#88ff44', 12);
    showToast(`攻击造成 ${totalDmg} 伤害`, 1000);
  }

  // 清空选牌
  game.battleCards = [];
  updateHotbar();

  // 判定：伤害 >= 怪物当前血量 → 击杀
  if (totalDmg >= en.health) {
    en.health = 0;
    drawBattle(); // 先显示血条归零

    setTimeout(() => {
      spawnParticles(ex, ey, '#44ff00', 25);
      // 击杀掉落（公共函数，按怪物类型）
      const loot = dropEnemyLoot(en);
      showToast(`🎉 击败${ENEMY_NAMES[en.type] || '敌人'}！+${loot.count} ${loot.name}`, 1500);
      if (window.Sound) Sound.play('enemyDie', { pan: audioPan(ex) });
      const idx = game.enemies.indexOf(en);
      if (idx >= 0) game.enemies.splice(idx, 1);
      closeBattle();
    }, 800);
    return;
  }

  // 否则：怪物存活，扣血后反击玩家
  en.health -= totalDmg;
  drawBattle(); // 显示怪物扣血后的血条

  setTimeout(() => {
    if (!game.battleOpen || !game.battleTarget) { return; }
    // 反击伤害按怪物强度：史莱姆 6-11 / 蜘蛛 9-14 / 石魔像 14-20
    const base = (en.damage || 8) * 0.8;
    const counterDmg = Math.floor(base + Math.random() * 6);
    game.player.health -= counterDmg;
    if (game.player.health < 0) game.player.health = 0;
    game.player.invuln = 800;
    game.player.lastDamageTime = performance.now();
    sfx('hurt');
    spawnParticles(
      game.player.x + game.player.w / 2,
      game.player.y + game.player.h / 2,
      '#ff3333', 10
    );
    showToast(`💥 ${ENEMY_NAMES[en.type] || '敌人'}反击！-${counterDmg} HP`, 1000);
    drawBattle();

    if (game.player.health <= 0) {
      setTimeout(() => { closeBattle(); respawn(); }, 800);
      return;
    }

    // 准备下一轮
    game.battleAnimating = false;
    drawBattle();
  }, 700);
}

// 拳击：固定5伤害，不消耗物品
function executePunch() {
  if (game.battleAnimating) return;
  const en = game.battleTarget;
  if (!en) return;

  game.battleAnimating = true;
  const totalDmg = 5;
  sfx('attack');

  const ex = en.x + en.w / 2;
  const ey = en.y + en.h / 2;
  spawnParticles(ex, ey, '#aaaaaa', 8);
  showToast(`👊 拳击！造成 ${totalDmg} 伤害`, 1000);

  game.battleCards = [];
  drawBattle();

  if (totalDmg >= en.health) {
    en.health = 0;
    drawBattle();
    setTimeout(() => {
      spawnParticles(ex, ey, '#44ff00', 25);
      // 击杀掉落（公共函数，按怪物类型）
      const loot = dropEnemyLoot(en);
      showToast(`🎉 击败${ENEMY_NAMES[en.type] || '敌人'}！+${loot.count} ${loot.name}`, 1500);
      const idx = game.enemies.indexOf(en);
      if (idx >= 0) game.enemies.splice(idx, 1);
      closeBattle();
    }, 800);
    return;
  }

  en.health -= totalDmg;
  drawBattle();

  setTimeout(() => {
    if (!game.battleOpen || !game.battleTarget) { return; }
    // 反击伤害按怪物强度：史莱姆 6-11 / 蜘蛛 9-14 / 石魔像 14-20
    const base = (en.damage || 8) * 0.8;
    const counterDmg = Math.floor(base + Math.random() * 6);
    game.player.health -= counterDmg;
    if (game.player.health < 0) game.player.health = 0;
    game.player.invuln = 800;
    game.player.lastDamageTime = performance.now();
    sfx('hurt');
    spawnParticles(
      game.player.x + game.player.w / 2,
      game.player.y + game.player.h / 2,
      '#ff3333', 10
    );
    showToast(`💥 ${ENEMY_NAMES[en.type] || '敌人'}反击！-${counterDmg} HP`, 1000);
    drawBattle();

    if (game.player.health <= 0) {
      setTimeout(() => { closeBattle(); respawn(); }, 800);
      return;
    }

    game.battleAnimating = false;
    drawBattle();
  }, 700);
}

// ==================== 工具函数 ====================
function lerp(a, b, t) { return a + (b - a) * t; }

let toastEl = null;
let toastTimer = null;
function showToast(msg, duration = 2000) {
  if (!toastEl) {
    toastEl = document.getElementById('game-toast');
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
}

// ==================== 音效 ====================
// 统一接入 audio.js 的 Sound 引擎（总线 / 程序化合成 / 空间化 / 动态音乐）
function sfx(type, opts) {
  if (window.Sound) Sound.play(type, opts || {});
}

// 根据世界 X 坐标相对玩家计算声像 [-1,1]（屏幕空间立体声定位）
function audioPan(worldX) {
  const p = game.player;
  if (!p) return 0;
  const range = (game.cw || 800) * 0.6;
  return Math.max(-1, Math.min(1, (worldX - (p.x + p.w / 2)) / range));
}

// ==================== 联机系统 ====================

function isWeChatMiniProgram() {
  return /miniProgram/i.test(navigator.userAgent) || 
         window.__wxjs_environment === 'miniprogram';
}

// 连接 WebSocket 服务器
function connectMultiplayer() {
  if (game.multiplayer.ws && game.multiplayer.ws.readyState <= 1) {
    game.multiplayer.ws.close();
  }
  game.multiplayer.kicked = false;

  // 与当前页面同 host+port：服务端静态托管 / API / WebSocket 全在同一端口
  // （修复：原硬编码 :8080 在 PORT 自定义时连不上，同步功能直接失效）
  const wsUrl = location.protocol === 'https:'
    ? `wss://${location.host}`
    : `ws://${location.host}`;

  showToast('正在连接服务器...', 3000);
  console.log('[联机] 尝试连接:', wsUrl, '环境:', isWeChatMiniProgram() ? '微信小程序' : '浏览器');

  try {
    const ws = new WebSocket(wsUrl);
    game.multiplayer.ws = ws;
    game.multiplayer.connected = false;

    let connected = false;

    ws.onopen = () => {
      connected = true;
      game.multiplayer.connected = true;
      game.multiplayer.reconnectDelay = 0;
      console.log('[联机] WebSocket已连接, 发送join:', game.nickname);
      ws.send(JSON.stringify({ type: 'join', nickname: game.nickname || '玩家' }));
      showToast('已连接', 1500);
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMultiplayerMessage(msg);
    };

    ws.onclose = () => {
      if (game.multiplayer.ws !== ws) return;
      console.log('[联机] 连接关闭, connected=', connected);
      const wasConnected = game.multiplayer.connected;
      game.multiplayer.connected = false;
      game.multiplayer.myId = null;
      game.multiplayer.players.clear();
      if (game.multiplayer.kicked) {
        game.multiplayer.kicked = false;
        return;
      }
      // 微信小程序 WebSocket 可能直接失败，回退到 HTTP 轮询
      if (!connected && isWeChatMiniProgram()) {
        console.log('[联机] 微信环境 WebSocket 失败，尝试 HTTP 轮询');
        showToast('WebSocket 不可用，切换 HTTP 模式...', 3000);
        startHttpPolling();
        return;
      }
      if (wasConnected) showToast('已断开连接，正在重连...', 2500);
      game.multiplayer.reconnectDelay = (game.multiplayer.reconnectDelay || 0) + 3000;
      setTimeout(() => {
        if (!game.multiplayer.connected) connectMultiplayer();
      }, Math.min(game.multiplayer.reconnectDelay, 15000));
    };

    ws.onerror = (e) => {
      console.log('[联机] WebSocket 错误:', e);
    };

    // 5秒内没连上，微信环境自动切换
    setTimeout(() => {
      if (!connected && !game.multiplayer.connected && isWeChatMiniProgram()) {
        console.log('[联机] 5秒内未连接，微信环境切换 HTTP 模式');
        try { ws.close(); } catch(e) {}
      }
    }, 5000);

  } catch (e) {
    console.warn('WebSocket 创建失败:', e);
    game.multiplayer.connected = false;
    if (isWeChatMiniProgram()) {
      showToast('WebSocket 不可用，使用 HTTP 模式...', 3000);
      startHttpPolling();
    }
  }
}

// HTTP 轮询模式（微信小程序备选）
function startHttpPolling() {
  // 与当前页面同源：服务端静态托管与 API 同端口（原硬编码 :8080 在 PORT 自定义时失效）
  const baseUrl = location.origin;
  
  let myId = null;
  let pollTimer = null;
  let pollFailCount = 0; // 轮询连续失败计数（服务端重启自愈用）
  let sendTimer = null;
  game.multiplayer.httpMode = true;

  async function httpPost(path, data) {
    try {
      const res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      return await res.json();
    } catch (e) {
      console.warn('[HTTP] 请求失败:', path, e);
      return null;
    }
  }

  async function join() {
    const res = await httpPost('/api/join', { nickname: game.nickname || '玩家' });
    if (res) {
      myId = res.id;
      game.multiplayer.myId = myId;
      game.multiplayer.connected = true;
      // 用服务端种子重建世界（与 WebSocket 模式一致）
      if (typeof res.seed === 'number' && res.seed !== game.worldSeed) {
        console.log('[HTTP] 用服务端种子重建世界:', res.seed);
        setupWorld(res.seed).catch(err => console.error('[HTTP] 重建世界失败', err));
      }
      console.log('[HTTP] 已加入, id=', myId, '在线:', (res.players || []).length);
      for (const p of (res.players || [])) {
        game.multiplayer.players.set(p.id, {
          nickname: p.nickname, x: p.x, y: p.y, rx: p.x, ry: p.y,
          vx: p.vx, vy: p.vy, facing: p.facing,
          walkPhase: p.walkPhase, health: p.health, hasPosition: true,
        });
      }
      // 应用服务端权威世界差量
      if (res.worldstate) applyWorldState(res.worldstate);
      showToast('已连接 (HTTP模式)', 2000);
    } else {
      // 服务端未就绪：2 秒后重试，保证 HTTP 模式也能自愈
      console.warn('[HTTP] join 失败，2 秒后重试');
      setTimeout(join, 2000);
    }
  }

  async function poll() {
    if (!game.multiplayer.connected || !myId) return;
    const data = await httpPost('/api/poll', { id: myId });
    if (!data) {
      // 服务端重启 / 会话失效（404）→ 连续失败 10 次（约 5 秒）后重新 join 自愈
      pollFailCount++;
      if (pollFailCount >= 10) {
        console.warn('[HTTP] 轮询连续失败，重新加入服务器');
        pollFailCount = 0;
        myId = null;
        game.multiplayer.myId = null;
        game.multiplayer.connected = false;
        game.multiplayer.players.clear();
        join();
      }
      return;
    }
    pollFailCount = 0;
    for (const msg of (data.messages || [])) {
      handleMultiplayerMessage(msg);
    }
    // 更新其他玩家列表（跳过自己）
    if (data.players) {
      for (const [id, p] of game.multiplayer.players) {
        if (id === myId) continue;
        if (!data.players.find(pl => pl.id === id)) {
          game.multiplayer.players.delete(id);
        }
      }
      for (const p of data.players) {
        if (p.id === myId) continue;
        if (!game.multiplayer.players.has(p.id)) {
          game.multiplayer.players.set(p.id, {
            nickname: p.nickname, x: p.x, y: p.y, rx: p.x, ry: p.y,
            vx: p.vx, vy: p.vy, facing: p.facing,
            walkPhase: p.walkPhase, health: p.health, hasPosition: true,
          });
        }
      }
    }
  }

  async function sendPosition() {
    if (!game.multiplayer.connected || !myId) return;
    const p = game.player;
    await httpPost('/api/move', {
      id: myId,
      x: p.x, y: p.y, vx: p.vx, vy: p.vy,
      facing: p.facing, walkPhase: p.walkPhase, health: p.health,
    });
  }

  join();
  pollTimer = setInterval(poll, 500);
  sendTimer = setInterval(sendPosition, 100);

  game.multiplayer.httpSend = sendPosition;
  game.multiplayer.httpPoll = poll;
}

// 应用服务端权威世界差量（玩家挖/放的改动）。key = ty*WORLD_W + tx
// 注：setTile 每次调用已正确维护流体(水12/岩浆63)活跃集，此处不重复 rebuildFluidActive，
//     避免 60s 定时同步时 O(180000) 全量扫描拖帧。
function applyWorldState(ws) {
  if (!ws || !Array.isArray(ws.tiles)) return;
  if (!game.world) { game.pendingWorldState = ws; return; } // 世界未就绪则缓存，setupWorld 完成后补齐
  for (const [k, v] of ws.tiles) {
    const tx = k % WORLD_W;
    const ty = Math.floor(k / WORLD_W);
    setTile(tx, ty, v);
  }
  // rebuildFluidActive 已移除：setTile 每格已维护活跃集，且周期性全量同步时再扫一遍 180000 格是纯浪费
  console.log('[联机] 已应用服务端差量:', ws.tiles.length, '处方块改动');
}

// 处理服务器消息
function handleMultiplayerMessage(msg) {
  const mp = game.multiplayer;
  switch (msg.type) {
    case 'welcome':
      mp.myId = msg.id;
      // 用服务端下发的种子重建世界，确保与同房间的其他玩家世界完全一致
      if (typeof msg.seed === 'number' && msg.seed !== game.worldSeed) {
        console.log('[联机] 用服务端种子重建世界:', msg.seed);
        setupWorld(msg.seed).then(() => showToast('联机世界种子: ' + msg.seed, 2500))
          .catch(err => console.error('[联机] 重建世界失败', err));
      }
      console.log('[联机] 收到welcome, myId=', msg.id, '在线玩家数=', (msg.players || []).length);
      for (const p of (msg.players || [])) {
        mp.players.set(p.id, {
          nickname: p.nickname,
          x: p.x, y: p.y, rx: p.x, ry: p.y,
          vx: p.vx, vy: p.vy, facing: p.facing,
          walkPhase: p.walkPhase, health: p.health,
          hasPosition: true,
        });
        console.log('[联机] 已加入玩家:', p.nickname, 'id=', p.id);
      }
      // 应用服务端权威世界差量（玩家挖/放的改动覆盖在种子地形之上）
      if (msg.worldstate) applyWorldState(msg.worldstate);
      break;

    case 'join':
      console.log('[联机] 新玩家加入:', msg.nickname, 'id=', msg.id);
      mp.players.set(msg.id, {
        nickname: msg.nickname,
        x: 0, y: 0, rx: 0, ry: 0,
        vx: 0, vy: 0, facing: 1, walkPhase: 0, health: 100,
        hasPosition: false,
      });
      showToast(`${msg.nickname} 加入了游戏`, 1500);
      break;

    case 'leave': {
      const rp = mp.players.get(msg.id);
      if (rp) {
        showToast(`${rp.nickname} 离开了游戏`, 1500);
        mp.players.delete(msg.id);
      }
      break;
    }

    case 'move': {
      let rp = mp.players.get(msg.id);
      if (!rp) {
        rp = { nickname: '玩家', x: msg.x, y: msg.y, hasPosition: false };
        mp.players.set(msg.id, rp);
      }
      rp.rx = msg.x;
      rp.ry = msg.y;
      rp.vx = msg.vx;
      rp.vy = msg.vy;
      rp.facing = msg.facing;
      rp.walkPhase = msg.walkPhase;
      rp.health = msg.health;
      if (!rp.hasPosition) {
        rp.x = msg.x;
        rp.y = msg.y;
        rp.hasPosition = true;
      }
      break;
    }

    case 'block':
      // 应用其他玩家的方块变更
      setTile(msg.tx, msg.ty, msg.tileId);
      if (msg.tileId === 0) {
        spawnParticles(msg.tx * TILE + TILE / 2, msg.ty * TILE + TILE / 2, '#aaa', 6);
      } else {
        spawnParticles(msg.tx * TILE + TILE / 2, msg.ty * TILE + TILE / 2, '#fff', 4);
      }
      break;

    case 'worldstate':
      // 服务端定时同步全量地图差量（防丢包导致的世界不一致）
      applyWorldState(msg);
      break;

    case 'sync': {
      // 服务端权威时钟（200ms 广播）+ 增量地图改动（动态地图）
      // 1) 时间校正：平滑 lerp 对齐服务端昼夜，避免跳变；处理跨日 wrap
      if (typeof msg.t === 'number') {
        if (msg.force) {
          game.time = msg.t; // 床跳夜：服务端强制对齐到早晨，不走平滑收敛避免反向抖动
        } else {
          let diff = msg.t - game.time;
          if (diff > 0.5) diff -= 1;   // 跨日：0.95 -> 0.05 应走 -0.9 方向
          if (diff < -0.5) diff += 1;
          game.time += diff * 0.5;      // 半程收敛，两个广播周期内对齐
          if (game.time < 0) game.time += 1;
          if (game.time >= 1) game.time -= 1;
        }
        if (typeof msg.day === 'number' && msg.day > game.day) game.day = msg.day;
      }
      // 2) 增量地图：本 200ms 窗口内其他玩家的方块改动
      if (Array.isArray(msg.tiles) && msg.tiles.length) {
        for (const [k, v] of msg.tiles) {
          const tx = k % WORLD_W;
          const ty = Math.floor(k / WORLD_W);
          setTile(tx, ty, v);
        }
      }
      break;
    }

    case 'flash':
      // 其他玩家投掷的闪光弹：按距离判定本地是否被闪
      if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        const p = game.player;
        const pd = Math.hypot((p.x + p.w / 2) - msg.x, (p.y + p.h / 2) - msg.y);
        if (pd < 5 * TILE) {
          game.flashAlpha = 0.95;
          spawnParticles(msg.x, msg.y, '#ffffff', 30);
        }
      }
      break;

    case 'kick':
      game.multiplayer.kicked = true;
      showToast(msg.reason || '你已被踢出', 4000);
      break;
  }
}

// 发送方块变更给服务器
function syncBlockChange(tx, ty, tileId) {
  const mp = game.multiplayer;
  if (!mp.connected) return;
  if (mp.ws && mp.ws.readyState === 1) {
    mp.ws.send(JSON.stringify({ type: 'block', tx, ty, tileId }));
  } else if (mp.httpMode && mp.myId !== null) {
    fetch(`${location.origin}/api/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: mp.myId, tx, ty, tileId }),
    }).catch(() => {});
  }
}

// 更新远程玩家（插值平滑移动）
function updateRemotePlayers(dt) {
  const mp = game.multiplayer;
  const lerpFactor = 0.25;
  const dts = dt / 16.67;
  for (const [id, rp] of mp.players) {
    if (id === mp.myId || !rp.hasPosition) continue;
    // 位置插值
    rp.x += (rp.rx - rp.x) * lerpFactor;
    rp.y += (rp.ry - rp.y) * lerpFactor;
    // 走路动画推进
    if (Math.abs(rp.vx) > 0.5) {
      rp.walkPhase += dts * 0.3;
    }
  }
}

// 绘制其他联机玩家
function drawOtherPlayers(ctx) {
  const mp = game.multiplayer;
  for (const [id, rp] of mp.players) {
    if (id === mp.myId || !rp.hasPosition) continue;

    const sx = rp.x - game.camX;
    const sy = rp.y - game.camY;
    const w = 18, h = 36;

    // 屏幕外跳过
    if (sx < -60 || sx > game.cw + 60 || sy < -60 || sy > game.ch + 60) continue;

    ctx.save();

    // 走路动画
    const walkOffset = Math.abs(rp.vx) > 0.5 ? Math.sin(rp.walkPhase * 10) * 2 : 0;

    // 身体（粉红色区分其他玩家）
    ctx.fillStyle = '#b83a6a';
    ctx.fillRect(sx + 2, sy + 10 + walkOffset, w - 4, h - 14);

    // 头
    ctx.fillStyle = '#e8b888';
    ctx.fillRect(sx + 3, sy, w - 6, 12);

    // 头发
    ctx.fillStyle = '#3a2a1a';
    ctx.fillRect(sx + 3, sy, w - 6, 4);

    // 眼睛
    ctx.fillStyle = '#222';
    if (rp.facing > 0) {
      ctx.fillRect(sx + 9, sy + 6, 2, 2);
    } else {
      ctx.fillRect(sx + 7, sy + 6, 2, 2);
    }

    // 腿
    ctx.fillStyle = '#8a2a4a';
    ctx.fillRect(sx + 2, sy + h - 6 + walkOffset, 6, 6);
    ctx.fillRect(sx + w - 8, sy + h - 6 - walkOffset, 6, 6);

    ctx.restore();

    // 头顶用户名
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(rp.nickname).width;
    const nx = sx + w / 2;
    const ny = sy - 14;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(nx - tw / 2 - 4, ny - 8, tw + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(rp.nickname, nx, ny);

    // 血条（受伤时显示）
    if (rp.health < 100) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(sx, sy - 30, w, 3);
      ctx.fillStyle = '#ff3333';
      ctx.fillRect(sx, sy - 30, w * (rp.health / 100), 3);
    }
  }
}

// ==================== 启动 ====================
window.addEventListener('load', () => {
  const params = new URLSearchParams(location.search);
  const urlNick = params.get('nickname');
  const ov = document.getElementById('nickname-overlay');
  const input = document.getElementById('nickname-input');
  const btn = document.getElementById('nickname-confirm');
  const lobbyEl = document.getElementById('lobby-players');
  const lobbyCountEl = document.getElementById('lobby-count');

  // 登录界面轮询在线玩家：2~3s 足够新鲜度，又不给服务端造成压力
  const LOBBY_POLL_MS = 3000;
  let lobbyTimer = null;

  async function refreshLobby() {
    if (!lobbyEl) return;
    try {
      const res = await fetch('/api/players');
      if (!res.ok) throw new Error('bad status ' + res.status);
      const data = await res.json();
      const list = Array.isArray(data.players) ? data.players : [];
      if (lobbyCountEl) lobbyCountEl.textContent = String(list.length);
      if (!list.length) {
        lobbyEl.innerHTML = '<div class="lobby-empty">暂无其他玩家在线</div>';
        return;
      }
      lobbyEl.innerHTML = list.map(p =>
        `<div class="lobby-item"><span class="dot"></span>${escapeHtml(p.nickname || '玩家')}</div>`
      ).join('');
    } catch (e) {
      if (lobbyCountEl) lobbyCountEl.textContent = '0';
      lobbyEl.innerHTML = '<div class="lobby-empty">服务器未连接</div>';
    }
  }

  function startGame(nick) {
    const name = (nick || '').trim();
    if (!name) { if (input) input.focus(); return; }
    if (lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
    game.nickname = name.slice(0, 16);
    if (btn) btn.blur();
    if (ov) ov.classList.add('hidden');
    init();
  }

  if (urlNick && urlNick.trim()) {
    startGame(urlNick);
  } else {
    if (input) input.focus();
    if (btn) btn.addEventListener('click', () => startGame(input ? input.value : ''));
    if (input) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startGame(input.value);
    });
    refreshLobby();
    lobbyTimer = setInterval(refreshLobby, LOBBY_POLL_MS);
  }
});

})();
