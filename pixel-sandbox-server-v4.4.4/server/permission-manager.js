// [V3.7] 本模块已正式合并进 server.js（核心合并版），此文件仅保留作设计参考，不再被引用。
// Permission check layer

const permissions={
 player:[],
 admin:[
   "kick",
   "ban",
   "world_control"
 ],
 developer:[
   "kick",
   "ban",
   "world_control",
   "debug",
   "creative"
 ]
};

function hasPermission(role,action){
 return (permissions[role]||[]).includes(action);
}

module.exports={hasPermission};