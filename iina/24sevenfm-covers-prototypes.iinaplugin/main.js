// Independent comparison plugin. The existing native-viewer integration is preserved.
const { sidebar, overlay, mpv, event, menu } = iina;
let mode = 'hidden', activity = 'stop', hideTimer = null;
const stations = { 'streamingsoundtracks.com':'sst', '1980s.fm':'1980s', 'adagio.fm':'adagio', 'death.fm':'death', 'entranced.fm':'entranced' };
function stationFromPath(path) {
  const match = /^https?:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(path || '');
  if (!match) return '';
  const host = match[1].toLowerCase();
  for (const name of Object.keys(stations)) if (host === name || host.endsWith('.'+name)) return stations[name];
  return '';
}
function state(surface) {
  return { station: stationFromPath(mpv.getString('path')), activity,
    mode: mode === surface ? surface : 'hidden' };
}
function publish() { sidebar.postMessage('covers-playback',state('sidebar')); overlay.postMessage('covers-playback',state('overlay')); }
function choose(next) {
  clearTimeout(hideTimer);mode=next;
  if (next === 'sidebar') sidebar.show();
  if (next === 'overlay') { sidebar.hide();overlay.show(); }
  publish();
  // Outgoing pixels remain visible during the web player's opacity fade.
  if (next !== 'overlay') hideTimer=setTimeout(()=>overlay.hide(),400);
  if (next === 'hidden') hideTimer=setTimeout(()=>{sidebar.hide();overlay.hide();},400);
}
event.on('iina.window-loaded',()=>{
  sidebar.loadFile('webplayer/sidebar.html');overlay.loadFile('webplayer/overlay.html');
  // loadFile clears host listeners; register after navigation has been started.
  for (const [surface,view] of [['sidebar',sidebar],['overlay',overlay]]) {
  view.onMessage('covers-boot',data=>iina.file.write('@data/'+surface+'-boot.json',JSON.stringify(data)));
  view.onMessage('covers-error',data=>iina.file.write('@data/'+surface+'-error.json',JSON.stringify(data)));
  view.onMessage('covers-ready',()=>view.postMessage('covers-playback',state(surface)));
  view.onMessage('covers-status',data=>{
    iina.file.write('@data/'+surface+'-status.json',JSON.stringify(data));
  });
  }
});
// Overlay creation is asynchronous in IINA 1.5; early onMessage calls are ignored.
event.on('iina.plugin-overlay-loaded',()=>{
  overlay.setClickable(false);
  overlay.onMessage('covers-error',data=>iina.file.write('@data/overlay-error.json',JSON.stringify(data)));
  overlay.onMessage('covers-ready',()=>overlay.postMessage('covers-playback',state('overlay')));
  overlay.onMessage('covers-status',data=>iina.file.write('@data/overlay-status.json',JSON.stringify(data)));
  overlay.postMessage('covers-playback',state('overlay'));
});
menu.addItem(menu.item('Covers: Sidebar prototype',()=>choose('sidebar')));
menu.addItem(menu.item('Covers: Player overlay prototype',()=>choose('overlay')));
menu.addItem(menu.item('Covers: Hide prototypes',()=>choose('hidden')));
event.on('mpv.file-loaded',()=>{activity=mpv.getFlag('pause')?'pause':'play';publish();});
event.on('mpv.metadata.changed',publish);
event.on('mpv.pause.changed',()=>{activity=mpv.getFlag('pause')?'pause':'play';publish();});
event.on('mpv.end-file',()=>{activity='stop';publish();});
event.on('iina.player-shutdown',()=>{clearTimeout(hideTimer);activity='stop';publish();});
activity=mpv.getFlag('pause')?'pause':'play';
