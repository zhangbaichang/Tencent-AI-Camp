const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const WebSocket=require('../server/node_modules/ws');
test('isolated HTTP, account, WebSocket and private-file smoke test',async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'psb-v431-test-'));
 fs.cpSync(root,tmp,{recursive:true,filter:p=>!['server/data','server/world','server/players.json','server/players_backup.json','data'].includes(path.relative(root,p).replaceAll('\\','/'))});
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,['server/server.js'],{cwd:tmp,env:{...process.env,PORT:String(port),OP_PASSWORD:'test-only-password',SAKURA_LOG_DIR:path.join(tmp,'no-frp')},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(ready,output);
  for(const uri of ['/','/js/game.js','/css/style.css','/op'])assert.equal((await fetch(base+uri)).status,200,uri);
  for(const uri of ['/server/server.js','/server/data/accounts.json','/server/world/latest.json','/package.json','/js/%2e%2e%2fserver/server.js'])assert.equal((await fetch(base+uri)).status,403,uri);
  assert.equal((await fetch(base+'/%E0%A4%A')).status,400);
  const post=async(uri,data)=>(await fetch(base+uri,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}));
  const credentials={accountId:'smoke_test',nickname:'Smoke',password:'test-pass-123'};
  const response=await post('/api/account/register',credentials);assert.equal(response.status,200);const account=await response.json();assert.ok(account.token);
  assert.equal((await post('/api/account/register',credentials)).status,409);
  assert.equal((await post('/api/account/login',{...credentials,password:'wrong'})).status,403);
  const welcome=await new Promise((resolve,reject)=>{
   const ws=new WebSocket(base.replace('http:','ws:'));const timer=setTimeout(()=>{ws.terminate();reject(Error('welcome timeout '+output));},5000);
   ws.on('open',()=>ws.send(JSON.stringify({type:'join',accountToken:account.token,nickname:'Forged',role:'developer'})));
   let welcome,stage=0;
   ws.on('message',raw=>{try{const msg=JSON.parse(raw);
    if(msg.type==='welcome'){
     welcome=msg;ws.send(JSON.stringify({type:'playerData',inventory:{94:2},inventorySlots:[94],hotbar:[94]}));
     ws.send(JSON.stringify({type:'equip_armor',itemId:94}));
    }else if(msg.type==='player_stats'&&msg.inventory){
     if(stage===0){assert.equal(msg.inventory[94],1);assert.equal(msg.equipment.armorItem,94);assert.ok(Number.isFinite(msg.xp));stage=1;ws.send(JSON.stringify({type:'unequip_armor'}));}
     else{assert.equal(msg.inventory[94],2);assert.equal(msg.equipment.armorItem,0);clearTimeout(timer);ws.close();resolve(welcome);}
    }
   }catch(err){clearTimeout(timer);ws.terminate();reject(err);}});ws.on('error',reject);
  });
  assert.equal(welcome.role,'player');assert.equal(welcome.mode,'survival');assert.ok(Number.isFinite(welcome.seed));
  const accounts=JSON.parse(fs.readFileSync(path.join(tmp,'server/data/accounts.json'),'utf8'));assert.ok(accounts.smoke_test.passwordHash);assert.equal(accounts.smoke_test.password,undefined);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
});
