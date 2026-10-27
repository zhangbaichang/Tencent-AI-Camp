// Pixel Sandbox V4.1.13 admin control helper
// Client only builds requests; server must validate permissions.

function adminRequest(action, data={}){
 return fetch('/api/admin/'+action,{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify(data)
 }).then(r=>r.json());
}

function setRole(playerId,role){
 return adminRequest('role',{id:playerId,role});
}

function kickPlayer(playerId){
 return adminRequest('kick',{id:playerId});
}

function banPlayer(playerId){
 return adminRequest('ban',{id:playerId});
}
