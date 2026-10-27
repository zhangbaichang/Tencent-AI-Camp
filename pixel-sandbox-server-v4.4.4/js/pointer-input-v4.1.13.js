// Pixel Sandbox V4.1.13 pointer input helper
// Use Pointer Events to avoid duplicate mouse/touch firing on hybrid devices.
window.PixelPointer = {
  bind(el, type, handler, opts={}) {
    if(!el) return;
    el.addEventListener('pointer'+type, e=>{
      if(e.pointerType==='touch') e.preventDefault();
      handler(e);
    }, Object.assign({passive:false}, opts));
  }
};
