global.window = {};
require('D:/游戏/pixel-sandbox/js/data.js');
require('D:/游戏/pixel-sandbox/js/world.js');
const gen = global.window.WorldGen.generateWorld;
const W = 600, H = 300;
function stats(seed) {
  const w = gen(W, H, seed);
  let lm1=0, lm2=0, lm3=0, g58=0, g60=0, g62=0, g64=0;
  for (let x = 0; x < W; x++) {
    const sy = w.surfaceHeight[x];
    if (sy >= 58) g58++; if (sy >= 60) g60++; if (sy >= 62) g62++; if (sy >= 64) g64++;
    const l = x>0 ? w.surfaceHeight[x-1] : sy;
    const r = x<W-1 ? w.surfaceHeight[x+1] : sy;
    const d = sy - Math.min(l,r);
    if (sy>l && sy>r && d>1) lm1++;
    if (sy>l && sy>r && d>2) lm2++;
    if (sy>l && sy>r && d>3) lm3++;
  }
  return {g58,g60,g62,g64,lm1,lm2,lm3};
}
let t={g58:0,g60:0,g62:0,g64:0,lm1:0,lm2:0,lm3:0};
for (let s=1;s<=5;s++){const r=stats(s*777);for(const k in t)t[k]+=r[k];}
console.log('over 5 worlds (600 cols each=3000 cols):');
console.log('sy>=58:',t.g58,' sy>=60:',t.g60,' sy>=62:',t.g62,' sy>=64:',t.g64);
console.log('localMin d>1:',t.lm1,' d>2:',t.lm2,' d>3:',t.lm3);
