// One instance per IINA player window. All calls use literal argv, never a shell.
const session = 'iina-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let sequence = 0, tuned = false, currentURL = '', queue = Promise.resolve();
function isStation(url) {
  const match = /^https?:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#]|$)/i.exec(url || '');
  if (!match || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return false;
  const host = match[1].toLowerCase();
  return ['streamingsoundtracks.com','1980s.fm','adagio.fm','death.fm','entranced.fm'].some(h=>host===h || host.endsWith('.'+h));
}
function send(activity, url, title) {
  const args = ['--player-event','iina',session,String(++sequence),activity,url || '',title || ''];
  queue = queue.then(()=>{
    const candidates = ['~/Applications/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers','/Applications/24seven.fm Covers.app/Contents/MacOS/24sevenfm_covers'];
    const binary = candidates.map(p=>iina.utils.resolvePath(p)).find(p=>iina.utils.fileInPath(p));
    if (!binary) throw new Error('Install 24seven.fm Covers in Applications first.');
    return iina.utils.exec(binary,args).then(result=>{if(result.status!==0) throw new Error(result.stderr || 'Viewer bridge failed: '+result.status);});
  }).catch(error=>iina.console.error(String(error)));
}
function title() { return iina.mpv.getString('media-title') || ''; }
iina.event.on('mpv.file-loaded',()=>{
  const url = iina.mpv.getString('path') || '';
  if (isStation(url)) {tuned=true;currentURL=url;send('start',url,title());if(iina.mpv.getFlag('pause')) send('pause',url,title());}
  else if(tuned) {tuned=false;send('stop',currentURL,'');currentURL='';}
});
iina.event.on('mpv.metadata.changed',()=>{if(tuned) send('update',currentURL,title());});
iina.event.on('mpv.pause.changed',()=>{if(tuned) send(iina.mpv.getFlag('pause')?'pause':'start',currentURL,title());});
iina.event.on('mpv.end-file',()=>{if(tuned){tuned=false;send('stop',currentURL,'');currentURL='';}});
iina.event.on('iina.player-shutdown',()=>{if(tuned){tuned=false;send('stop',currentURL,'');}});
