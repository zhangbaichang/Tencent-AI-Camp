function sim(lvl, world, W, H, horiz) {
  const buf = new Int8Array(W * H); buf.fill(0);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; const c = lvl[i]; if (c <= 0) continue; let rem = c;
    if (y + 1 < H) { const d = i + W; const dl = lvl[d];
      if (dl === 0 && world[d] === 0) { const f = Math.min(rem, c); buf[i] -= f; buf[d] += f; rem -= f; }
      else if (dl > 0 && dl < 4) { const f = Math.min(rem, Math.ceil((c - dl) / 2)); if (f > 0) { buf[i] -= f; buf[d] += f; rem -= f; } } }
    if (horiz && rem > 0 && c >= 2) {
      for (const nx of (x > 0 ? [x - 1] : []).concat(x < W - 1 ? [x + 1] : [])) {
        const n = y * W + nx; const nl = lvl[n];
        if (((nl === 0 && world[n] === 0) || (nl > 0 && nl < 4)) && c - nl >= 2) { const f = Math.min(rem, Math.floor((c - nl) / 2)); if (f > 0) { buf[i] -= f; buf[n] += f; rem -= f; } } }
  }
  for (let i = 0; i < W * H; i++) { if (buf[i] === 0) continue; let v = lvl[i] + buf[i]; if (v < 0) v = 0; else if (v > 4) v = 4; lvl[i] = v; world[i] = v > 0 ? 12 : 0; }
}
const W = 20, H = 12; const lvl = new Int8Array(W * H);
let before = 0;
for (let i = 0; i < lvl.length; i++) { if (Math.random() < 0.15) { lvl[i] = 1 + Math.floor(Math.random() * 4); before += lvl[i]; } }
function sum(a) { return a.reduce((s, v) => s + v, 0); }
const w1 = new Uint8Array(W * H); const a = lvl.slice(); for (let t = 0; t < 200; t++) sim(a, w1, W, H, true);
const w2 = new Uint8Array(W * H); const b = lvl.slice(); for (let t = 0; t < 200; t++) sim(b, w2, W, H, false);
console.log('开启横向(新规则) 水量=' + sum(a) + ' 守恒=' + (sum(a) === before));
console.log('关闭横向(纯纵向) 水量=' + sum(b) + ' 守恒=' + (sum(b) === before) + ' (初始=' + before + ')');
