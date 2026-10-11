"""Paid, sequential, alternating-arm full coordinator evaluation (3 repeats)."""
import subprocess, os, json, time, tempfile, signal, sys
from pathlib import Path
exclusive='--exclusive' in sys.argv
root=Path(__file__).resolve().parent.parent
parent=root/'reports/routing-model-runs';parent.mkdir(parents=True,exist_ok=True)
out=Path(tempfile.mkdtemp(prefix='hybrid-exclusive-' if exclusive else 'hybrid-context-',dir=parent))
cases=[
 ('math','请发布一项任务：用计算工具计算(84-29)*7，把结果和实际工具证据保存到result.md。无需编写程序。'),
 ('data','请发布一项任务：用现有数据工具解析内联JSON [{"team":"R","amount":14},{"team":"S","amount":22},{"team":"R","amount":36}]，求amount合计、平均值和最大值。把结果和工具证据保存到result.md。无需编写程序或其他文件。'),
 ('blog','请发布一项阅读任务：读取 https://www.anthropic.com/engineering/managed-agents ，说明harness崩溃后依靠什么恢复，以及沙箱故障如何处理。提供一条逐字英文原文和来源URL。把结果保存在result.md。'),
 ('code','请发布一项任务：编写并实际运行Python脚本，将JSON [{"id":"004","amount":11},{"id":"009","amount":25}] 转为out.csv，保持原顺序和id前导零，表头id,amount。另存stats.json包含sum=36、mean=18、count=2，将执行说明保存到result.md。')]
manifest={'mode':'jev-exclusive' if exclusive else 'jev','cases':cases,'repeats':3,'models':{'jev':'jev-1.13.0','deepseek':'deepseek-flash','codex':'existing CLI config'},'budget':'unchanged person_cli / task-executor profiles','rubric':{'math':385,'data':{'sum':72,'mean':24,'max':36},'blog':'harness restored from session/event log; sandbox rebuilt after tool error; real source quote','code':{'ids':['004','009'],'sum':36,'mean':18,'count':2}},'strategy_source':(root/'vercel_agent/jev_submission.ts').read_text()}
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2));print(out,flush=True)
rows=[]
for repeat in range(3):
 for i,(name,task) in enumerate(cases):
  for arm in (['baseline','jev'] if (i+repeat)%2==0 else ['jev','baseline']):
   folder=out/f'{name}-{repeat}-{arm}';env=os.environ.copy();env['PATH']='/Users/ashyh666/.local/bin:'+env['PATH'];env['MINIMAL_AGENT_TASK_ROOT']=str(folder);env['MINIMAL_AGENT_ROUTING_CLASSIFIER']='jev-exclusive' if exclusive and arm=='jev' else arm
   start=time.monotonic()
   with (out/f'{name}-{repeat}-{arm}.log').open('w') as log:
    p=subprocess.Popen(['npm','run','person','--',task],cwd=root/'vercel_agent',env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    try: code=p.wait(timeout=950)
    except subprocess.TimeoutExpired: os.killpg(p.pid,signal.SIGTERM);code=p.wait(timeout=10)
   summaries=list(folder.rglob('summary.json'));summary=json.loads(summaries[0].read_text()) if summaries else {}
   row={'case':name,'repeat':repeat,'arm':arm,'elapsed_seconds':time.monotonic()-start,'exit_code':code,'directory':str(folder),'completed':bool(summary.get('tasks')) and all(t['status']=='completed' for t in summary['tasks'])}
   rows.append(row);(out/'results.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2));print(row,flush=True)
