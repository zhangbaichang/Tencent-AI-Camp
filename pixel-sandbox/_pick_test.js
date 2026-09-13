// 复刻 updateDroppedItems 的拾取判定，验证长寿命丢弃物可拾取
function pickable(item, p) {
  const dx = (p.x + p.w / 2) - (item.x + 4);
  const dy = (p.y + p.h / 2) - (item.y + 4);
  return Math.abs(dx) < 24 && Math.abs(dy) < 24 && item.age > 50;
}
const p = { x: 30 * 16, y: 20 * 16, w: 12, h: 28 };
const item = { x: 32 * 16 + 8, y: 20 * 16 + 8, age: 0 }; // 约 2 格外
console.log('出生瞬间(age=0) 可拾取 =', pickable(item, p), '(应为 false，防误拾)');
item.age = 100;
console.log('100ms 后 可拾取 =', pickable(item, p), '(应为 true)');
item.age = 60000;
console.log('寿命将尽(60s) 可拾取 =', pickable(item, p), '(应为 true，仍可捡)');
