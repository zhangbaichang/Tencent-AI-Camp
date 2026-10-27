/**
 * 程序化世界生成引擎
 * 地形 / 矿石 / 洞穴 / 树木 / 水池
 */
(function() {
'use strict';

// ===== 噪声函数 =====
function hash(x, seed) {
  let n = Math.sin(x * 127.1 + seed * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function hash2D(x, y, seed) {
  let n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

function smoothNoise1D(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(i, seed);
  const b = hash(i + 1, seed);
  const t = f * f * (3 - 2 * f);
  return a * (1 - t) + b * t;
}

function smoothNoise2D(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);
  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function fbm1D(x, seed) {
  let v = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < 5; i++) {
    v += smoothNoise1D(x * freq, seed + i * 17) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / max;
}

function fbm2D(x, y, seed) {
  let v = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < 4; i++) {
    v += smoothNoise2D(x * freq, y * freq, seed + i * 31) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / max;
}

// ===== 确定性 PRNG (mulberry32) =====
function makeRng(seed) {
  let s = (seed | 0) || 1;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== 世界生成 =====
function generateWorld(W, H, seed) {
  const rand = makeRng(seed);
  // 2D 数组：world[y][x] = blockId
  const world = new Uint8Array(W * H);
  const surfaceHeight = new Int16Array(W); // 每列地表高度

  // 1. 生成地表高度图
  for (let x = 0; x < W; x++) {
    // 基础地形：多层噪声叠加
    const base = fbm1D(x * 0.008, seed);
    const hills = fbm1D(x * 0.03, seed + 100);
    const mountains = fbm1D(x * 0.004, seed + 200);

    let h = base * 40 + hills * 15 + mountains * 50;
    // 雪原区域（x前30格和后30格）
    const isSnow = x < 40 || x > W - 40;

    const surfaceY = Math.floor(H * 0.35 - h);
    surfaceHeight[x] = Math.max(5, Math.min(H - 60, surfaceY));
  }

  // 2. 填充地形
  for (let x = 0; x < W; x++) {
    const sy = surfaceHeight[x];
    const isSnow = x < 40 || x > W - 40;

    for (let y = 0; y < H; y++) {
      if (y < sy) {
        // 空气
        world[y * W + x] = 0;
      } else if (y === sy) {
        // 地表
        if (isSnow) {
          world[y * W + x] = 23; // 雪
      } else if (sy >= Math.floor(H * 0.35 - 45)) {
        world[y * W + x] = 6; // 沙子（低洼/平坦海滩区域）
      } else {
        world[y * W + x] = 1; // 草地
      }
      } else if (y < sy + 6) {
        // 泥土层
        if (isSnow && y < sy + 3) {
          world[y * W + x] = 23;
        } else {
          world[y * W + x] = 2; // 泥土
        }
      } else {
        // 石头层
        world[y * W + x] = 3;
      }
    }
  }

  // 3. 生成洞穴（2D噪声阈值）
  for (let x = 0; x < W; x++) {
    const sy = surfaceHeight[x];
    for (let y = sy + 6; y < H; y++) {
      const depth = y - sy;
      // 洞穴噪声
      const caveNoise = fbm2D(x * 0.06, y * 0.06, seed + 500);
      const caveNoise2 = fbm2D(x * 0.12, y * 0.12, seed + 600);

      // 深层洞穴更密集
      const threshold = 0.48 - depth * 0.0005;
      if (caveNoise > threshold && caveNoise2 > 0.5) {
        world[y * W + x] = 0; // 挖空
      }
    }
  }

  // 4. 生成矿石矿脉
  const { ORE_CONFIG } = window;
  for (let x = 0; x < W; x++) {
    const sy = surfaceHeight[x];
    for (let y = sy + 6; y < H; y++) {
      if (world[y * W + x] !== 3) continue; // 只在石头中生成

      const depth = y - sy;
      for (const ore of ORE_CONFIG) {
        if (depth < ore.minDepth || depth > ore.maxDepth) continue;
        if (rand() < ore.rarity) {
          // 生成矿脉
          const veinSize = ore.vein + Math.floor(rand() * 3);
          generateVein(world, W, H, x, y, ore.block, veinSize, rand);
        }
      }
    }
  }

  // 5. 生成树木
  const treeData = [];
  for (let x = 5; x < W - 5; x++) {
    const sy = surfaceHeight[x];
    if (world[sy * W + x] !== 1) continue; // 只在草地上长树

    if (rand() < 0.12) {
      const treeH = 4 + Math.floor(rand() * 4);
      const trunkX = x;

      // 树干
      for (let i = 1; i <= treeH; i++) {
        const ty = sy - i;
        if (ty >= 0) world[ty * W + trunkX] = 4; // 原木
      }

      // 树冠（椭圆形树叶）
      const crownY = sy - treeH;
      const crownR = 2 + Math.floor(rand() * 2);
      for (let dy = -crownR; dy <= crownR; dy++) {
        for (let dx = -crownR; dx <= crownR; dx++) {
          const px = trunkX + dx;
          const py = crownY + dy;
          if (px < 0 || px >= W || py < 0 || py >= H) continue;
          // 椭圆形
          const dist = (dx * dx) / (crownR * crownR) + (dy * dy) / (crownR * crownR * 0.7);
          if (dist <= 1.2 && world[py * W + px] === 0) {
            if (rand() < 0.85) {
              world[py * W + px] = 5; // 树叶
            }
          }
        }
      }

      treeData.push({ x: trunkX, y: sy });
      x += 2; // 树之间留间隔
    }
  }

  // 6. 生成水池（低洼处）
  for (let x = 0; x < W; x++) {
    const sy = surfaceHeight[x];

    // 低洼（地表较低处）形成湖泊。原"局部最低点"判定因地形噪声过于平滑、
    // 相邻列高差恒 <1 而从不触发，故改为按实际地表高度范围（约 42~66）取最低带
    const lowBand = Math.floor(H * 0.35 - 43); // ≈62，实际地形最低区间
    if (sy >= lowBand) {
      // 填充水（低洼越深，水面越宽）
      let waterDepth = Math.min(4, (sy - lowBand) + 1);
      for (let i = 1; i <= waterDepth; i++) {
        const wy = sy - i;
        if (wy >= 0 && world[wy * W + x] === 0) {
          world[wy * W + x] = 12; // 水
        }
      }
      // 湖岸铺沙，提供可靠的沙源（用于烧制玻璃/砖块）
      world[sy * W + x] = 6; // 沙子
    }
  }

  // 7. 生成深层黑曜石
  for (let x = 0; x < W; x++) {
    for (let y = H - 15; y < H; y++) {
      if (world[y * W + x] === 3 && rand() < 0.03) {
        world[y * W + x] = 25; // 黑曜石
      }
    }
  }

  // 8. 生成地下岩浆（深层洞穴岩浆池 + 近基岩岩浆海）
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (world[y * W + x] !== 0) continue; // 只在空洞（多为洞穴）中生成
      const depthRatio = y / H;
      // 深层随机岩浆池
      if (depthRatio > 0.70) {
        const ln = fbm2D(x * 0.085, y * 0.085, seed + 777);
        if (ln > 0.60) world[y * W + x] = 63; // 岩浆
      }
      // 近基岩岩浆海（非实心岩石处填满岩浆，营造地心熔岩层）
      if (y > H - 16) {
        const ln = fbm2D(x * 0.05, y * 0.05, seed + 999);
        if (ln > 0.30) world[y * W + x] = 63;
      }
    }
  }

  return { world, surfaceHeight, W, H, seed, treeData };
}

// 生成矿脉
function generateVein(world, W, H, sx, sy, blockId, size, rand) {
  const queue = [[sx, sy]];
  const placed = new Set();
  let count = 0;

  while (queue.length > 0 && count < size) {
    const [cx, cy] = queue.shift();
    const key = cy * W + cx;
    if (placed.has(key)) continue;
    if (cx < 0 || cx >= W || cy < 0 || cy >= H) continue;
    if (world[key] !== 3) continue; // 只替换石头

    world[key] = blockId;
    placed.add(key);
    count++;

    // 随机扩展
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
    for (const [dx, dy] of dirs) {
      if (rand() < 0.5) {
        queue.push([cx + dx, cy + dy]);
      }
    }
  }
}

// 导出
if (typeof window !== 'undefined') {
  globalThis.WorldGen = { generateWorld };
}

})();
