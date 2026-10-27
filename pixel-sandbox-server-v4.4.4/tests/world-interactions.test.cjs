const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {WorldInteractions}=require('../server/world-interactions');
function setup(){let time=10000;const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'psb-chests-')),'chests.json');const service=new WorldInteractions({file,tileAt:()=>27,now:()=>time});const p={x:0,y:0,inventory:{1:10}};return{service,p,file,tick:n=>time+=n};}
test('optional chest password is hashed, wrong passwords fail, close and restart relock',()=>{
 const {service:s,p,file}=setup();let r=s.handle('a',p,{action:'chest_open',index:0});assert.equal(r.locked,false);
 const slots=Array(27).fill(null);slots[0]={id:82,count:2};s.handle('a',p,{action:'chest_save',index:0,token:r.token,slots});
 s.handle('a',p,{action:'chest_password',index:0,token:r.token,password:'secret-123'});
 assert.equal(fs.readFileSync(file,'utf8').includes('secret-123'),false);
 assert.throws(()=>s.handle('b',p,{action:'chest_open',index:0,password:'wrong'}),/密码/);
 r=s.handle('b',p,{action:'chest_open',index:0,password:'secret-123'});assert.equal(r.slots[0].count,2);assert.equal(r.canManage,false);
 assert.throws(()=>s.handle('b',p,{action:'chest_password',index:0,token:r.token,password:''}),/所有者/);
 s.handle('b',p,{action:'chest_close',index:0,token:r.token,slots:r.slots});
 assert.throws(()=>s.handle('b',p,{action:'chest_save',index:0,token:r.token,slots}),/锁定/);
 assert.throws(()=>s.handle('b',p,{action:'chest_open',index:0}),/密码/);
 const restarted=new WorldInteractions({file,tileAt:()=>27});assert.throws(()=>restarted.handle('a',p,{action:'chest_open',index:0}),/密码/);
 const unlocked=restarted.handle('a',p,{action:'chest_open',index:0,password:'secret-123'});assert.equal(unlocked.slots[0].id,82);
 restarted.handle('a',p,{action:'chest_password',index:0,token:unlocked.token,password:''});assert.equal(restarted.handle('b',p,{action:'chest_open',index:0}).locked,false);
});
test('chest sessions are account bound, exclusive and expire or revoke on disconnect',()=>{
 const {service:s,p,tick}=setup();const r=s.handle('a',p,{action:'chest_open',index:0});
 assert.throws(()=>s.handle('b',p,{action:'chest_open',index:0}),/正在使用/);
 assert.throws(()=>s.handle('b',p,{action:'chest_save',index:0,token:r.token,slots:Array(27).fill(null)}),/锁定/);
 tick(90001);assert.throws(()=>s.handle('a',p,{action:'chest_renew',index:0,token:r.token}),/锁定/);
 const next=s.handle('a',p,{action:'chest_open',index:0});s.release('a');assert.throws(()=>s.handle('a',p,{action:'chest_renew',index:0,token:next.token}),/锁定/);
});
test('shared drop is visible to both accounts and can be collected exactly once',()=>{
 const {service:s,p}=setup();const b={x:0,y:0,inventory:{}};
 const r=s.handle('a',p,{action:'drop',id:1,count:3,facing:1});assert.equal(p.inventory[1],7);
 assert.equal(s.handle('b',b,{action:'drops'}).drops[0].sharedId,r.drop.sharedId);
 const pickup=s.handle('b',b,{action:'pickup',sharedId:r.drop.sharedId});assert.equal(pickup.item.count,3);assert.equal(b.inventory[1],3);
 assert.throws(()=>s.handle('a',p,{action:'pickup',sharedId:r.drop.sharedId}),/已被拾取/);assert.equal(s.handle('a',p,{action:'drops'}).drops.length,0);
});
test('drop validates ownership, position and expiration',()=>{
 const {service:s,p,tick}=setup();assert.throws(()=>s.handle('a',p,{action:'drop',id:1,count:11}),/不足/);
 const r=s.handle('a',p,{action:'drop',id:1,count:1});assert.throws(()=>s.handle('b',{x:1000,y:1000,inventory:{}},{action:'pickup',sharedId:r.drop.sharedId}),/太远/);
 tick(60001);assert.equal(s.handle('a',p,{action:'drops'}).drops.length,0);
});
test('lit explosives detonate once and cannot be collected',()=>{
 const {service:s,p,tick}=setup();p.inventory[52]=1;
 const r=s.handle('a',p,{action:'drop',id:52,count:1});assert.throws(()=>s.handle('b',p,{action:'pickup',sharedId:r.drop.sharedId}),/不能拾取/);
 tick(801);s.clean();s.clean();assert.equal(s.events.length,1);assert.equal(s.events[0].id,52);assert.equal(s.drops.size,0);
});
test('only owner with an open empty chest can remove it',()=>{
 const {service:s,p}=setup();const r=s.handle('a',p,{action:'chest_open',index:0});
 assert.throws(()=>s.handle('b',p,{action:'chest_remove',index:0,token:r.token}),/锁定/);
 const slots=Array(27).fill(null);slots[0]={id:1,count:1};s.handle('a',p,{action:'chest_save',index:0,token:r.token,slots});
 assert.throws(()=>s.handle('a',p,{action:'chest_remove',index:0,token:r.token}),/取空/);
 s.handle('a',p,{action:'chest_save',index:0,token:r.token,slots:Array(27).fill(null)});
 assert.equal(s.handle('a',p,{action:'chest_remove',index:0,token:r.token}).removed,true);assert.equal(s.protected(0),false);
});
