const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../js/player-view');
test('HUD and admin use feet-center tile coordinates rather than raw pixels',()=>{
 assert.deepEqual(view.coordinates(240,480),{x:10,y:21});
 assert.deepEqual(view.coordinates(15,12),{x:1,y:2});
 assert.deepEqual(view.coordinates(14.9,11.9),{x:0,y:1});
 assert.equal(view.coordinates(NaN,0),null);
});
test('keyboard and joystick can face left, right and retain facing on release',()=>{
 let direction=1;
 direction=view.facing(view.horizontal({KeyA:true},1),direction);assert.equal(direction,-1);
 direction=view.facing(view.horizontal({},0),direction);assert.equal(direction,-1);
 direction=view.facing(view.horizontal({ArrowRight:true},-1),direction);assert.equal(direction,1);
 direction=view.facing(view.horizontal({},-.25),direction);assert.equal(direction,-1);
 direction=view.facing(view.horizontal({},.02),direction);assert.equal(direction,-1);
 assert.equal(view.horizontal({KeyA:true,KeyD:true},1),0);
});
test('avatar body is fully mirrored left, with correct transform origin',()=>{
 for(const facing of [-1,1]){
  const calls=[],ctx={save(){},restore(){},fillRect(){},translate(...a){calls.push(['translate',...a]);},scale(...a){calls.push(['scale',...a]);}};
  view.drawBody(ctx,{facing,w:18,h:36},100,200,'blue');
  assert.deepEqual(calls,[['translate',facing<0?118:100,200],['scale',facing,1]]);
 }
});
