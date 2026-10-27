const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8');
function setup(){
 const game={inventory:{1:10,2:5},inventorySlots:[1,2],hotbar:[1,2,0,0,0,0,0,0,0,0],hotbarCounts:[],cursorId:0,cursorCount:0,chestIdx:1,multiplayer:{},inventoryOpen:true};
 const chests={1:Array(27).fill(null)};
 const ctx={game,chests,console,captureChestRollback:()=>{},setTimeout,clearTimeout,isCreativeMode:()=>false,getChest:i=>chests[i],showToast:()=>{},sfx:()=>{},normalizeHotbar:()=>{},markCursorDropTs:()=>{},setCursorItem:(id,n)=>{game.cursorId=id;game.cursorCount=n;},clearCursorItem:()=>{game.cursorId=0;game.cursorCount=0;},posDragCursor:()=>{},uiSlotFromTarget:t=>t?.slot||null,document:{body:{classList:{add(){},remove(){}}},querySelectorAll:()=>[],elementFromPoint:()=>null},window:{}};
 vm.createContext(ctx);
 vm.runInContext(src.slice(src.indexOf('const INVENTORY_SLOTS_SURVIVAL'),src.indexOf('// ==================== 背包界面')),ctx);
 vm.runInContext('const DRAG_PICK_PX=7;let _drag=null;'+src.slice(src.indexOf('function pickBagItem('),src.indexOf('// 硫磺弹(52)')),ctx);
 return ctx;
}
test('bag swaps persist after normalization without changing quantities',()=>{const c=setup();c.pickBagItem(1,0);c.placeOrSwapBagCard(1);c.ensureInventorySlots();assert.deepEqual(Array.from(c.game.inventorySlots.slice(0,2)),[2,1]);assert.deepEqual(c.game.inventory,{1:10,2:5});});
test('cancel and empty-slot move keep exactly one slot per item',()=>{const c=setup();c.pickBagItem(1);c.restoreCursorSource();c.pickBagItem(1);c.placeOrSwapBagCard(8);c.ensureInventorySlots();assert.equal(c.game.inventorySlots[8],1);assert.equal(c.game.inventorySlots.filter(x=>x===1).length,1);});
test('hotbar exchange never duplicates inventory',()=>{const c=setup();c.pickBagItem(1);c.placeCursorToHotbarSlot(1);assert.deepEqual(c.game.hotbar.slice(0,2),[2,1]);assert.equal(c.game.inventory[1],10);assert.equal(c.game.cursorId,0);});
test('bag to chest subtracts ownership; chest to bag merges counts',()=>{const c=setup();c.chests[1][0]={id:1,count:3};c.pickBagItem(1);c.placeCursorIntoChestSlot(0);assert.equal(c.chests[1][0].count,13);assert.equal(c.game.inventory[1],undefined);c.chestPick(0);c.placeOrSwapBagCard(0);assert.equal(c.game.inventory[1],13);assert.equal(c.chests[1][0],null);});
test('chest swaps and cancelled picks conserve both items',()=>{const c=setup();c.chests[1][0]={id:3,count:7};c.pickBagItem(1);c.placeCursorIntoChestSlot(0);assert.equal(c.game.inventory[3],7);assert.equal(c.chests[1][0].count,10);c.chestPick(0);c.restoreCursorSource();assert.equal(c.chests[1][0].count,10);});
test('chest to occupied hotbar transfers only once',()=>{const c=setup();c.chests[1][0]={id:1,count:4};c.chestPick(0);c.placeCursorToHotbarSlot(1);assert.equal(c.game.inventory[1],14);assert.equal(c.game.hotbar[1],1);assert.equal(c.game.cursorId,0);});
test('36 occupied slots expand when taking a new item from chest',()=>{const c=setup();c.game.inventory=Object.fromEntries(Array.from({length:36},(_,i)=>[i+1,1]));c.ensureInventorySlots();c.chests[1][0]={id:99,count:3};c.chestPick(0);c.placeOrSwapBagCard(0);assert.equal(c.game.inventory[99],3);assert.equal(c.chests[1][0],null);assert.equal(c.game.inventorySlots.length,42);assert.ok(c.game.inventorySlots.includes(99));});
test('touch movement before long press scrolls without picking',()=>{const c=setup();const panel={scrollTop:100};const target={slot:{zone:'bag',id:1,slot:0},closest:s=>s.startsWith('button')?null:panel};c.pressDragPointer({pointerType:'touch',pointerId:1,target,clientX:20,clientY:80});c.moveDragPointer({pointerId:1,clientX:20,clientY:40,cancelable:true,preventDefault(){}});c.releaseDragPointer({pointerId:1,clientX:20,clientY:40});assert.equal(panel.scrollTop,140);assert.equal(c.game.cursorId,0);});
test('other fingers cannot complete or cancel an active drag',()=>{const c=setup();const panel={scrollTop:0};const target={slot:{zone:'bag',id:1,slot:0},closest:s=>s.startsWith('button')?null:panel};c.pressDragPointer({pointerType:'mouse',pointerId:1,button:0,target,clientX:20,clientY:80});c.releaseDragPointer({pointerId:2});c.cancelDragPointer({pointerId:2});c.releaseDragPointer({pointerId:1,clientX:20,clientY:80});assert.equal(c.game.cursorId,1);c.cancelDragPointer();assert.equal(c.game.cursorId,0);});
test('long press picks and cancellation restores; closed panels cannot pick',async()=>{
 const c=setup(),panel={scrollTop:0},target={slot:{zone:'bag',id:1,slot:0},closest:s=>s.startsWith('button')?null:panel};
 c.pressDragPointer({pointerType:'touch',pointerId:1,target,clientX:20,clientY:80});
 await new Promise(r=>setTimeout(r,270));assert.equal(c.game.cursorId,1);c.cancelDragPointer();assert.equal(c.game.inventory[1],10);
 c.pressDragPointer({pointerType:'touch',pointerId:2,target,clientX:20,clientY:80});c.game.inventoryOpen=false;
 await new Promise(r=>setTimeout(r,270));assert.equal(c.game.cursorId,0);c.cancelDragPointer();
});

test('old saves with more than 36 kinds display every owned item exactly once',()=>{
 const c=setup();c.game.inventory=Object.fromEntries(Array.from({length:80},(_,i)=>[i+1,i+2]));c.game.inventorySlots=Array.from({length:36},(_,i)=>i+1);
 c.ensureInventorySlots();assert.equal(c.game.inventorySlots.length,84);
 assert.equal(new Set(c.game.inventorySlots.filter(Boolean)).size,80);
 for(let id=1;id<=80;id++){assert.ok(c.game.inventorySlots.includes(id));assert.equal(c.game.inventory[id],id+1);}
 const saved=JSON.parse(JSON.stringify(c.game));c.game.inventorySlots=saved.inventorySlots;c.ensureInventorySlots();assert.deepEqual(Array.from(c.game.inventorySlots),saved.inventorySlots);
});
test('expansion preserves sorting and does not shrink after consuming items',()=>{
 const c=setup();c.game.inventory=Object.fromEntries(Array.from({length:37},(_,i)=>[i+1,1]));c.game.inventorySlots=[2,1];c.ensureInventorySlots();
 assert.deepEqual(Array.from(c.game.inventorySlots.slice(0,2)),[2,1]);c.pickBagItem(1,1);c.placeOrSwapBagCard(41);
 delete c.game.inventory[37];c.ensureInventorySlots();assert.equal(c.game.inventorySlots.length,42);assert.equal(c.game.inventorySlots[41],1);assert.equal(c.game.inventorySlots.includes(37),false);
});
test('chest to hotbar is allowed beyond 36 kinds and conserves quantities',()=>{
 const c=setup();c.game.inventory=Object.fromEntries(Array.from({length:36},(_,i)=>[i+1,1]));c.ensureInventorySlots();c.chests[1][0]={id:99,count:7};c.chestPick(0);c.placeCursorToHotbarSlot(4);c.ensureInventorySlots();
 assert.equal(c.game.inventory[99],7);assert.equal(c.game.hotbar[4],99);assert.ok(c.game.inventorySlots.includes(99));assert.equal(c.chests[1][0],null);
});
