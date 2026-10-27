'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
// Reuse the exact client generator and block definitions, then overlay saved edits.
function createDropTerrain(seed,edits,width=600,height=300){
 const context={};context.window=context;vm.createContext(context);
 for(const name of ['data.js','world.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../js',name),'utf8'),context,{filename:name});
 const {world}=context.WorldGen.generateWorld(width,height,seed),blocks=context.BLOCKS;
 return (tx,ty)=>{
  if(tx<0||ty<0||tx>=width||ty>=height)return true;
  const index=ty*width+tx,id=edits.has(index)?edits.get(index):world[index];
  return !!blocks[id]?.solid;
 };
}
module.exports={createDropTerrain};
