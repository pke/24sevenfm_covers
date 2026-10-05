#!/usr/bin/env python3
"""Sequential Wayland comparison. Never substitute offscreen for a desktop run."""
import argparse, csv, json, os, pathlib, subprocess, statistics, time
p=argparse.ArgumentParser()
p.add_argument('--build',required=True,type=pathlib.Path)
p.add_argument('--output',required=True,type=pathlib.Path)
p.add_argument('--runs',type=int,default=3)
p.add_argument('--seconds',type=int,default=8)
p.add_argument('--warmup',type=int,default=3)
p.add_argument('--scale',type=float,default=1,help='Qt scale factor for timed runs')
p.add_argument('--scenarios',nargs='+',choices=('idle','countdown','changes','resize'),
               default=['idle','countdown','changes','resize'])
p.add_argument('--skip-visual',action='store_true',help='Reuse separately collected screenshot evidence')
p.add_argument('--renderers',nargs='+',choices=('raster','opengl','opengl-direct','rhi-vulkan','rhi-opengl'),
               help='Run only the selected paths, for example when Vulkan has no hardware device')
a=p.parse_args()
if a.runs<2: p.error('Use at least two repetitions')
if not 0<a.scale<=4: p.error('Scale must be greater than zero and at most four')
a.output.mkdir(parents=True,exist_ok=True)
env=dict(os.environ,QT_QPA_PLATFORM='wayland',QT_LOGGING_RULES='qt.rhi.general=false',QT_SCALE_FACTOR=str(a.scale))
if not env.get('WAYLAND_DISPLAY'): p.error('No Wayland session')
candidates=[('raster',{}),('opengl',{'SSC_GL_EXACT':'1'}),('opengl-direct',{'SSC_GL_EXACT':'0'}),('rhi-vulkan',{'SSC_RHI_BACKEND':'vulkan'}),('rhi-opengl',{'SSC_RHI_BACKEND':'opengl'})]
if a.renderers: candidates=[candidate for candidate in candidates if candidate[0] in a.renderers]
rows=[]
failures=[]
for run in range(a.runs):
    order=candidates[run%len(candidates):]+candidates[:run%len(candidates)]
    for scenario in a.scenarios:
        for renderer,extra in order:
            stem=f'{renderer}-{scenario}-{run+1}'
            binary=a.build/('render_bench_'+('rhi' if renderer.startswith('rhi-') else 'opengl' if renderer.startswith('opengl') else renderer))
            target=a.output/(stem+'.json')
            if target.exists(): raise RuntimeError(f'Result already exists: {target}; use a fresh output directory')
            with (a.output/(stem+'.log')).open('w') as log:
                try:
                    result=subprocess.run([str(binary),'--scenario',scenario,'--warmup',str(a.warmup),'--seconds',str(a.seconds),'--output',str(target)],env=dict(env,**extra),stdout=log,stderr=subprocess.STDOUT,timeout=a.warmup+a.seconds+30)
                except subprocess.TimeoutExpired:
                    result=subprocess.CompletedProcess(str(binary),124)
                    log.write('\nBENCHMARK TIMEOUT\n')
            if result.returncode:
                failures.append(dict(stem=stem,returncode=result.returncode,measurementWritten=target.exists()))
                print(stem,'FAILED',result.returncode,flush=True)
            if not target.exists(): continue
            row=json.loads(target.read_text());row.update(renderer=renderer,run=run+1,exitCode=result.returncode);rows.append(row)
            print(stem,round(row['cpuPercentOneCore'],2),row['paintCount'],flush=True)
(a.output/'all-results.json').write_text(json.dumps(rows,indent=2)+'\n')
fields=['renderer','scenario','runs','successful_exits','cpu_mean','cpu_min','cpu_max','paints_mean','render_avg_ms','render_p95_ms','interval_avg_ms','interval_p95_ms','elapsed_mean_ms','elapsed_min_ms','elapsed_max_ms','paint_fps_mean']
with (a.output/'summary.csv').open('w',newline='') as file:
    writer=csv.DictWriter(file,fieldnames=fields);writer.writeheader()
    for renderer,_ in candidates:
        for scenario in a.scenarios:
            # Retain failed-process JSON as evidence, never as performance data.
            group=[r for r in rows if r['renderer']==renderer and r['scenario']==scenario and r['exitCode']==0]
            if not group: continue
            def mean(key,sub=None):
                values=[r[key][sub] if sub else r[key] for r in group];values=[v for v in values if v is not None]
                return statistics.mean(values) if values else None
            writer.writerow(dict(renderer=renderer,scenario=scenario,runs=len(group),successful_exits=sum(r['exitCode']==0 for r in group),cpu_mean=mean('cpuPercentOneCore'),cpu_min=min(r['cpuPercentOneCore'] for r in group),cpu_max=max(r['cpuPercentOneCore'] for r in group),paints_mean=mean('paintCount'),render_avg_ms=mean('renderCpuMs','avg'),render_p95_ms=mean('renderCpuMs','p95'),interval_avg_ms=mean('paintIntervalMs','avg'),interval_p95_ms=mean('paintIntervalMs','p95'),elapsed_mean_ms=mean('elapsedMs'),elapsed_min_ms=min(r['elapsedMs'] for r in group),elapsed_max_ms=max(r['elapsedMs'] for r in group),paint_fps_mean=statistics.mean(r['paintCount']*1000/r['elapsedMs'] for r in group)))
visual_scales=[] if a.skip_visual else ['1','1.5']
for scale in visual_scales:
    for renderer,extra in candidates:
        folder=a.output/f'visual-{renderer}-{scale}'
        binary=a.build/('render_bench_'+('rhi' if renderer.startswith('rhi-') else 'opengl' if renderer.startswith('opengl') else renderer))
        with (a.output/f'visual-{renderer}-{scale}.log').open('w') as log:
            try:
                result=subprocess.run([str(binary),'--visual',str(folder)],env=dict(env,QT_SCALE_FACTOR=scale,**extra),stdout=log,stderr=subprocess.STDOUT,timeout=60)
            except subprocess.TimeoutExpired:
                result=subprocess.CompletedProcess(str(binary),124)
                log.write('\nVISUAL TIMEOUT\n')
        if result.returncode: failures.append(dict(stem=f'visual-{renderer}-{scale}',returncode=result.returncode))
(a.output/'failures.json').write_text(json.dumps(failures,indent=2)+'\n')
(a.output/'status.json').write_text(json.dumps(dict(complete=True,allProcessesPassed=not failures,runs=a.runs,seconds=a.seconds,warmup=a.warmup,scale=a.scale,scenarios=a.scenarios,visualScales=visual_scales,renderers=[name for name,_ in candidates],requireHardware='SSC_REQUIRE_HARDWARE' in env)))
if failures:
    print(f'{len(failures)} failed processes; see failures.json. Measurements with nonzero exitCode are diagnostic only.',flush=True)
    raise SystemExit(1)
