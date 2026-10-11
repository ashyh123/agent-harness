/** Paired real-model benchmark of the EXISTING task-phase graph, not a new model loop. */
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MinimalHarness, type TaskInput } from './harness.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import { harnessConfiguration, harnessEnvironment } from './person_profile.js';
import { SKILLS_ROOT } from './skills.js';
import type { Configuration } from './execution_runtime.js';
import { openLangGraphBackend, type Execution } from './langgraph_backend.js';

const cases = [
  { id: 'dependent_growth', task: '季度营业额分别为12000、15000、18000、21000元。先求全年总额，再计算第四季度相对第一季度增长率（百分数），再求全年总额扣除8500元成本后的余额。所有算术必须调用calculate，依赖步骤须复用工具结果。最后给出表格，并在最后一行给出JSON对象，字段total、growth_pct、net，不用代码围栏。',
    expected: { total: 66000, growth_pct: 75, net: 57500 }, values: [27000,45000,66000,9000,.75,75,57500] },
  { id: 'weighted_inventory', task: '仓库A有120件、每件35元；仓库B有80件、每件50元。求总件数、总价值、加权平均单价；售出总件数的25%后，还剩多少件。必须用calculate逐步计算、复用之前的真实工具结果。最后给出表格，并在最后一行给出JSON对象，字段units、value、weighted_price、remaining，不用代码围栏。',
    expected: { units: 200, value: 8200, weighted_price: 41, remaining: 150 }, values: [200,4200,4000,8200,41,50,150] },
  { id: 'zero_error_recovery', task: '这是工具错误恢复验收：必须先用calculate实际尝试divide(120,0)，收到错误后不要重试同一无效除法。将该项报告为无法计算，继续用calculate计算(128+256)*3，再计算900减去前项结果，不能把错误当数字。最后给出步骤表格，并在最后一行给出JSON对象，字段invalid=null、sum_times_three、balance，不用代码围栏。',
    expected: { invalid: null, sum_times_three: 1152, balance: -252 }, values: [384,1152,-252] },
  { id: 'budget_boundary', task: '从100开始，按以下顺序逐步用calculate执行：加20、乘3、减60、除5、加7、乘4、减10、除2、加11。每一步必须等前一步真实工具结果后再进行，不能心算、合并步骤或改写算式。给出九步表格，在最后一行给出JSON对象字段final，不用代码围栏；如果预算耗尽则不能声称完成。',
    expected: { final: 140 }, values: [120,360,300,60,67,268,258,129,140] },
];
const selectedCases = process.argv.includes('--stress-only') ? cases.filter(c=>c.id==='budget_boundary')
  : cases.filter(c=>c.id!=='budget_boundary');
function verify(record: Execution['record'], c: typeof cases[number]) {
  const r = record.result;
  const trajectory = (r?.events ?? []).filter((e: any) => e.type === 'tool');
  const lines = (r?.answer ?? '').trim().split('\n');
  let output: any = null;
  try { output = JSON.parse(lines.at(-1)!); } catch { /* format is an acceptance requirement */ }
  const fields = Object.entries(c.expected).every(([k,v]) => output && output[k] === v);
  const values = c.values.every(v => trajectory.some((e: any) => typeof e.result?.result === 'number'
    && Math.abs(e.result.result-v) < 1e-8));
  // Associativity means a valid aggregation can have different partial sums.
  const essential = Object.values(c.expected).filter(v => typeof v === 'number')
    .every(v => trajectory.some((e:any) => Math.abs((e.result?.result ?? Infinity)-v!) < 1e-8));
  const bad = trajectory.filter((e:any) => e.arguments?.operation === 'divide' && e.arguments?.b === 0);
  const recovery = c.id !== 'zero_error_recovery' || (bad.length === 1 && bad[0].result?.error
    && trajectory.indexOf(bad[0]) < trajectory.findIndex((e:any) => e.result?.result === 1152));
  return { passed: record.runtime_status === 'completed' && fields && essential && !!recovery,
    checks: { completed: record.runtime_status === 'completed', final_json: fields, numeric_tool_evidence: essential,
      error_recovery: !!recovery, reference_intermediate_path: values }, output, trajectory };
}
loadLocalEnv();
if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
const root = join(ROOT,'reports/langgraph-runs');
await mkdir(root,{recursive:true});
const directory = await mkdtemp(join(root,'complex-'));
const rows: any[] = [];
const report = { started_at: new Date().toISOString(), mode:'real_model_same_executor_task_phase_graph',
  repeats:3, cases:selectedCases, rows, notes:'Original defaults, calculate only, same prompt/model/limits. Auto-approval only after independent fixed task checks. No browsing or external writes.' };
const save = () => writeFile(join(directory,'comparison.json'),redact(JSON.stringify(report,null,2)),{mode:0o600});
await save(); console.log(directory);
async function execute(path: string, input: TaskInput) {
  const bridge = new PythonBridge(harnessEnvironment(input.skill));
  try {
    const base = harnessConfiguration(await bridge.request<Configuration>('describe'),input.skill);
    const config = {...base, tools:base.tools.filter(t=>t.name==='calculate'), temperature:0};
    return await new MinimalHarness(bridge,config,{skills:SKILLS_ROOT,runs:join(path,'harness')}).run(input);
  } finally {bridge.close();}
}
for (let repeat=0;repeat<3;repeat++) for (const c of selectedCases) {
  for (const backend of repeat%2 ? ['langgraph','harness'] : ['harness','langgraph']) {
    const input={skill:'calculation-audit',task:c.task};
    const path=join(directory,`${c.id}-${repeat}-${backend}`);
    const started=performance.now();
    let execution: Execution; let graphStatus: string|null=null;
    let recovery: any=null;
    if(backend==='harness') execution=await execute(path,input);
    else {
      const graph=await openLangGraphBackend(path,task=>execute(path,task));
      try {const state=await graph.start(input); execution=state.execution; graphStatus=state.status;}
      finally {graph.close();}
    }
    const executionWallMs=Math.round(performance.now()-started);
    const assessment=verify(execution.record,c);
    if(backend==='langgraph' && graphStatus==='needs_review') {
      const restored=await openLangGraphBackend(path,()=>{throw new Error('Unexpected executor replay');});
      try {
        const state=await restored.resume(assessment.passed); graphStatus=state.status;
        const before=assessment.passed ? await stat(join(path,'delivery.md')) : null;
        await restored.resume();
        const after=before ? await stat(join(path,'delivery.md')) : null;
        const receipt=JSON.parse(await readFile(join(path,'execution.json'),'utf8'));
        recovery={model_requests_unchanged:receipt.record.result?.model_requests===execution.record.result?.model_requests,
          tool_calls_unchanged:receipt.record.result?.tool_calls===execution.record.result?.tool_calls,
          delivery_not_rewritten:before ? before.ino===after!.ino && before.mtimeMs===after!.mtimeMs : null};
      } finally {restored.close();}
    }
    const r=execution.record.result;
    const usage=(r?.events??[]).filter((e:any)=>e.usage).map((e:any)=>e.usage);
    const row={backend,case_id:c.id,repeat,configuration:execution.record.configuration,
      accepted:assessment.passed,checks:assessment.checks,graph_status:graphStatus,recovery,
      elapsed_ms:Math.round(performance.now()-started),execution_wall_ms:executionWallMs,
      executor_elapsed_ms:Date.parse(execution.record.finished_at)-Date.parse(execution.record.started_at),
      model_requests:r?.model_requests??0,tool_calls:r?.tool_calls??0,tokens:r?.total_tokens??null,
      prompt_tokens:usage.reduce((s:number,u:any)=>s+(u.prompt_tokens??0),0),
      completion_tokens:usage.reduce((s:number,u:any)=>s+(u.completion_tokens??0),0),provider_usage:usage,
      duplicate_calls:assessment.trajectory.length-new Set(assessment.trajectory.map((e:any)=>JSON.stringify([e.name,e.arguments]))).size,
      compactions:r?.context_compactions.length??0,error:r?.error??execution.record.harness_error,
      answer:r?.answer??null,trajectory:assessment.trajectory};
    rows.push(row);await save();
    console.log(`${c.id} ${backend} #${repeat+1}: accepted=${row.accepted} requests=${row.model_requests} tools=${row.tool_calls} tokens=${row.tokens} ms=${row.elapsed_ms}`);
  }
}
await writeFile(join(directory,'finished.json'),JSON.stringify({finished_at:new Date().toISOString()}));
console.log(`Completed ${rows.length} real task runs.`);
