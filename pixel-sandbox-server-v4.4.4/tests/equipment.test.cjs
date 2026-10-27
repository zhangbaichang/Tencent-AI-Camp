const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const data=fs.readFileSync(path.join(root,'js/data.js'),'utf8'),gameSource=fs.readFileSync(path.join(root,'js/game.js'),'utf8');
function context(){const c={};vm.createContext(c);vm.runInContext(data,c);c.BLOCKS=vm.runInContext('BLOCKS',c);c.RECIPES=vm.runInContext('RECIPES',c);return c;}
test('every existing tool family ends at diamond and recipes use real materials',()=>{
 const c=context();const blocks=c.BLOCKS,recipes=c.RECIPES;
 const families=new Set(Object.values(blocks).filter(b=>b.toolTier).map(b=>b.tool));
 for(const family of families){const items=Object.values(blocks).filter(b=>b.tool===family);assert.equal(Math.max(...items.map(b=>b.toolTier)),4);assert.ok(items.find(b=>b.toolTier===4).name.startsWith('钻石'));}
 for(const id of [82,83,94,95,96]){assert.ok(blocks[id].item);const recipe=recipes.find(r=>r.output[id]);assert.ok(recipe);assert.equal(recipe.needs,'workbench');for(const material of Object.keys(recipe.input))assert.ok(blocks[material]);}
 assert.ok(blocks[83].damage>blocks[81].damage);assert.ok(blocks[83].durability>blocks[81].durability);
});
test('new items craft through the real crafting function and reject missing resources',()=>{
 const c=context();c.game={inventory:{},discoveredElements:new Set()};c.hasCraftingStation=()=>true;c.showToast=c.sfx=c.updateHotbar=()=>{};
 c.removeItem=(id,n)=>{c.game.inventory[id]-=n;};c.addItem=(id,n)=>{c.game.inventory[id]=(c.game.inventory[id]||0)+n;};
 vm.runInContext(gameSource.slice(gameSource.indexOf('function craftRecipe('),gameSource.indexOf('// ==================== 固定背包槽位')),c);
 for(const id of [82,83,94,95,96]){const recipe=c.RECIPES.find(r=>r.output[id]);c.game.inventory={};c.craftRecipe(recipe);assert.equal(c.game.inventory[id],undefined);c.game.inventory={...recipe.input};c.craftRecipe(recipe);assert.equal(c.game.inventory[id],1);for(const material of Object.keys(recipe.input))assert.equal(c.game.inventory[material],0);}
});
test('all armor types equip and replace with matching server protection',()=>{
 const c=context(),server=fs.readFileSync(path.join(root,'server/server.js'),'utf8');
 c.savePlayers=c.syncStats=()=>{};
 vm.runInContext(server.match(/const ARMOR_VALUES=\{[^}]+\};/)[0]+'\n'+server.match(/function equipArmor\(p,id\)\{[^\n]+/)[0],c);
 const p={inventory:{94:1,95:1,96:1},equipment:{}};
 for(const id of [94,95,96]){assert.equal(c.equipArmor(p,id),true);assert.equal(p.equipment.armorItem,id);assert.equal(p.armor,c.BLOCKS[id].armor);assert.equal(p.inventory[id],undefined);}
 assert.equal(p.inventory[94],1);assert.equal(p.inventory[95],1);assert.equal(c.equipArmor(p,82),false);
});

test('armor can be unequipped when survival inventory already has 36 kinds',()=>{
 const c=context(),server=fs.readFileSync(path.join(root,'server/server.js'),'utf8');c.savePlayers=c.syncStats=()=>{};
 vm.runInContext(server.slice(server.indexOf('function unequipArmor('),server.indexOf('function equipArmor(')),c);
 const p={mode:'survival',inventory:Object.fromEntries(Array.from({length:36},(_,i)=>[i+1,1])),equipment:{armorItem:96},armor:20};
 assert.equal(c.unequipArmor(p),true);assert.equal(p.inventory[96],1);assert.equal(p.equipment.armorItem,0);assert.equal(p.armor,0);
});
