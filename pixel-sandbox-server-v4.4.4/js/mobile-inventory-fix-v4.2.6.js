
/* Pixel Sandbox V4.2.6 mobile inventory input isolation */
(function(){
'use strict';
const state={inventory:false,drag:false,scrollY:0,startY:0};

function lockGame(lock){
 document.body.classList.toggle('inventory-touch-lock',!!lock);
 const canvas=document.querySelector('canvas');
 if(canvas) canvas.style.pointerEvents=lock?'none':'auto';
}
function findInventory(){
 return document.querySelector('#inventory-overlay,.inventory,.inventory-panel,#inventory');
}
window.PixelMobileInventoryFix={
 open(){
  state.inventory=true; lockGame(true);
 },
 close(){
  state.inventory=false; state.drag=false; lockGame(false);
 }
};

document.addEventListener('DOMContentLoaded',()=>{
 const inv=findInventory();
 if(!inv)return;
 inv.style.touchAction='none';
 inv.style.overscrollBehavior='contain';

 inv.addEventListener('touchstart',e=>{
   state.startY=e.touches[0].clientY;
   state.drag=false;
   e.stopPropagation();
 },{passive:false});

 inv.addEventListener('touchmove',e=>{
   e.stopPropagation();
   if(state.inventory) e.preventDefault();
 },{passive:false});

 inv.addEventListener('touchend',e=>{
   e.stopPropagation();
 },{passive:false});
});
window.addEventListener('pointercancel',()=>{
 state.drag=false;
});
})();
