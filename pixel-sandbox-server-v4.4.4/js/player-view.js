(function(root){
  'use strict';
  const api={
    coordinates(x,y,width=18,height=36){
      if(!Number.isFinite(Number(x))||!Number.isFinite(Number(y)))return null;
      return {x:Math.floor((Number(x)+width/2)/24),y:Math.floor((Number(y)+height)/24)};
    },
    facing(value,fallback=1){const n=Number(value);return Number.isFinite(n)&&n!==0?(n<0?-1:1):(Number(fallback)<0?-1:1);},
    horizontal(keys,touch){
      const left=!!(keys.KeyA||keys.ArrowLeft),right=!!(keys.KeyD||keys.ArrowRight);
      if(left||right)return Number(right)-Number(left);
      const value=Number(touch);return Number.isFinite(value)&&Math.abs(value)>=.1?Math.max(-1,Math.min(1,value)):0;
    },
    drawBody(ctx,p,x,y,color,walk=0,armOffset=0){
      const w=p.w||18,h=p.h||36;
      ctx.save();ctx.translate(x+(api.facing(p.facing)<0?w:0),y);ctx.scale(api.facing(p.facing),1);
      ctx.fillStyle=color;ctx.fillRect(2,10+walk,w-4,h-14);
      ctx.fillStyle='#e8b888';ctx.fillRect(3,0,w-6,12);ctx.fillRect(w-4,6,3,3);
      ctx.fillStyle='#3a2a1a';ctx.fillRect(3,0,w-6,4);ctx.fillRect(3,3,3,5);
      ctx.fillStyle='#222';ctx.fillRect(w-7,5,2,3);
      ctx.fillStyle='#e8b888';ctx.fillRect(w-4,12+walk+armOffset,4,10);
      ctx.fillStyle='#2a4a8a';ctx.fillRect(2,h-6+walk,6,6);ctx.fillRect(w-8,h-6-walk,6,6);
      ctx.restore();
    }
  };
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PlayerView=api;
})(typeof globalThis==='object'?globalThis:this);
