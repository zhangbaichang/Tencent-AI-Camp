// [V3.7] 本模块已正式合并进 server.js（核心合并版），此文件仅保留作设计参考，不再被引用。
// V3.4 Role Manager
// player / admin / developer

function getPrefix(role){
    if(role === "developer") return "[开发者]";
    if(role === "admin") return "[管理员]";
    return "";
}

function applyRole(player, role){
    player.role = role || "player";

    if(player.role === "developer"){
        player.mode = "creative";
        player.canFly = true;
        player.infiniteItems = true;
    }

    return player;
}

module.exports={getPrefix,applyRole};