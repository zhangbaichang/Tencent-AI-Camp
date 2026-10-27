// [V3.7] 本模块已正式合并进 server.js（核心合并版），此文件仅保留作设计参考，不再被引用。
// V3.2 Online player list sync
function buildOnlineList(players){
    return {
        type:"player_list_update",
        count:players.length,
        players:players.slice(0,5).map(p=>({
            id:p.id,
            name:p.name || "Unknown"
        }))
    };
}
module.exports={buildOnlineList};