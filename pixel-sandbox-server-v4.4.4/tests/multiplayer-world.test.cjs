const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),WebSocket=require('../server/node_modules/ws');
test('two real clients share drops, compete for one pickup and reopen password chests',async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'psb-multiplayer-'));
 fs.cpSync(root,tmp,{recursive:true,filter:p=>!['server/data','server/world','server/players.json','server/players_backup.json','data'].includes(path.relative(root,p).replaceAll('\\','/'))});
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,['server/server.js'],{cwd:tmp,env:{...process.env,PORT:String(port),SAKURA_LOG_DIR:path.join(tmp,'no-frp')},windowsHide:true,stdio:'ignore'}),clients=[];
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  async function connect(id){
   const account=await (await fetch(base+'/api/account/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:id,nickname:id,password:'test-password'})})).json();
   const ws=new WebSocket(base.replace('http:','ws:')),queue=[],waiters=[];clients.push(ws);
   ws.on('message',raw=>{const msg=JSON.parse(raw),i=waiters.findIndex(w=>w.match(msg));if(i>=0){const w=waiters.splice(i,1)[0];clearTimeout(w.timer);w.resolve(msg);}else queue.push(msg);});
   const wait=match=>new Promise((resolve,reject)=>{const i=queue.findIndex(match);if(i>=0){resolve(queue.splice(i,1)[0]);return;}const w={match,resolve};w.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(w),1);reject(Error('message timeout'));},5000);waiters.push(w);});
   await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
   const send=msg=>ws.send(JSON.stringify(msg));send({type:'join',accountToken:account.token});const welcome=await wait(m=>m.type==='welcome');
   let next=0;const action=(action,data={})=>{const requestId=++next;send({type:'world_action',requestId,action,...data});return wait(m=>m.type==='world_result'&&m.requestId===requestId);};
   send({type:'move',x:0,y:0,health:100});return{send,wait,action,welcome};
  }
  const a=await connect('world_a'),b=await connect('world_b');
  a.send({type:'move',x:240,y:480,facing:-.25,health:100});
  const left=await b.wait(m=>m.type==='move'&&m.x===240);assert.equal(left.facing,-1);
  const online=await (await fetch(base+'/api/players')).json();
  assert.deepEqual(online.players.find(p=>p.nickname==='world_a').coordinates,{x:10,y:21});
  a.send({type:'move',x:0,y:0,facing:1,health:100});
  a.send({type:'playerData',inventory:{1:10},inventorySlots:[1],hotbar:[1]});b.send({type:'playerData',inventory:{},inventorySlots:[],hotbar:[]});
  const drop=await a.action('drop',{id:1,count:3,facing:1});assert.equal(drop.ok,true);
  const seen=await b.wait(m=>m.type==='shared_drops'&&m.drops.some(d=>d.sharedId===drop.drop.sharedId));assert.equal(seen.drops[0].count,3);
  b.send({type:'move',x:48,y:0,health:100});a.send({type:'move',x:48,y:0,health:100});await new Promise(r=>setTimeout(r,850));
  const current=(await a.action('drops')).drops.find(d=>d.sharedId===drop.drop.sharedId);a.send({type:'move',x:current.x-9,y:current.y-18,health:100});b.send({type:'move',x:current.x-9,y:current.y-18,health:100});
  const results=await Promise.all([a.action('pickup',{sharedId:drop.drop.sharedId}),b.action('pickup',{sharedId:drop.drop.sharedId})]);assert.equal(results.filter(r=>r.ok).length,1);
  a.send({type:'move',x:0,y:0,health:100});b.send({type:'move',x:0,y:0,health:100});
  a.send({type:'block',tx:0,ty:0,tileId:27});
  await b.wait(m=>m.type==='block'&&m.tx===0&&m.ty===0&&m.tileId===27);const opened=await a.action('chest_open',{index:0});assert.equal(opened.ok,true);
  const slots=Array(27).fill(null);slots[0]={id:82,count:1};assert.equal((await a.action('chest_save',{index:0,token:opened.token,slots})).ok,true);
  assert.equal((await a.action('chest_password',{index:0,token:opened.token,password:'chest-pass'})).ok,true);
  const c=await connect('world_c');assert.ok(c.welcome.worldstate.tiles.some(([index,id])=>index===0&&id===27));assert.equal(c.welcome.chests,undefined);
  const visible=await b.action('drops');assert.equal(visible.ok,true);
  assert.equal((await b.action('chest_open',{index:0,password:'wrong-pass'})).ok,false);
  const unlocked=await b.action('chest_open',{index:0,password:'chest-pass'});assert.equal(unlocked.ok,true);assert.equal(unlocked.slots[0].id,82);
  assert.equal((await b.action('chest_close',{index:0,token:unlocked.token,slots:unlocked.slots})).ok,true);
  assert.equal((await b.action('chest_open',{index:0})).ok,false);
  assert.equal((await fetch(base+'/server/data/chests.json')).status,403);
 }finally{for(const ws of clients)ws.terminate();child.kill();await new Promise(resolve=>child.once('exit',resolve));}
});
