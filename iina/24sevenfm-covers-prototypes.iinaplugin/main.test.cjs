const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function fixture(){
 const callbacks={},messages=[],menus=[],handlers={},calls=[];let overlayReady=false;const props={path:'https://hi5.death.fm/',pause:false,'media-title':'Title'};
 const view=name=>({loadFile:file=>{calls.push([name,'load',file]);for(const key of Object.keys(handlers))if(key.startsWith(name+':'))delete handlers[key];},onMessage:(event,fn)=>{if(name!=='overlay'||overlayReady)handlers[name+':'+event]=fn;},postMessage:(event,data)=>messages.push({name,event,data}),show:()=>calls.push([name,'show']),hide:()=>calls.push([name,'hide']),setClickable:()=>{}});
 const iina={sidebar:view('sidebar'),overlay:view('overlay'),mpv:{getString:k=>props[k],getFlag:k=>props[k]},event:{on:(name,fn)=>{callbacks[name]=fn;}},menu:{item:(name,fn)=>({name,fn}),addItem:item=>menus.push(item)},file:{write:()=>{}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),{iina,setTimeout:()=>1,clearTimeout:()=>{}});return{callbacks,messages,menus,handlers,calls,props,finishOverlay:()=>{overlayReady=true;callbacks['iina.plugin-overlay-loaded']();}};
}
test('both views reuse the web player and only the selected view follows playback',()=>{
 const f=fixture();assert.equal(f.calls.filter(c=>c[1]==='load').length,0);f.callbacks['iina.window-loaded']();assert.equal(f.calls.filter(c=>c[1]==='load').length,2);f.menus[0].fn();
 assert.equal(f.messages.at(-2).data.mode,'sidebar');assert.equal(f.messages.at(-1).data.mode,'hidden');
 f.menus[1].fn();assert.equal(f.messages.at(-1).data.mode,'overlay');assert.equal(f.messages.at(-1).data.station,'death');
 f.props.pause=true;f.callbacks['mpv.pause.changed']();assert.equal(f.messages.at(-1).data.activity,'pause');
 f.callbacks['mpv.end-file']();assert.equal(f.messages.at(-1).data.activity,'stop');
});
test('late WebView readiness gets the current station and unrelated media is not classified',()=>{
 const f=fixture();f.callbacks['iina.window-loaded']();assert.equal(f.handlers['overlay:covers-ready'],undefined);f.menus[1].fn();f.finishOverlay();f.handlers['overlay:covers-ready']();assert.equal(f.messages.at(-1).data.station,'death');
 for(const url of ['https://death.fm.evil.org/live','https://death.fm@evil.org/live','/tmp/death.fm.wav']){f.props.path=url;f.callbacks['mpv.file-loaded']();assert.equal(f.messages.at(-1).data.station,'');}
 f.props.path='https://1980s.fm/live';f.callbacks['mpv.file-loaded']();assert.equal(f.messages.at(-1).data.station,'1980s');
});
