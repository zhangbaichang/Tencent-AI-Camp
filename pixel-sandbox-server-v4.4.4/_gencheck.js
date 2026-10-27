global.window = {};
require('D:/游戏/pixel-sandbox/js/data.js');
require('D:/游戏/pixel-sandbox/js/world.js');
const gen = global.window.WorldGen.generateWorld;
const W = 600, H = 300;
let s = 0, w = 0, c = 0;
for (let n = 0; n < 5; n++) {
  const m = gen(W, H, Math.floor(Math.random() * 10000));
  for (let i = 0; i < W * H; i++) {
    if (m.world[i] === 6) s++;
    if (m.world[i] === 12) w++;
    if (m.world[i] === 7) c++;
  }
}
console.log('sand:', s, 'water:', w, 'coal:', c);
console.log(s > 0 ? 'OK sand generates' : 'FAIL sand 0');
console.log(w > 0 ? 'OK water generates' : 'FAIL water 0');
