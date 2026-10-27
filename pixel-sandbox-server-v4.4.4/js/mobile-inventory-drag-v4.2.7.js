// Pixel Sandbox V4.2.7 mobile inventory drag rewrite
(function(){
 const state={active:false,source:null,preview:null,startX:0,startY:0,moved:false};
 function getInv(){return document.getElementById('inventory-overlay')||document.querySelector('.inventory');}
 function preview(x,y,html){
  if(!state.preview){state.preview=document.createElement('div');state.preview.className='inventory-drag-preview';document.body.appendChild(state.preview);}
  state.preview.innerHTML=html||'';state.preview.style.left=x+'px';state.preview.style.top=y+'px';
 }
 function clear(){if(state.preview)state.preview.remove();state.preview=null;state.active=false;state.source=null;}
 window.mobileInventoryDrag={
  begin(slot,ev){
   state.source=slot;state.startX=ev.clientX;state.startY=ev.clientY;state.moved=false;
   setTimeout(()=>{if(state.source!==null){state.active=true;preview(ev.clientX,ev.clientY,'');}},150);
  },
  move(ev){
   if(!state.active)return;
   state.moved=true;preview(ev.clientX,ev.clientY,'');
   ev.preventDefault();
  },
  end(ev){
   if(state.active){/* slot drop handler can read source here */}
   clear();
  },
  cancel(){clear();}
 };
 document.addEventListener('pointercancel',clear);
})();
