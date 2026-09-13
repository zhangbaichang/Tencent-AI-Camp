/**
 * 世界生成 Web Worker
 * 在独立线程跑 WorldGen.generateWorld，避免大世界同步生成卡死主线程（也兼容 file:// 直接打开时的同步兜底）。
 * 通过 importScripts 复用 data.js / world.js（二者已用 globalThis 暴露，worker 内同样可用）。
 */
importScripts('data.js', 'world.js');

onmessage = function (e) {
  const { W, H, seed } = e.data;
  const r = globalThis.WorldGen.generateWorld(W, H, seed);
  // 把大数组的底层 buffer 转移（零拷贝）给主线程，treeData 等普通结构走结构化克隆
  postMessage(r, [r.world.buffer, r.surfaceHeight.buffer]);
};
