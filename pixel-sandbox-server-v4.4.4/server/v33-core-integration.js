// [V3.7] 本模块已正式合并进 server.js（核心合并版），此文件仅保留作设计参考，不再被引用。
/*
 Pixel Sandbox V3.3 Core Integration

 Intended integration points:
 - player list websocket broadcast
 - kick check before connection
 - ban check before connection
 - player mode sync

 Keep existing server protocol and call these hooks from server.js.
*/

function createPlayerListPacket(players){
 return {
   type:"player_list_update",
   count:players.length,
   players:players.slice(0,5)
 };
}

function canJoin(playerId, banList, kickList){
 if(banList.includes(playerId)) return {ok:false,reason:"banned"};
 if(kickList[playerId] && Date.now()<kickList[playerId])
   return {ok:false,reason:"kicked"};
 return {ok:true};
}

module.exports={createPlayerListPacket,canJoin};