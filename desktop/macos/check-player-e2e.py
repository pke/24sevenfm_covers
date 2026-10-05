#!/usr/bin/env python3
"""Real LaunchServices -> AppKit -> HTTPS feed -> rendered-frame tests.

The viewer uses an isolated preference suite and writes status only for this run.
No Accessibility, input injection or desktop/window automation is used.
"""
import json, os, pathlib, signal, socket, subprocess, sys, time, wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = pathlib.Path.home() / "Applications/24seven.fm Covers.app"
BINARY = APP / "Contents/MacOS/24sevenfm_covers"
OUTPUT = ROOT / "desktop/build/player-e2e"
OUTPUT.mkdir(parents=True, exist_ok=True)
LOCAL_AUDIO=OUTPUT/'unrelated.wav'
with wave.open(str(LOCAL_AUDIO),'wb') as audio:
    audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(8000);audio.writeframes(bytes(8000*2*30))

def wait_for(check, message, timeout=30):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            result=check()
            if result:return result
        except (FileNotFoundError,json.JSONDecodeError,ConnectionRefusedError):pass
        time.sleep(.1)
    raise AssertionError(message)

def status():
    return json.loads((OUTPUT/'status.json').read_text())

def expected(**fields):
    def check():
        state=status()
        return state if all(state.get(k)==v for k,v in fields.items()) else None
    return check

def bridge(player, session, seq, activity, url='', title=''):
    subprocess.run([str(BINARY),'--player-event',player,session,str(seq),activity,url,title],check=True)

def ipc(path, command):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(5);client.connect(str(path))
        client.sendall((json.dumps({'command':command,'request_id':23})+'\n').encode())
        data=b''
        while True:
            data+=client.recv(65536)
            while b'\n' in data:
                line,data=data.split(b'\n',1)
                result=json.loads(line)
                if result.get('request_id')==23:
                    assert result.get('error')=='success',result
                    return result

def run_bridge():
    bridge('iina','bridge-window',1,'start','https://death.fm/live','Literal Café & "$(false)"')
    wait_for(expected(station=3,player='iina',visible=True,monitor=True),'station did not follow bridge')
    wait_for(lambda:status().get('frames',0)>0,'no live frame rendered',60)
    bridge('iina','bridge-window',2,'pause','https://death.fm/live')
    wait_for(expected(paused=True,monitor=False,visible=True),'pause did not retain visible artwork')
    bridge('iina','bridge-window',1,'stop')
    assert status()['paused'],'stale stop changed owner'
    bridge('foobar2000','unrelated',1,'stop')
    assert status()['station']==3,'foreign stop interrupted playback'
    bridge('iina','bridge-window',3,'start','https://1980s.fm/live')
    wait_for(expected(station=1,paused=False,monitor=True),'station switch failed')
    bridge('iina','bridge-window',4,'stop')
    wait_for(expected(station=-1,monitor=False,visible=False),'stop did not fade and hide')
    result=subprocess.run([str(BINARY),'--player-event','iina','bad', '0','start','https://death.fm/live',''],capture_output=True)
    assert result.returncode!=0,'malformed event accepted'
    print('PASS: native bridge, literal metadata, live rendered artwork, pause/resume, switch, stale/foreign events and faded stop',flush=True)

def run_iina():
    app=pathlib.Path.home()/'Applications/IINA.app'
    if not app.exists():app=pathlib.Path('/Applications/IINA.app')
    sock=pathlib.Path('/tmp')/('ssc-iina-e2e-'+str(os.getpid())+'.sock')
    player=subprocess.Popen([str(app/'Contents/MacOS/IINA'),'--mpv-mute=yes','--mpv-input-ipc-server='+str(sock),'https://death.fm/live'],stdout=open(OUTPUT/'iina.log','w'),stderr=subprocess.STDOUT)
    try:
        wait_for(lambda:sock.exists(),'IINA IPC socket missing')
        wait_for(expected(player='iina',station=3,monitor=True,visible=True),'actual IINA plugin did not follow stream',45)
        wait_for(lambda:status().get('frames',0)>0,'IINA did not render artwork',60)
        ipc(sock,['set_property','pause',True]);wait_for(expected(paused=True,monitor=False),'IINA pause not forwarded')
        ipc(sock,['set_property','pause',False]);wait_for(expected(paused=False,monitor=True),'IINA resume not forwarded')
        ipc(sock,['loadfile','https://1980s.fm/live']);wait_for(expected(station=1,player='iina'),'IINA switch not forwarded',45)
        ipc(sock,['stop']);wait_for(expected(station=-1,visible=False,monitor=False),'IINA stop not forwarded')
        ipc(sock,['loadfile','https://death.fm/live']);wait_for(expected(station=3,player='iina'),'IINA could not restart',45)
        ipc(sock,['loadfile',str(LOCAL_AUDIO)]);wait_for(expected(station=-1,visible=False,monitor=False),'IINA local audio kept station polling')
        ipc(sock,['loadfile','https://death.fm/live']);wait_for(expected(station=3,player='iina'),'IINA could not restart after local audio',45)
        player.terminate();player.wait(timeout=10)
        wait_for(expected(station=-1,visible=False,monitor=False),'viewer kept polling after IINA process exited')
        print('PASS: actual IINA -> plugin -> viewer -> artwork, pause, resume, switch, stop, local audio and process exit',flush=True)
    finally:
        if player.poll() is None:player.terminate()
        try:player.wait(timeout=10)
        except subprocess.TimeoutExpired:player.kill();player.wait()
        if sock.exists():sock.unlink()

def run_foobar():
    subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name('check-foobar-visualisation-e2e.py'))],check=True)

if __name__=='__main__':
    # A cold start must reach the same handler without opening the saved standalone station.
    if '--cold' in sys.argv:
        if (OUTPUT/'status.json').exists():(OUTPUT/'status.json').unlink()
        result=subprocess.run([str(BINARY),'--player-event','iina','cold-start','1','start','https://death.fm/live',''],env=dict(os.environ,SSC_PLAYER_TEST_DIR=str(OUTPUT)),check=True)
        state=wait_for(expected(player='iina',station=3,monitor=True),'cold-launch event lost',30)
        wait_for(lambda:status().get('frames',0)>0,'cold-start cover missing',60)
        bridge('iina','cold-start',2,'stop');wait_for(expected(station=-1,visible=False),'cold-start stop failed')
        os.kill(state['pid'],signal.SIGTERM)
        wait_for(lambda:subprocess.run(['pgrep','-f','^'+str(BINARY)+'$'],capture_output=True).returncode!=0,'cold-start viewer did not exit')
        print('PASS: cold player event launches the installed viewer and renders live artwork',flush=True)
    if (OUTPUT/'status.json').exists():(OUTPUT/'status.json').unlink()
    viewer=subprocess.Popen([str(BINARY),'--follow-player'],env=dict(os.environ,SSC_PLAYER_TEST_DIR=str(OUTPUT)),stdout=open(OUTPUT/'viewer.log','w'),stderr=subprocess.STDOUT)
    try:
        wait_for(lambda:(OUTPUT/'status.json').exists(),'test viewer did not initialize')
        run_bridge()
        if '--iina' in sys.argv:run_iina()
        if '--foobar' in sys.argv:run_foobar()
    finally:
        viewer.terminate()
        try:viewer.wait(timeout=10)
        except subprocess.TimeoutExpired:viewer.kill();viewer.wait()
