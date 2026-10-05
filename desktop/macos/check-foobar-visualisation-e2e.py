#!/usr/bin/env python3
"""Exercise the registered Mac visualisation inside the actual foobar2000 host."""
import importlib.util, json, os, pathlib, subprocess, time
spec=importlib.util.spec_from_file_location('players',pathlib.Path(__file__).with_name('check-player-e2e.py'))
players=importlib.util.module_from_spec(spec);spec.loader.exec_module(players)
OUTPUT=players.OUTPUT/'foobar-visualisation';OUTPUT.mkdir(parents=True,exist_ok=True)
for name in ['ready','result.json','visualisation.json','command.json']:
    (OUTPUT/name).unlink(missing_ok=True)
app=pathlib.Path.home()/'Applications/foobar2000.app'
if not app.exists():app=pathlib.Path('/Applications/foobar2000.app')
binary=app/'Contents/MacOS/foobar2000'
if subprocess.run(['pgrep','-x','foobar2000'],capture_output=True).returncode==0:
    raise RuntimeError('Quit foobar2000 before E2E testing')
player=subprocess.Popen([str(binary)],env=dict(os.environ,SSC_FOOBAR_TEST_DIR=str(OUTPUT)),stdout=open(OUTPUT/'host.log','w'),stderr=subprocess.STDOUT)
sequence=0
def state():return json.loads((OUTPUT/'visualisation.json').read_text())
def expected(**fields):
    def check():
        result=state()
        return result if all(result.get(k)==v for k,v in fields.items()) else None
    return check
def command(action,url=''):
    global sequence
    sequence+=1
    temp=OUTPUT/'command.tmp';temp.write_text(json.dumps(dict(sequence=sequence,action=action,url=url)));temp.replace(OUTPUT/'command.json')
    if action=='quit':return
    result=players.wait_for(lambda:json.loads((OUTPUT/'result.json').read_text()) if (OUTPUT/'result.json').exists() and json.loads((OUTPUT/'result.json').read_text()).get('sequence')==sequence else None,'SDK command not handled')
    assert not result.get('error'),result
try:
    players.wait_for(lambda:(OUTPUT/'ready').exists(),'SDK test driver not loaded')
    command('visual-open')
    players.wait_for(expected(views=1,station=-1,monitor=False),'visualisation menu failed to instantiate native view')
    command('visual-popup-close');command('visual-open');time.sleep(.7)
    assert state()['views']==1,'quick reopening was lost to the outgoing window fade'
    command('play','https://death.fm/live')
    players.wait_for(expected(views=1,station=3,monitor=True,paused=False),'playback did not reach the in-process view',45)
    players.wait_for(lambda:state().get('frames',0)>0 and state().get('cover',False),'no actual cover rendered in foobar',60)
    assert state()['pid']==player.pid,'visualisation rendering runs outside the foobar host'
    time.sleep(1.2);command('visual-capture')
    command('pause');players.wait_for(expected(paused=True,monitor=False,cover=True),'paused visualisation lost artwork')
    command('visual-layout');players.wait_for(expected(views=2,paused=True,monitor=False),'layout opened during pause did not retain paused state')
    command('resume');players.wait_for(expected(paused=False,monitor=True),'resume did not restart monitor')
    command('visual-resize');players.wait_for(expected(width=820,height=440),'embedded element did not resize')
    players.wait_for(lambda:state().get('frames',0)>0 and state().get('cover',False),'embedded view did not render live artwork',60)
    time.sleep(1.2);command('visual-capture')
    command('play','https://1980s.fm/live');players.wait_for(expected(station=1,monitor=True),'station switch failed',45)
    command('stop');players.wait_for(expected(station=-1,monitor=False,cover=False),'stop did not transition to idle')
    command('play','https://death.fm/live');players.wait_for(expected(station=3),'restart failed',45)
    command('play',str(players.LOCAL_AUDIO));players.wait_for(expected(station=-1,monitor=False),'local file kept station polling')
    command('visual-close');players.wait_for(expected(views=1),'closed embedded element still retained')
    command('quit');player.wait(timeout=10)
    print('PASS: real foobar menu and layout services, in-process live cover, pause/resume, resize, station switch, stop, local files and view disposal',flush=True)
finally:
    if player.poll() is None:command('quit')
    try:player.wait(timeout=10)
    except subprocess.TimeoutExpired:player.terminate();player.wait(timeout=10)
