'use strict';
const fs=require('fs'),crypto=require('crypto');
class WorldInteractions {
 constructor({file,tileAt,isSolid=()=>false,width=600,height=300,now=Date.now}){
  this.file=file;this.tileAt=tileAt;this.width=width;this.height=height;this.now=now;
  this.isSolid=(tx,ty)=>tx<0||ty<0||tx>=width||ty>=height||isSolid(tx,ty);this.accumulator=0;
  this.leases=new Map();this.drops=new Map();this.failures=new Map();this.events=[];
  try{const p=JSON.parse(fs.readFileSync(file,'utf8'));this.chests=(p&&typeof p==='object'&&!Array.isArray(p))?p:{};}catch{this.chests={};}
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.chests));fs.renameSync(tmp,this.file);}
 reload(){try{const p=JSON.parse(fs.readFileSync(this.file,'utf8'));this.chests=(p&&typeof p==='object'&&!Array.isArray(p))?p:{};}catch{this.chests={};}this.leases.clear();}
 error(message){throw new Error(message);}
 key(index){if(!Number.isInteger(index)||index<0||index>=this.width*this.height)this.error('箱子坐标无效');return String(index);}
 nearby(p,index){const x=(index%this.width)*24+12,y=Math.floor(index/this.width)*24+12;if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.hypot(p.x+9-x,p.y+18-y)>180)this.error('请靠近箱子');}
 record(index,owner){const key=this.key(index);if(!this.chests[key]){this.chests[key]={owner,slots:Array(27).fill(null)};this.save();}return this.chests[key];}
 register(index,owner){if(owner)this.record(index,owner);}
 protected(index){return !!this.chests[String(index)];}
 clean(){const now=this.now();for(const [k,v] of this.leases)if(v.until<=now)this.leases.delete(k);for(const [k,v] of this.drops)if(v.expires<=now){this.drops.delete(k);if(v.isBomb)this.events.push({id:v.id,x:v.x,y:v.y});}for(const [k,v] of this.failures)if(v.until<=now)this.failures.delete(k);}
 release(account){for(const [k,v] of this.leases)if(v.account===account)this.leases.delete(k);}
 tick(seconds){
  this.accumulator+=Math.min(.25,Math.max(0,seconds));
  while(this.accumulator>=1/60){
   this.accumulator-=1/60;
   for(const d of this.drops.values()){
    d.vy=Math.min(14,(d.vy||0)+.45);
    d.x+=d.vx||0;
    if(d.vx){
     const edge=Math.floor((d.x+(d.vx>0?7.999:0))/24);
     for(let ty=Math.floor(d.y/24);ty<=Math.floor((d.y+7.999)/24);ty++)if(this.isSolid(edge,ty)){
      d.x=d.vx>0?edge*24-8:(edge+1)*24;d.vx=0;break;
     }
    }
    d.y+=d.vy;
    const edge=Math.floor((d.y+(d.vy>0?7.999:0))/24);
    d.grounded=false;
    for(let tx=Math.floor(d.x/24);tx<=Math.floor((d.x+7.999)/24);tx++)if(this.isSolid(tx,edge)){
     if(d.vy>0){d.y=edge*24-8;d.grounded=true;d.vx*=.78;if(Math.abs(d.vx)<.03)d.vx=0;}
     else d.y=(edge+1)*24;
     d.vy=0;break;
    }
    d.x=Math.max(0,Math.min(this.width*24-8,d.x));d.y=Math.max(0,Math.min(this.height*24-8,d.y));
   }
  }
  this.clean();
 }
 slots(value){if(!Array.isArray(value)||value.length!==27)this.error('箱子数据无效');return value.map(v=>{if(v===null)return null;if(!v||!Number.isSafeInteger(v.id)||v.id<=0||v.id>255||!Number.isSafeInteger(v.count)||v.count<=0||v.count>1000000000)this.error('物品数量无效');return{id:v.id,count:v.count};});}
 handle(account,p,msg){
  this.clean();const a=msg.action;
  if(!account||!p)this.error('请先登录游戏');
  if(a==='inventory_snapshot')return{inventory:p.inventory||{}};
  if(a==='drops')return{drops:[...this.drops.values()]};
  if(a==='drop'){
   const id=Number(msg.id),count=Number(msg.count);
   if(!Number.isInteger(id)||id<=0||id>255||!Number.isSafeInteger(count)||count<1||count>1000000000||(p.inventory?.[id]||0)<count)this.error('物品数量不足');
   if(this.drops.size>=400)this.error('地面物品过多，请先拾取');
   if(!Number.isFinite(p.x)||!Number.isFinite(p.y))this.error('位置无效');
   const facing=Number(msg.facing)<0?-1:1;
   const x=Math.max(0,Math.min(this.width*24-8,p.x+5)),y=Math.max(0,Math.min(this.height*24-8,p.y+14));
   p.inventory[id]-=count;if(p.inventory[id]===0)delete p.inventory[id];
   const isBomb=id===52||id===78;
   const drop={sharedId:crypto.randomUUID(),id,count,x,y,vx:facing*4,vy:-4,grounded:false,isBomb,expires:this.now()+(isBomb?800:60000),owner:account,pickupAfter:this.now()+800};
   this.drops.set(drop.sharedId,drop);return{drop};
  }
  if(a==='pickup'){
   const d=this.drops.get(msg.sharedId);if(!d)this.error('物品已被拾取或消失');
   if(d.isBomb)this.error('已点燃的投掷物不能拾取');
   if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.hypot(p.x+9-d.x,p.y+18-d.y)>48)this.error('距离物品太远');
   if(d.owner===account&&this.now()<d.pickupAfter)this.error('物品刚刚丢出');
   this.drops.delete(d.sharedId);p.inventory=p.inventory||{};p.inventory[d.id]=(p.inventory[d.id]||0)+d.count;return{item:{id:d.id,count:d.count},sharedId:d.sharedId};
  }
  const key=this.key(msg.index);this.nearby(p,msg.index);
  if(this.tileAt(msg.index)!==27)this.error('这里没有箱子');
  const chest=this.record(msg.index,account);
  if(a==='chest_open'){
   const existing=this.leases.get(key);if(existing&&existing.account!==account)this.error('另一位玩家正在使用箱子');
   if(chest.hash){
    const fk=account+':'+key,f=this.failures.get(fk);
    if(f&&f.count>=5)this.error('密码错误次数过多，请一分钟后重试');
    if(typeof msg.password!=='string'||msg.password.length>128)this.error('需要箱子密码');
    const digest=crypto.scryptSync(msg.password,chest.salt,32);
    if(!crypto.timingSafeEqual(digest,Buffer.from(chest.hash,'hex'))){this.failures.set(fk,{count:(f?.count||0)+1,until:this.now()+60000});this.error('密码错误');}
    this.failures.delete(fk);
   }
   const token=crypto.randomBytes(24).toString('hex');this.leases.set(key,{account,token,until:this.now()+90000});
   return{slots:chest.slots,token,locked:!!chest.hash,canManage:chest.owner===account};
  }
  const lease=this.leases.get(key);if(!lease||lease.account!==account||lease.token!==msg.token)this.error('箱子已锁定，请重新打开');
  if(a==='chest_renew'){lease.until=this.now()+90000;return{};}
  if(a==='chest_remove'){
   if(chest.owner!==account)this.error('只有箱子所有者可以拆除');
   if(chest.slots.some(Boolean))this.error('请先取空箱子');
   delete this.chests[key];this.leases.delete(key);this.save();return{removed:true};
  }
  if(a==='chest_save'||a==='chest_close'){
   chest.slots=this.slots(msg.slots);this.save();
   if(a==='chest_close')this.leases.delete(key);else lease.until=this.now()+90000;
   return{};
  }
  if(a==='chest_password'){
   if(chest.owner!==account)this.error('只有箱子所有者可以修改密码');
   if(typeof msg.password!=='string'||msg.password.length>128||(msg.password.length>0&&msg.password.length<4))this.error('密码需为4至128个字符');
   if(msg.password){chest.salt=crypto.randomBytes(16).toString('hex');chest.hash=crypto.scryptSync(msg.password,chest.salt,32).toString('hex');}
   else{delete chest.salt;delete chest.hash;}
   this.save();this.leases.delete(key);return{locked:!!chest.hash};
  }
  this.error('未知操作');
 }
}
module.exports={WorldInteractions};
