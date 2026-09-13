/**
 * 像素沙盒 - 方块与合成数据
 */

// ===== 常量 =====
const TILE = 24;           // 方块像素大小
const WORLD_W = 600;       // 世界宽度（方块数）
const WORLD_H = 300;       // 世界高度（方块数）
const GRAVITY = 0.45;
const MAX_FALL = 14;
const PLAYER_SPEED = 3.2;
const JUMP_FORCE = 8.0;       // 起跳速度(px/帧,60fps基准)。满跳高=JUMP_FORCE²/(2·GRAVITY)=64/0.9≈71px≈2.96格 [PLACEHOLDER]
// ---- 跳跃手感系统（可调参数面；数值平衡验证路径见 DESIGN_CORELOOP.md）----
const JUMP_CUT = 0.45;           // 上升中松键→上升速度×该值：轻点小跳、长按满跳（可变跳高）
const FALL_GRAVITY_MULT = 1.4;   // 下落重力倍率(>1)：下落比上升快 → 手感"紧"不飘（fast-fall）
const APEX_GRAVITY_MULT = 0.55;  // 顶点(|vy|<APEX_VY)重力倍率(<1)：顶点轻微悬停，增加滞空感
const APEX_VY = 1.6;             // 顶点判定阈值(px/帧)：|vy|低于此视为接近顶点
const COYOTE = 6;                // 土狼时间(帧)：离地后仍可起跳的宽限，悬崖边不漏跳
const JUMP_BUFFER = 7;           // 跳跃缓冲(帧)：落地前提前按下不丢失
const REACH = 5;           // 玩家挖掘/放置范围（方块数）

// ===== 水下氧气系统 =====
const OXYGEN_MAX = 100;              // 满氧气值
const OXYGEN_DRAIN_PER_SEC = 10;     // 浸入水中每秒消耗 [PLACEHOLDER]：满气约 10s 耗尽，按手感再调
const OXYGEN_REGEN_PER_SEC = 25;     // 出水每秒回复 [PLACEHOLDER]：约 4s 回满
const DROWN_DAMAGE_PULSE = 10;      // 氧气耗尽后每次脉冲扣血（用户指定 10）[PLACEHOLDER]
const DROWN_INVULN = 500;           // 每次溺水脉冲后的无敌帧毫秒（用户指定 500）[PLACEHOLDER]：10血/500ms ≈ 20血/秒

// ===== 岩浆伤害 =====
const LAVA_DAMAGE = 20;             // 接触岩浆每次脉冲扣血（原 6，用户指定 20）[PLACEHOLDER]：比溺水更狠，体现岩浆致命性
const LAVA_INVULN = 300;            // 每次岩浆脉冲后的无敌帧毫秒（原 600，用户要求“减少”，取半数）[PLACEHOLDER]：20血/300ms ≈ 66血/秒，极致命

// ===== 植物生长系统 =====
const SAPLING_GROW_DAYS = 0.5;      // 树苗长成树所需游戏天数 [PLACEHOLDER]：原1.5天(×dayLength360秒=9分钟)太久，玩家等不到误以为不发芽；改0.5天(约3分钟)可感知。如坚持原意改回1.5即可。种植时间戳用连续天数(day+time)计时
const SAPLING_DROP_CHANCE = 0.12;   // 挖树叶掉落树苗概率 [PLACEHOLDER]
const TREE_MIN_H = 4;               // 树高下限（原木段数）[PLACEHOLDER]
const TREE_MAX_H = 6;               // 树高上限 [PLACEHOLDER]
const GRASS_SPREAD_INTERVAL = 2500; // 草蔓延每多少毫秒推进一次 [PLACEHOLDER]
const GRASS_SPREAD_PER_TICK = 24;   // 每次蔓延最多草化多少格泥土 [PLACEHOLDER]

// ===== 爆炸伤害（硫磺弹） =====
const BOMB_PLAYER_DAMAGE = 40;      // 硫磺弹对玩家的中心伤害（原 16，约 2.5× 提升）[PLACEHOLDER]：满血约掉 40%，不直接秒杀；随距离线性衰减到 0

// ===== 方块定义 =====
// id: 方块ID, name: 名称, color: 主色, shade: 纹理色, solid: 是否有碰撞, hardness: 挖掘难度(帧)
const BLOCKS = {
  0:  { id:0,  name:'空气',     color:null,      solid:false, hardness:0,  light:0, item:false },
  1:  { id:1,  name:'草地',     color:'#4a9b3e', shade:'#3a7a30', solid:true,  hardness:8,  light:0, item:true,  drop:2 },
  2:  { id:2,  name:'泥土',     color:'#7a5230', shade:'#5a3a20', solid:true,  hardness:8,  light:0, item:true },
  3:  { id:3,  name:'石头',     color:'#6b6b70', shade:'#5a5a5f', solid:true,  hardness:18, light:0, item:true, tool:1 },
  4:  { id:4,  name:'原木',     color:'#6d4423', shade:'#5a3518', solid:true,  hardness:10, light:0, item:true },
  5:  { id:5,  name:'树叶',     color:'#2d6b1e', shade:'#1e4a15', solid:false, hardness:3,  light:0, item:true },
  6:  { id:6,  name:'沙子',     color:'#d4b876', shade:'#c0a060', solid:true,  hardness:6,  light:0, item:true },
  7:  { id:7,  name:'煤矿石',   color:'#4a4a4a', shade:'#2a2a2a', solid:true,  hardness:20, light:0, item:true, tool:1 },
  8:  { id:8,  name:'铜矿石',   color:'#7a5a3a', shade:'#c87830', solid:true,  hardness:22, light:0, item:true, tool:1 },
  9:  { id:9,  name:'铁矿石',   color:'#6a6a70', shade:'#a08060', solid:true,  hardness:28, light:0, item:true, tool:2 },
  10: { id:10, name:'金矿石',   color:'#6a6a60', shade:'#d4af37', solid:true,  hardness:30, light:0, item:true, tool:2 },
  11: { id:11, name:'钻石矿',   color:'#3a5a5a', shade:'#30d0d0', solid:true,  hardness:40, light:0, item:true, tool:3 },
  12: { id:12, name:'水',       color:'#2860a8', shade:'#1a4080', solid:false, hardness:0,  light:0, item:false },
  13: { id:13, name:'木板',     color:'#9a6b3a', shade:'#7a5230', solid:true,  hardness:10, light:0, item:true },
  14: { id:14, name:'石砖',     color:'#7a7a80', shade:'#606068', solid:true,  hardness:18, light:0, item:true, tool:1 },
  15: { id:15, name:'火把',     color:'#ffcc40', shade:'#ff8800', solid:false, hardness:1,  light:12, item:true },
  16: { id:16, name:'玻璃',     color:'#b0d8e8', shade:'#90c0d0', solid:true,  hardness:5,  light:0, item:true },
  17: { id:17, name:'工作台',   color:'#8a5a2a', shade:'#5a3a18', solid:true,  hardness:10, light:0, item:true },
  18: { id:18, name:'熔炉',    color:'#5a4030', shade:'#3a2010', solid:true,  hardness:12, light:2, item:true },
  19: { id:19, name:'铜锭块',   color:'#c87830', shade:'#a06020', solid:true,  hardness:15, light:0, item:true },
  20: { id:20, name:'铁锭块',   color:'#c0c0c8', shade:'#909098', solid:true,  hardness:15, light:0, item:true },
  21: { id:21, name:'金锭块',   color:'#d4af37', shade:'#b09020', solid:true,  hardness:15, light:0, item:true },
  22: { id:22, name:'砖块',     color:'#a04020', shade:'#702810', solid:true,  hardness:15, light:0, item:true },
  23: { id:23, name:'雪块',     color:'#e8e8f0', shade:'#c8c8d8', solid:true,  hardness:5,  light:0, item:true },
  24: { id:24, name:'冰块',     color:'#80c0e0', shade:'#5090c0', solid:true,  hardness:6,  light:0, item:true },
  25: { id:25, name:'黑曜石',   color:'#1a1a2e', shade:'#0a0a1e', solid:true,  hardness:50, light:0, item:true, tool:3 },
  // ---- 工作台合成产物 ----
  26: { id:26, name:'木门',     color:'#9a6b3a', shade:'#6a4a20', solid:true,  hardness:10, light:0, item:true },
  27: { id:27, name:'箱子',     color:'#8a5a2a', shade:'#5a3a1a', solid:true,  hardness:10, light:0, item:true },
  28: { id:28, name:'木栅栏',   color:'#6d4423', shade:'#4a2e15', solid:true,  hardness:10, light:0, item:true },
  29: { id:29, name:'铁砖',     color:'#b0b0b8', shade:'#707078', solid:true,  hardness:20, light:0, item:true },
  30: { id:30, name:'金砖',     color:'#e4bf37', shade:'#b09020', solid:true,  hardness:20, light:0, item:true },
  31: { id:31, name:'钻石砖',   color:'#50e0d0', shade:'#20a0a0', solid:true,  hardness:30, light:2, item:true },
  32: { id:32, name:'灯笼',     color:'#ffaa00', shade:'#ff6600', solid:false, hardness:5,  light:16, item:true },
  33: { id:33, name:'书架',     color:'#8a5a2a', shade:'#5a3a1a', solid:true,  hardness:10, light:0, item:true },
  // ---- 熔炉烧制产物 ----
  34: { id:34, name:'钢锭块',   color:'#606870', shade:'#383e44', solid:true,  hardness:25, light:0, item:true },
  35: { id:35, name:'熔晶砖',   color:'#4060a0', shade:'#204080', solid:true,  hardness:30, light:3, item:true },
  // ---- 新矿石（真实化学元素）----
  36: { id:36, name:'锡矿石',   color:'#6a6a6a', shade:'#a0a0a8', solid:true,  hardness:22, light:0, item:true, tool:1 },
  37: { id:37, name:'银矿石',   color:'#5a5a5e', shade:'#c0c0d0', solid:true,  hardness:28, light:0, item:true, tool:2 },
  38: { id:38, name:'钨矿石',   color:'#3a3a3e', shade:'#6a8a6a', solid:true,  hardness:35, light:0, item:true, tool:3 },
  39: { id:39, name:'铅矿石',   color:'#3a3a40', shade:'#5a6a7a', solid:true,  hardness:24, light:0, item:true, tool:2 },
  40: { id:40, name:'硫矿石',   color:'#5a5028', shade:'#d4d020', solid:true,  hardness:18, light:0, item:true, tool:1 },
  41: { id:41, name:'石英矿',   color:'#4a4a50', shade:'#e0e0f0', solid:true,  hardness:20, light:0, item:true, tool:1 },
  // ---- 新冶炼产物 ----
  42: { id:42, name:'锡锭块',   color:'#a0a0a8', shade:'#707078', solid:true,  hardness:15, light:0, item:true },
  43: { id:43, name:'银锭块',   color:'#c8c8d8', shade:'#9898a8', solid:true,  hardness:15, light:0, item:true },
  44: { id:44, name:'钨锭块',   color:'#4a5a4a', shade:'#2a3a2a', solid:true,  hardness:30, light:0, item:true },
  45: { id:45, name:'铅锭块',   color:'#5a6a7a', shade:'#3a4a5a', solid:true,  hardness:15, light:0, item:true },
  46: { id:46, name:'硅晶块',   color:'#8090a0', shade:'#506070', solid:true,  hardness:18, light:0, item:true },
  // ---- 新工作台合成产物 ----
  47: { id:47, name:'青铜块',   color:'#c87830', shade:'#a06020', solid:true,  hardness:18, light:0, item:true },
  48: { id:48, name:'焊料块',   color:'#8090a0', shade:'#506070', solid:true,  hardness:12, light:0, item:true },
  49: { id:49, name:'琥珀金',   color:'#e4c837', shade:'#b0a020', solid:true,  hardness:15, light:1, item:true },
  50: { id:50, name:'透镜',     color:'#d0e8f8', shade:'#a0c0e0', solid:false, hardness:5,  light:0, item:true },
  51: { id:51, name:'导电板',   color:'#c0c0c8', shade:'#808088', solid:true,  hardness:18, light:0, item:true },
  52: { id:52, name:'硫磺弹',   color:'#d4d020', shade:'#a0a010', solid:false, hardness:3,  light:0, item:true },
  53: { id:53, name:'毒药瓶',   color:'#6a3a6a', shade:'#4a2050', solid:false, hardness:3,  light:0, item:true },
  54: { id:54, name:'半导体',   color:'#4050a0', shade:'#2030a0', solid:false, hardness:8,  light:0, item:true },
  55: { id:55, name:'电池组',   color:'#ffd633', shade:'#cca820', solid:true,  hardness:12, light:1, item:true },
  // ---- 工具（不可放置，装备后用于挖掘）----
  56: { id:56, name:'木镐',     color:'#9a6b3a', shade:'#6d4423', solid:false, hardness:0,  light:0, item:true, tool:'pickaxe', toolTier:1 },
  57: { id:57, name:'石镐',     color:'#7a7a80', shade:'#5a5a5f', solid:false, hardness:0,  light:0, item:true, tool:'pickaxe', toolTier:2 },
  58: { id:58, name:'铁镐',     color:'#c0c0c8', shade:'#909098', solid:false, hardness:0,  light:0, item:true, tool:'pickaxe', toolTier:3 },
  // ---- 武器（有耐久，近战攻击敌人造成高伤害）----
  79: { id:79, name:'木剑',     color:'#9a6b3a', shade:'#6d4423', solid:false, hardness:0,  light:0, item:true, tool:'sword', toolTier:1, damage:6,  durability:40  },
  80: { id:80, name:'石剑',     color:'#7a7a80', shade:'#5a5a5f', solid:false, hardness:0,  light:0, item:true, tool:'sword', toolTier:2, damage:9,  durability:80  },
  81: { id:81, name:'铁剑',     color:'#c0c0c8', shade:'#909098', solid:false, hardness:0,  light:0, item:true, tool:'sword', toolTier:3, damage:14, durability:120 },
  // ---- 家具 ----
  59: { id:59, name:'床',       color:'#caa46b', shade:'#a08050', solid:true, hardness:2, light:0, item:true },
  // ---- 桶与液体 ----
  60: { id:60, name:'桶',       color:'#8a8a90', shade:'#5a5a60', solid:false, hardness:0, light:0, item:true, isBucket:true, placeable:false },
  61: { id:61, name:'水桶',     color:'#3a7ad0', shade:'#1a4080', solid:false, hardness:0, light:0, item:true, isBucket:true, placeable:false },
  62: { id:62, name:'岩浆桶',   color:'#e8702a', shade:'#a03010', solid:false, hardness:0, light:0, item:true, isBucket:true, placeable:false },
  63: { id:63, name:'岩浆',     color:'#e0581a', shade:'#a02808', solid:false, hardness:0, light:1, item:false }, // light 1(原2)：缩小暖色光晕半径，缓解熔岩海叠加过亮
  // ---- 植物（可种植生长）----
  64: { id:64, name:'树苗',     color:'#6a4a28', shade:'#4a3018', solid:false, hardness:1,  light:0, item:true, drop:64 },
  // ---- 新元素方块（周期表扩展：H 氢 / Al 铝 / Zn 锌 / Ni 镍 / Ti 钛 / Mg 镁）----
  65: { id:65, name:'氢气块',   color:'#cfe8f5', shade:'#9cc8dc', solid:true,  hardness:6,  light:0, item:true, element:'H' },
  66: { id:66, name:'铝矿石',   color:'#9aa4b0', shade:'#c0c8d0', solid:true,  hardness:22, light:0, item:true, tool:1, element:'Al' },
  67: { id:67, name:'锌矿石',   color:'#8a94a0', shade:'#b0b8c4', solid:true,  hardness:24, light:0, item:true, tool:1, element:'Zn' },
  68: { id:68, name:'镍矿石',   color:'#a8b8a8', shade:'#c8d4c0', solid:true,  hardness:26, light:0, item:true, tool:2, element:'Ni' },
  69: { id:69, name:'钛矿石',   color:'#8a90a0', shade:'#b8c0d0', solid:true,  hardness:32, light:0, item:true, tool:3, element:'Ti' },
  70: { id:70, name:'镁矿石',   color:'#c0c8d0', shade:'#e0e4e8', solid:true,  hardness:20, light:0, item:true, tool:1, element:'Mg' },
  71: { id:71, name:'铝锭块',   color:'#c8ccd4', shade:'#a8b0b8', solid:true,  hardness:15, light:0, item:true },
  72: { id:72, name:'锌锭块',   color:'#b8c0c8', shade:'#98a0a8', solid:true,  hardness:15, light:0, item:true },
  73: { id:73, name:'镍锭块',   color:'#c8d4c8', shade:'#a8b4a8', solid:true,  hardness:18, light:0, item:true },
  74: { id:74, name:'钛锭块',   color:'#c0c8d4', shade:'#a0a8b8', solid:true,  hardness:25, light:0, item:true },
  75: { id:75, name:'镁锭块',   color:'#e0e4e8', shade:'#c0c8cc', solid:true,  hardness:15, light:0, item:true },
  76: { id:76, name:'黄铜块',   color:'#c8a94a', shade:'#a88830', solid:true,  hardness:18, light:0, item:true },
  77: { id:77, name:'不锈钢块', color:'#a8b8c8', shade:'#8898a8', solid:true,  hardness:22, light:0, item:true },
  // ---- 镁制品：闪光弹（镁燃烧 2Mg+O₂→2MgO 产生耀眼白光）----
  78: { id:78, name:'闪光弹',   color:'#f0f0f8', shade:'#d8d8e8', solid:false, hardness:3,  light:0, item:true },
};

// 方块简写映射（用于合成）
const BLOCK_NAMES = {
  wood:4, dirt:2, stone:3, plank:13, torch:15, brick:14, glass:16,
  workbench:17, furnace:18, copper_ore:8, iron_ore:9, gold_ore:10, diamond:11,
  coal:7, copper_block:19, iron_block:20, gold_block:21, brick_block:22,
  sand:6, stone_brick:14, leaves:5, snow:23, ice:24, obsidian:25,
  door:26, chest:27, fence:28, iron_brick:29, gold_brick:30, diamond_brick:31,
  lantern:32, bookshelf:33, steel_block:34, crystal_brick:35,
  tin_ore:36, silver_ore:37, tungsten_ore:38, lead_ore:39, sulfur_ore:40, quartz_ore:41,
  tin_block:42, silver_block:43, tungsten_block:44, lead_block:45, silicon_block:46,
  bronze_block:47, solder_block:48, electrum_block:49, lens:50, conductor:51,
  sulfur_bomb:52, poison_vial:53, semiconductor:54, battery:55,
  wooden_pickaxe:56, stone_pickaxe:57, iron_pickaxe:58, bed:59, bucket:60, water_bucket:61, lava_bucket:62, lava:63, sapling:64,
  hydrogen_block:65, aluminum_ore:66, zinc_ore:67, nickel_ore:68, titanium_ore:69, magnesium_ore:70,
  aluminum_block:71, zinc_block:72, nickel_block:73, titanium_block:74, magnesium_block:75,
  brass_block:76, stainless_steel:77, flash_bang:78,
  wooden_sword:79, stone_sword:80, iron_sword:81,
};

// ===== 合成配方 =====
// input: {方块ID: 数量}, output: {方块ID: 数量}, needs: 'none'|'workbench'|'furnace'
// chem: 化学方程式（可选）
const RECIPES = [
  // ---- 手工合成（无需工作站）----
  { input: {4:1},              output: {13:4},  needs:'none',       name:'木板',     chem:'木材 → 板材（物理加工）' },
  { input: {4:1, 7:1},         output: {15:4},  needs:'none',       name:'火把',     chem:'C + O₂ → CO₂（燃烧反应）' },
  { input: {3:4},              output: {14:4},  needs:'none',       name:'石砖',     chem:'SiO₂ → 切割成型（物理加工）' },
  { input: {13:4},             output: {17:1},  needs:'none',       name:'工作台',   chem:'木材组装（物理加工）' },
  { input: {3:8, 13:1},        output: {18:1},  needs:'none',       name:'熔炉',     chem:'SiO₂ + Al₂O₃ → 耐火陶瓷（烧结）' },
  // ---- 工作台合成（高级产物 + 工具）----
  { input: {13:3, 4:1},        output: {56:1},  needs:'workbench',  name:'木镐',     chem:'木材 + 碳 → 工具（机械加工）' },
  { input: {3:3, 13:2},        output: {57:1},  needs:'workbench',  name:'石镐',     chem:'SiO₂ + 木材 → 工具（机械加工）' },
  { input: {20:2, 13:2},       output: {58:1},  needs:'workbench',  name:'铁镐',     chem:'Fe + C → 钢制工具（锻造）' },
  // ---- 武器（剑：近战高伤害，有耐久）----
  { input: {13:4},             output: {79:1},  needs:'workbench',  name:'木剑',     chem:'木材 → 剑（木工打磨，伤害低）' },
  { input: {3:3, 13:2},        output: {80:1},  needs:'workbench',  name:'石剑',     chem:'SiO₂ + 木材 → 石刃剑（磨砺成型）' },
  { input: {20:2, 13:2},       output: {81:1},  needs:'workbench',  name:'铁剑',     chem:'Fe + C → 锻造剑刃（淬火强化）' },
  { input: {13:6},             output: {26:1},  needs:'workbench',  name:'木门',     chem:'木材 → 门（机械加工）' },
  { input: {13:8},             output: {27:1},  needs:'workbench',  name:'箱子',     chem:'木材 → 箱（机械加工）' },
  { input: {13:6},             output: {28:2},  needs:'workbench',  name:'木栅栏',   chem:'木材 → 栅栏（机械加工）' },
  { input: {20:4},             output: {29:2},  needs:'workbench',  name:'铁砖',     chem:'Fe → 铁砖（锻压）' },
  { input: {21:4},             output: {30:2},  needs:'workbench',  name:'金砖',     chem:'Au → 金砖（锻压）' },
  { input: {11:4},             output: {31:2},  needs:'workbench',  name:'钻石砖',   chem:'C(金刚石) → 切割（物理加工）' },
  { input: {15:1, 20:4},       output: {32:1},  needs:'workbench',  name:'灯笼',     chem:'Fe + C → 灯笼（组装）' },
  { input: {13:6, 4:3},        output: {33:1},  needs:'workbench',  name:'书架',     chem:'木材 → 书架（机械加工）' },
  // ---- 熔炉烧制（矿石冶炼）----
  { input: {6:2, 7:1},         output: {16:1},  needs:'furnace',    name:'玻璃',     chem:'SiO₂ + C(燃料) →(1700°C) 玻璃（熔融态）' },
  { input: {8:1, 7:1},         output: {19:1},  needs:'furnace',    name:'铜锭块',   chem:'Cu₂S + O₂ → 2Cu + SO₂（还原冶炼）' },
  { input: {9:1, 7:1},         output: {20:1},  needs:'furnace',    name:'铁锭块',   chem:'Fe₂O₃ + 3C → 2Fe + 3CO（还原冶炼）' },
  { input: {10:1, 7:1},        output: {21:1},  needs:'furnace',    name:'金锭块',   chem:'Au + 热分解 → 纯Au（火法提纯）' },
  { input: {6:2, 7:1},         output: {22:2},  needs:'furnace',    name:'砖块',     chem:'Al₂Si₂O₇ →(900°C) Al₂O₃·SiO₂（焙烧）' },
  { input: {20:1, 7:2},        output: {34:1},  needs:'furnace',    name:'钢锭块',   chem:'Fe + C →(1400°C) Fe-C（渗碳合金）' },
  { input: {11:1, 7:1},        output: {35:1},  needs:'furnace',    name:'熔晶砖',   chem:'C(金刚石) + SiO₂ →(高温) 熔晶（高温高压合成）' },
  // ---- 新熔炉配方（新矿石冶炼）----
  { input: {36:1, 7:1},        output: {42:1},  needs:'furnace',    name:'锡锭块',   chem:'SnO₂ + 2C → Sn + 2CO（还原冶炼）' },
  { input: {37:1, 7:1},        output: {43:1},  needs:'furnace',    name:'银锭块',   chem:'Ag₂S + O₂ → 2Ag + SO₂（还原冶炼）' },
  { input: {38:1, 7:2},        output: {44:1},  needs:'furnace',    name:'钨锭块',   chem:'WO₃ + 3H₂ → W + 3H₂O（氢还原）' },
  { input: {39:1, 7:1},        output: {45:1},  needs:'furnace',    name:'铅锭块',   chem:'PbS + O₂ → Pb + SO₂（还原冶炼）' },
  { input: {41:1, 7:1},        output: {46:1},  needs:'furnace',    name:'硅晶块',   chem:'SiO₂ + 2C → Si + 2CO（碳热还原）' },
  // ---- 新工作台配方（合金与工具）----
  { input: {19:1, 42:1},       output: {47:2},  needs:'workbench',  name:'青铜块',   chem:'Cu + Sn → Cu-Sn（合金，含Sn 10-12%）' },
  { input: {42:1, 45:1},       output: {48:2},  needs:'workbench',  name:'焊料块',   chem:'Sn + Pb → Sn-Pb（合金，熔点183°C）' },
  { input: {21:1, 43:1},       output: {49:2},  needs:'workbench',  name:'琥珀金',   chem:'Au + Ag → Au-Ag（天然合金）' },
  { input: {16:1, 46:1},       output: {50:2},  needs:'workbench',  name:'透镜',     chem:'SiO₂ + 玻璃 → 光学透镜（研磨抛光）' },
  { input: {20:2, 43:1},       output: {51:1},  needs:'workbench',  name:'导电板',   chem:'Fe + Ag → 导电板（压延焊接）' },
  { input: {40:1, 15:1},       output: {52:2},  needs:'workbench',  name:'硫磺弹',   chem:'S + C → 燃烧弹（火药配方）' },
  { input: {39:1, 61:1},       output: {53:1, 60:1},  needs:'workbench',  name:'毒药瓶',   chem:'Pb + H₂O → Pb(OH)₂（重金属毒性）' },
  { input: {46:1, 11:1},       output: {54:1},  needs:'workbench',  name:'半导体',   chem:'Si + C(金刚石) → 半导体（掺杂工艺）' },
  { input: {7:1, 51:1, 15:1},  output: {55:1},  needs:'workbench',  name:'电池组',   chem:'C + Ag + Fe → 电化学电池（原电池原理）' },
  // ---- 家具 ----
  { input: {13:6},             output: {59:1},  needs:'workbench',  name:'床',       chem:'木材 → 床（木工组装，可睡过夜晚）' },
  // ---- 桶（可接水/岩浆）----
  { input: {20:3},             output: {60:1},  needs:'workbench',  name:'铁桶',     chem:'Fe → 桶（冲压成型，可盛装液体）' },
  // ---- 新元素冶炼（周期表扩展）----
  { input: {66:1, 7:1},        output: {71:1},  needs:'furnace',    name:'铝锭块',   chem:'2Al₂O₃ + 3C → 4Al + 3CO₂（铝土矿电解冶炼）' },
  { input: {67:1, 7:1},        output: {72:1},  needs:'furnace',    name:'锌锭块',   chem:'ZnO + C → Zn + CO（火法炼锌）' },
  { input: {68:1, 7:1},        output: {73:1},  needs:'furnace',    name:'镍锭块',   chem:'NiO + C → Ni + CO（火法炼镍）' },
  { input: {69:1, 7:2},        output: {74:1},  needs:'furnace',    name:'钛锭块',   chem:'TiO₂ + 2C → Ti + 2CO（克劳尔法）' },
  { input: {70:1, 7:1},        output: {75:1},  needs:'furnace',    name:'镁锭块',   chem:'MgO + C → Mg + CO（皮江法）' },
  // ---- 新合金（S7 考据：黄铜=Cu+Zn、不锈钢=Fe+Ni）——合金是熔炼产物，放熔炉烧制 ----
  { input: {19:1, 72:1, 7:1},  output: {76:2},  needs:'furnace',    name:'黄铜块',   chem:'Cu + Zn + C(燃料) →(熔融) Cu-Zn（黄铜，含Zn 30-40%，S7考据）' },
  { input: {20:2, 73:1, 7:1},  output: {77:1},  needs:'furnace',    name:'不锈钢块', chem:'Fe + Ni + C(燃料) →(熔融) Fe-Ni（不锈钢，含Ni 8-10%防锈）' },
  // ---- 氢气块（电解水制氢：2H₂O → 2H₂↑ + O₂↑）----
  { input: {61:1, 55:1},       output: {65:2},  needs:'workbench',  name:'氢气块',   chem:'2H₂O →(电解) 2H₂↑ + O₂↑（电池组供电电解水）' },
  // ---- 闪光弹（镁弹：镁燃烧 2Mg+O₂→2MgO 耀眼白光，致盲效果）----
  { input: {75:1, 52:1},       output: {78:2},  needs:'workbench',  name:'闪光弹',   chem:'Mg + 火药 →(引燃) 2Mg+O₂→2MgO 白光（镁弹致盲）' },
];

// ===== 矿石生成配置 =====
// depth: 最小深度（从地表算起），veinSize: 矿脉大小，rarity: 生成概率
const ORE_CONFIG = [
  { block:7,  minDepth:5,  maxDepth:250, vein:3, rarity:0.024, name:'煤矿',   element:'C'  },
  { block:8,  minDepth:10, maxDepth:200, vein:4, rarity:0.010, name:'铜矿',   element:'Cu' },
  { block:9,  minDepth:15, maxDepth:250, vein:3, rarity:0.016, name:'铁矿',   element:'Fe' },
  { block:10, minDepth:50, maxDepth:280, vein:3, rarity:0.005, name:'金矿',   element:'Au' },
  { block:11, minDepth:100,maxDepth:290, vein:2, rarity:0.003, name:'钻石矿', element:'C'  },
  { block:36, minDepth:15, maxDepth:180, vein:4, rarity:0.009, name:'锡矿',   element:'Sn' },
  { block:37, minDepth:40, maxDepth:250, vein:3, rarity:0.006, name:'银矿',   element:'Ag' },
  { block:38, minDepth:70, maxDepth:290, vein:2, rarity:0.004, name:'钨矿',   element:'W'  },
  { block:39, minDepth:20, maxDepth:220, vein:3, rarity:0.007, name:'铅矿',   element:'Pb' },
  { block:40, minDepth:8,  maxDepth:150, vein:3, rarity:0.010, name:'硫矿',   element:'S'  },
  { block:41, minDepth:30, maxDepth:260, vein:3, rarity:0.008, name:'石英矿', element:'Si' },
  // ---- 新元素矿脉（周期表扩展，maxDepth 已按 H=300 适配 ≤195）----
  { block:66, minDepth:10, maxDepth:150, vein:3, rarity:0.012, name:'铝矿',   element:'Al' },
  { block:67, minDepth:15, maxDepth:160, vein:3, rarity:0.010, name:'锌矿',   element:'Zn' },
  { block:68, minDepth:30, maxDepth:175, vein:3, rarity:0.008, name:'镍矿',   element:'Ni' },
  { block:69, minDepth:60, maxDepth:190, vein:2, rarity:0.005, name:'钛矿',   element:'Ti' },
  { block:70, minDepth:8,  maxDepth:130, vein:3, rarity:0.010, name:'镁矿',   element:'Mg' },
];

// ===== 方块绘制纹理 =====
// 为每个方块生成确定性的纹理变化（基于坐标的伪随机）
// 结果按 (blockId,x,y) 缓存——确定性输出，缓存无限安全，避免每帧重复 hash 运算（帧率优化）
const _shadeCache = new Map();
function getBlockShade(blockId, x, y) {
  const key = (blockId << 20) | ((x & 0x3ff) << 10) | (y & 0x3ff);
  const cached = _shadeCache.get(key);
  if (cached !== undefined) return cached;
  const b = BLOCKS[blockId];
  if (!b || !b.color) return null;
  // 基于坐标的伪随机
  const h = ((x * 73856093) ^ (y * 19349663) ^ (blockId * 83492791)) & 0xffff;
  const r = h / 0xffff; // 0~1
  const variation = (r - 0.5) * 0.15; // ±7.5% 亮度变化
  const result = { color: b.color, shade: b.shade, variation };
  if (_shadeCache.size > 50000) _shadeCache.clear(); // 防无限增长（地图大时）
  _shadeCache.set(key, result);
  return result;
}

// ===== 元素属性映射 =====
// 每个方块对应的元素类型：火/水/土/木/金/能/晶
const BLOCK_ELEMENTS = {
  1:'earth', 2:'earth', 3:'earth', 6:'earth', 14:'earth', 22:'earth',
  4:'wood', 5:'wood', 13:'wood', 17:'wood',
  26:'wood', 27:'wood', 28:'wood', 33:'wood',
  7:'energy',
  8:'metal', 9:'metal', 10:'metal', 19:'metal', 20:'metal', 21:'metal',
  29:'metal', 30:'metal', 34:'metal',
  // 新金属矿石及产物
  36:'metal', 37:'metal', 38:'metal', 39:'metal',
  42:'metal', 43:'metal', 44:'metal', 45:'metal',
  47:'metal', 48:'metal', 49:'metal', 51:'metal',
  // 新非金属矿石及产物
  40:'poison', 52:'poison', 53:'poison',
  41:'crystal', 46:'crystal', 50:'crystal', 54:'crystal',
  55:'energy',
  11:'crystal', 16:'crystal', 25:'crystal',
  31:'crystal', 35:'crystal',
  12:'water', 23:'water', 24:'water',
  15:'fire', 18:'fire', 32:'fire',
  // 新元素方块：氢气块可爆燃→fire；铝/锌/镍/钛/镁及其锭块→metal
  65:'fire', 66:'metal', 67:'metal', 68:'metal', 69:'metal', 70:'metal',
  71:'metal', 72:'metal', 73:'metal', 74:'metal', 75:'metal',
  76:'metal', 77:'metal', 78:'fire',
  // 工具
  56:'wood', 57:'earth', 58:'metal', 64:'wood',
  79:'wood', 80:'earth', 81:'metal',
  60:'metal', 61:'metal', 62:'metal', 63:'fire',
};

// 元素信息（名称、图标、颜色）
const ELEMENT_INFO = {
  fire:    { name:'火', icon:'🔥', color:'#ff6b3a' },
  water:   { name:'水', icon:'💧', color:'#3a9bff' },
  earth:   { name:'土', icon:'⛰️', color:'#a8783a' },
  wood:    { name:'木', icon:'🌿', color:'#3acc5a' },
  metal:   { name:'金', icon:'⚙️', color:'#c0c0c8' },
  energy:  { name:'能', icon:'⚡', color:'#ffd633' },
  crystal: { name:'晶', icon:'💎', color:'#30d0d0' },
  poison:  { name:'毒', icon:'☠️', color:'#9b59b6' },
};

// ===== 元素反应规则 =====
// 两种元素搭配时触发反应，伤害翻倍
const ELEMENT_REACTIONS = [
  // 原有反应
  { a:'fire',    b:'water',   name:'蒸发', desc:'烈火遇水化为蒸汽', icon:'♨️' },
  { a:'fire',    b:'wood',    name:'燃烧', desc:'火焰点燃木材，烈焰狂舞', icon:'🔥' },
  { a:'fire',    b:'metal',   name:'熔化', desc:'高温熔化金属，灼热穿透', icon:'🌋' },
  { a:'water',   b:'metal',   name:'锈蚀', desc:'水分侵蚀金属，结构崩解', icon:'🦠' },
  { a:'water',   b:'earth',   name:'侵蚀', desc:'流水冲刷大地，山崩地裂', icon:'🌊' },
  { a:'energy',  b:'metal',   name:'导电', desc:'电能穿透金属，雷电连锁', icon:'⚡' },
  { a:'energy',  b:'water',   name:'电解', desc:'电流分解水分，氢氧爆裂', icon:'🔬' },
  { a:'crystal', b:'fire',    name:'折射', desc:'烈焰透过晶体，光束聚焦', icon:'🌈' },
  { a:'wood',    b:'earth',   name:'生长', desc:'木根深扎大地，自然之力爆发', icon:'🌳' },
  { a:'crystal', b:'energy',  name:'共振', desc:'能量激发晶体，频率共鸣', icon:'💫' },
  { a:'metal',   b:'earth',   name:'矿化', desc:'金属融入大地，坚不可摧', icon:'🪨' },
  // 新增毒系反应
  { a:'poison',  b:'water',   name:'污染', desc:'毒素溶入水中，蔓延侵蚀', icon:'🧪' },
  { a:'poison',  b:'fire',    name:'毒雾', desc:'烈焰灼烧毒物，毒雾弥漫', icon:'💀' },
  { a:'poison',  b:'metal',   name:'腐蚀', desc:'毒素侵蚀金属，结构溶解', icon:'☢️' },
  { a:'poison',  b:'wood',    name:'枯萎', desc:'毒素渗入木材，生机枯竭', icon:'🍂' },
  { a:'poison',  b:'earth',   name:'酸化', desc:'毒素渗入大地，土壤酸化', icon:'☣️' },
  { a:'poison',  b:'crystal', name:'淬毒', desc:'毒素附着晶体，淬毒利刃', icon:'🗡️' },
  { a:'poison',  b:'energy',  name:'辐射', desc:'能量激发毒素，辐射爆发', icon:'☢️' },
];

// ===== 化学元素周期表数据 =====
// 矿石blockId → 化学元素信息（基于真实周期表）
const PERIODIC_TABLE = {
  'C':  { number:6,  symbol:'C',  name:'碳',    nameEn:'Carbon',    mass:12.011,  category:'非金属',   config:'[He] 2s² 2p²',     desc:'一切有机生命的基石，钻石与石墨的本体。燃烧产生CO₂，是地球上最多才多艺的元素。', color:'#444444', group:14, period:2 },
  'Cu': { number:29, symbol:'Cu', name:'铜',    nameEn:'Copper',    mass:63.546,  category:'过渡金属', config:'[Ar] 3d¹⁰ 4s¹',    desc:'人类最早使用的金属之一，优异的导电导热性。氧化后呈绿色铜锈，是电线和合金的核心材料。', color:'#c87830', group:11, period:4 },
  'Fe': { number:26, symbol:'Fe', name:'铁',    nameEn:'Iron',      mass:55.845,  category:'过渡金属', config:'[Ar] 3d⁶ 4s²',     desc:'地核的主要成分，宇宙中第六丰富的元素。氧化生锈是它最常见的化学反应，钢的灵魂。', color:'#a08060', group:8,  period:4 },
  'Au': { number:79, symbol:'Au', name:'金',    nameEn:'Gold',      mass:196.967, category:'过渡金属', config:'[Xe] 4f¹⁴ 5d¹⁰ 6s¹', desc:'化学性质极稳定，不氧化不腐蚀。延展性极佳，1克可拉成3公里长的丝。自古以来是财富的象征。', color:'#d4af37', group:11, period:6 },
  'Sn': { number:50, symbol:'Sn', name:'锡',    nameEn:'Tin',       mass:118.710, category:'post-transition', config:'[Kr] 4d¹⁰ 5s² 5p²', desc:'低温下会变成粉末（锡疫）。与铜合成青铜，开启了人类的青铜时代。焊接电子元件的关键金属。', color:'#a0a0a8', group:14, period:5 },
  'Ag': { number:47, symbol:'Ag', name:'银',    nameEn:'Silver',    mass:107.868, category:'过渡金属', config:'[Kr] 4d¹⁰ 5s¹',    desc:'导电性最强的金属，也是最好的反光材料。遇硫变黑生成硫化银，有天然杀菌作用。', color:'#c8c8d8', group:11, period:5 },
  'W':  { number:74, symbol:'W',  name:'钨',    nameEn:'Tungsten',  mass:183.840, category:'过渡金属', config:'[Xe] 4f¹⁴ 5d⁴ 6s²', desc:'熔点最高的金属（3422°C），灯泡灯丝的材料。密度与黄金相当，硬度极高，用于穿甲弹。', color:'#4a5a4a', group:6,  period:6 },
  'Pb': { number:82, symbol:'Pb', name:'铅',    nameEn:'Lead',      mass:207.200, category:'post-transition', config:'[Xe] 4f¹⁴ 5d¹⁰ 6s² 6p²', desc:'密度大、熔点低，古罗马水管的材料（也是罗马灭亡的原因之一）。有毒，能阻挡辐射。', color:'#5a6a7a', group:14, period:6 },
  'S':  { number:16, symbol:'S',  name:'硫',    nameEn:'Sulfur',    mass:32.060,  category:'非金属',   config:'[Ne] 3s² 3p⁴',     desc:'黄色非金属，火山口常见。燃烧产生SO₂，是酸雨的元凶。与硝石混合可制火药。', color:'#d4d020', group:16, period:3 },
  'Si': { number:14, symbol:'Si', name:'硅',    nameEn:'Silicon',   mass:28.086,  category:'类金属',   config:'[Ne] 3s² 3p²',     desc:'地壳第二丰富的元素（27%），半导体之王。没有硅就没有芯片、太阳能板和整个数字时代。', color:'#8090a0', group:14, period:3 },
  // ---- 新元素（周期表扩展，全部按真实数据）----
  'H':  { number:1,  symbol:'H',  name:'氢',    nameEn:'Hydrogen',  mass:1.008,   category:'非金属',   config:'1s¹',            desc:'宇宙中最轻、最丰富的元素（占可见宇宙约75%）。燃烧生成水，是恒星核聚变的燃料。', color:'#cfe8f5', group:1,  period:1 },
  'Al': { number:13, symbol:'Al', name:'铝',    nameEn:'Aluminium', mass:26.982,  category:'金属',     config:'[Ne] 3s² 3p¹',    desc:'地壳中含量最高的金属元素（8.3%）。质轻耐腐蚀，航空航天与易拉罐的标配材料。', color:'#c0c8d0', group:13, period:3 },
  'Zn': { number:30, symbol:'Zn', name:'锌',    nameEn:'Zinc',      mass:65.380,  category:'过渡金属', config:'[Ar] 3d¹⁰ 4s²',    desc:'蓝白色金属，镀锌钢板防腐的关键。与铜合成黄铜，是人体必需的微量元素。', color:'#b0b8c4', group:12, period:4 },
  'Ni': { number:28, symbol:'Ni', name:'镍',    nameEn:'Nickel',    mass:58.693,  category:'过渡金属', config:'[Ar] 3d⁸ 4s²',     desc:'银白色金属，耐腐蚀。不锈钢的核心添加元素（含8-10%），也是硬币的成分。', color:'#c8d4c0', group:10, period:4 },
  'Ti': { number:22, symbol:'Ti', name:'钛',    nameEn:'Titanium',  mass:47.867,  category:'过渡金属', config:'[Ar] 3d² 4s²',     desc:'强度重量比极佳的"太空金属"，耐高温耐腐蚀。飞机发动机与人体植入物的材料。', color:'#b8c0d0', group:4,  period:4 },
  'Mg': { number:12, symbol:'Mg', name:'镁',    nameEn:'Magnesium', mass:24.305,  category:'碱土金属', config:'[Ne] 3s²',         desc:'银白色轻金属，燃烧发出耀眼白光（闪光弹原理）。叶绿素的核心原子。', color:'#e0e4e8', group:2,  period:3 },
};

// 矿石blockId → 化学元素符号映射
const ORE_ELEMENT_MAP = {
  7:'C', 8:'Cu', 9:'Fe', 10:'Au', 11:'C',
  36:'Sn', 37:'Ag', 38:'W', 39:'Pb', 40:'S', 41:'Si',
  // 新元素矿脉
  66:'Al', 67:'Zn', 68:'Ni', 69:'Ti', 70:'Mg',
};

// 导出
if (typeof window !== 'undefined') {
  globalThis.GAME_CONST = { TILE, WORLD_W, WORLD_H, GRAVITY, MAX_FALL, PLAYER_SPEED, JUMP_FORCE, REACH, JUMP_CUT, FALL_GRAVITY_MULT, APEX_GRAVITY_MULT, APEX_VY, COYOTE, JUMP_BUFFER };
  globalThis.BLOCKS = BLOCKS;
  globalThis.BLOCK_NAMES = BLOCK_NAMES;
  globalThis.RECIPES = RECIPES;
  globalThis.ORE_CONFIG = ORE_CONFIG;
  globalThis.getBlockShade = getBlockShade;
  globalThis.BLOCK_ELEMENTS = BLOCK_ELEMENTS;
  globalThis.ELEMENT_INFO = ELEMENT_INFO;
  globalThis.ELEMENT_REACTIONS = ELEMENT_REACTIONS;
  globalThis.PERIODIC_TABLE = PERIODIC_TABLE;
  globalThis.ORE_ELEMENT_MAP = ORE_ELEMENT_MAP;
}
