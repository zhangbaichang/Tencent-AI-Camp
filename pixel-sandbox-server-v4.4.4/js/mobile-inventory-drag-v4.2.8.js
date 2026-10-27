// Pixel Sandbox V4.2.8 real item drag preview
(function(){
'use strict';
const drag={active:false,source:null,item:null,preview:null};
function getPreview(){
 if(drag.preview)return drag.preview;
 const el=document.createElement('div');
 el.className='inventory-drag-preview';
 el.style.cssText='position:fixed;pointer-events:none;z-index:99999;transform:translate(-50%,-50%) scale(1.15);opacity:.78;display:none;';
 document.body.appendChild(el);
 return drag.preview=el;
}
function render(item){
 const el=getPreview(); el.innerHTML='';
 if(item&&item.icon){
  const img=document.createElement('img'); img.src=item.icon; img.width=48; img.height=48; img.draggable=false; el.appendChild(img);
 }else if(item){el.textContent=item.name||item.id||'';}
 if(item&&item.count>1){const s=document.createElement('span');s.textContent=item.count;s.style.cssText='position:absolute;right:2px;bottom:0;font-weight:bold';el.appendChild(s);}
}
window.PixelInventoryDragV428={
 start(slot,item,x,y){drag.active=true;drag.source=slot;drag.item=item;render(item);drag.preview.style.display='block';this.move(x,y);},
 move(x,y){if(drag.active){drag.preview.style.left=x+'px';drag.preview.style.top=y+'px';}},
 end(){if(drag.preview)drag.preview.style.display='none';drag.active=false;drag.source=null;drag.item=null;}
};
window.addEventListener('pointercancel',()=>window.PixelInventoryDragV428.end());
})();
