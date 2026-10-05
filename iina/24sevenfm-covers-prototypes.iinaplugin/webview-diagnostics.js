(function () {
  if (!window.webkit || !webkit.messageHandlers || !webkit.messageHandlers.iina) return;
  function post(name,data) { webkit.messageHandlers.iina.postMessage([name,JSON.stringify(data)]); }
  post('covers-boot', { bridge:!!window.iina, href:location.href });
  window.addEventListener('error',function (event) { post('covers-error',{message:event.message,file:event.filename,line:event.lineno}); });
  window.addEventListener('unhandledrejection',function (event) { post('covers-error',{message:String(event.reason)}); });
})();
