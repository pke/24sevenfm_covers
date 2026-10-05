const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture() {
  const callbacks = {}, calls = [];
  const props = {path:'https://hi5.death.fm/', pause:false, 'media-title':'Composer — Cue'};
  const iina = {event:{on:(name,fn)=>{callbacks[name]=fn;}}, mpv:{getString:k=>props[k],getFlag:k=>props[k]},
    utils:{resolvePath:p=>p.replace('~','/Users/test'),fileInPath:()=>true,exec:async (file,args)=>{calls.push({file,args});return {status:0};}}, console:{error:()=>{}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'main.js'),'utf8'), {iina,Date,Math,Promise,encodeURIComponent});
  return {callbacks,calls,props,flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('IINA real entry maps file, metadata, pause and stop events to serialized native calls', async()=>{
  const f=fixture(); f.callbacks['mpv.file-loaded'](); await f.flush();
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].args[0],'--player-event'); assert.equal(f.calls[0].args[1],'iina'); assert.equal(f.calls[0].args[4],'start');
  f.callbacks['mpv.metadata.changed'](); f.props.pause=true; f.callbacks['mpv.pause.changed'](); f.callbacks['mpv.end-file'](); await f.flush();
  assert.deepEqual(f.calls.map(c=>c.args[4]),['start','update','pause','stop']);
  assert.deepEqual(f.calls.map(c=>Number(c.args[3])),[1,2,3,4]);
});
test('IINA does not launch viewer for local files, lookalike hosts or unrelated streams',async()=>{
  const f=fixture();
  for(const url of ['file:///tmp/death.fm.mp3','https://death.fm.evil.org/','https://evil.org/death.fm','https://death.fm@evil.org/','https://example.org/']) {f.props.path=url;f.callbacks['mpv.file-loaded']();}
  await f.flush(); assert.equal(f.calls.length,0);
});
test('IINA follows station switch and emits stop when switching away',async()=>{
  const f=fixture(); f.callbacks['mpv.file-loaded'](); f.props.path='https://hi1.1980s.fm/';f.callbacks['mpv.file-loaded']();
  f.props.path='/tmp/other.mp3';f.callbacks['mpv.file-loaded']();await f.flush();
  assert.deepEqual(f.calls.map(c=>c.args[4]),['start','start','stop']);
});
test('IINA passes hostile title as one literal argument and uses one session per window',async()=>{
  const f=fixture();f.props['media-title']='$(touch /tmp/bad) " & ☃';f.callbacks['mpv.file-loaded']();f.callbacks['mpv.metadata.changed']();await f.flush();
  assert.equal(f.calls[0].args[6],f.props['media-title']);assert.equal(f.calls[0].args[2],f.calls[1].args[2]);assert.equal(f.calls[0].file,'/Users/test/Applications/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers');
});
