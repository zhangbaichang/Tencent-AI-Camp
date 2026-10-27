const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {WorldInteractions}=require('../server/world-interactions');
function service(isSolid){return new WorldInteractions({file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'psb-physics-')),'chests.json'),tileAt:()=>0,isSolid,now:()=>10000});}
test('analog left and right facing throw in opposite directions and arc upward first',()=>{
 for(const facing of [-.2,.2]){
  const s=service(()=>false),p={x:240,y:96,inventory:{1:1}},d=s.handle('a',p,{action:'drop',id:1,count:1,facing}).drop;
  const x=d.x,y=d.y;s.tick(1/60);assert.equal(Math.sign(d.x-x),Math.sign(facing));assert.ok(d.y<y);assert.ok(d.vy<0);
  for(let i=0;i<20;i++)s.tick(1/60);assert.ok(d.vy>0);
 }
});
test('dropped item lands flush on the floor and comes to rest without hovering',()=>{
 const s=service((x,y)=>y>=8),p={x:96,y:72,inventory:{1:1}},d=s.handle('a',p,{action:'drop',id:1,count:1,facing:1}).drop;
 for(let i=0;i<180;i++)s.tick(1/60);
 assert.equal(d.y,8*24-8);assert.equal(d.vy,0);assert.equal(d.vx,0);assert.equal(d.grounded,true);
});
test('wall collision blocks forward movement and floor removal resumes falling',()=>{
 let floor=8;const s=service((x,y)=>x===6||y>=floor),p={x:96,y:72,inventory:{1:1}},d=s.handle('a',p,{action:'drop',id:1,count:1,facing:1}).drop;
 for(let i=0;i<180;i++)s.tick(1/60);assert.ok(d.x<=6*24-8);assert.equal(d.y,184);
 floor=10;for(let i=0;i<90;i++)s.tick(1/60);assert.equal(d.y,232);
});
test('client direction accepts negative fractional joystick values',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8'),c={game:{player:{facing:-.25}}};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function dropFacingSign()'),source.indexOf('// 在玩家朝向',source.indexOf('function dropFacingSign()'))),c);
 assert.equal(c.dropFacingSign(),-1);c.game.player.facing=.25;assert.equal(c.dropFacingSign(),1);
});
test('client snapshots preserve drawing positions for smooth movement and clear removed drops',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../js/game.js'),'utf8'),c={game:{droppedItems:[]}};vm.createContext(c);
 vm.runInContext(source.slice(source.indexOf('function applySharedDrops('),source.indexOf('async function dropSharedItem(')),c);
 c.applySharedDrops([{sharedId:'one',x:10,y:10,vx:4,vy:-4}]);c.applySharedDrops([{sharedId:'one',x:20,y:5,vx:4,vy:-3}]);
 assert.equal(c.game.droppedItems[0].x,10);assert.equal(c.game.droppedItems[0].targetX,20);assert.equal(c.game.droppedItems[0].targetY,5);
 c.applySharedDrops([]);assert.equal(c.game.droppedItems.length,0);
});
