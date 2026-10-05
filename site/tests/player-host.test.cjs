const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function fixture(bridge,search='') {
  const context={location:{search},document:{documentElement:{dataset:{}}},URLSearchParams};let receive;const sent=[];
  if(bridge)context.iina={postMessage:(...args)=>sent.push(args),onMessage:(name,fn)=>{receive=fn;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../js/player-host.js'),'utf8'),context);
  return {context,host:context.PlayerHost.create(context),sent,receive:state=>receive(state)};
}
test('a top-level IINA WebView automatically owns playback externally',()=>{
  const f=fixture(true);assert.equal(f.host.hosted,true);assert.equal(f.host.allowAudio(),false);assert.equal(f.host.running,false);
  f.receive({station:'death',activity:'play',mode:'overlay'});assert.equal(f.host.running,true);
  f.receive({station:'death',activity:'pause',mode:'overlay'});assert.equal(f.host.running,false);assert.equal(f.host.allowAudio(),false);
  f.receive({station:'death',activity:'play',mode:'hidden'});assert.equal(f.host.running,false);
});
test('unhosted browser playback remains available and explicit embed is silent without a bridge',()=>{
  assert.equal(fixture(false).host.allowAudio(),true);assert.equal(fixture(false).host.running,true);
  const f=fixture(false,'?embed=iina');assert.equal(f.host.allowAudio(),false);assert.equal(f.host.running,false);
});
test('invalid host state cannot select arbitrary sources or invoke audio',()=>{
  const f=fixture(true);f.receive({station:'evil',activity:'play',mode:'overlay'});assert.equal(f.host.running,false);assert.equal(f.host.state.activity,'stop');
  f.receive({station:'sst',activity:'execute',mode:'overlay'});assert.equal(f.host.state.station,'');
});
