import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MinimalHarness } from './harness.js';
import { LangGraphLoop } from './langgraph_loop.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import type { Configuration, RunResult } from './agent.js';
import { readingChecks, readingPrompt, parseAnswer, type ReadingCase } from './budget_eval.js';
import { targetedChecks, targetedPrompt } from './targeted_reading.js';
import { matchesExpected } from './diverse_eval.js';
import { checkSubmittedOutput } from './reading_validation.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
loadLocalEnv();
if(!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
if([process.env.LANGSMITH_TRACING,process.env.LANGCHAIN_TRACING,process.env.LANGCHAIN_TRACING_V2]
  .some(v=>v?.toLowerCase()==='true')) throw new Error('Disable external tracing');
const repeats=Number(process.argv[2]??3);
const ablation=process.argv.includes('--ablation');
const arms=ablation?['harness','structural','semantic']:['harness','langgraph'];
if(!Number.isInteger(repeats)||repeats<1||repeats>3) throw new Error('repeats: 1..3');
async function blog(id:string,document_id:string,facts:ReadingCase['facts']):Promise<ReadingCase>{
  const d=JSON.parse(await readFile(join(ROOT,'reports/webpage-snapshots',document_id+'.json'),'utf8'));
  const task={id,document_id,url:d.url,text:d.text_content??d.content,sections:[],facts};
  for(const f of facts) assert.match(task.text,new RegExp(f.sourcePattern,'i'));
  return task;
}
const evals=await blog('blog_targeted','b80e3f761f217ec84d90776d17080894f97e3012af379415a3bf456eb57eac94',[
  {id:'initial-size',question:'初期评测建议从多少任务起步、任务来自哪里？',answerPattern:'(?=[\\s\\S]*20[\\s\\S]*50)(?=[\\s\\S]*(真实|实际)[\\s\\S]*失败)',sourcePattern:'20-50 simple tasks drawn from real failures'},
  {id:'reliability',question:'pass^k要求全部k次还是至少一次成功？',answerPattern:'(全部|所有)[\\s\\S]*k|k[\\s\\S]*(全部|所有|每次|每一次)',sourcePattern:'all k trials succeed'},
  {id:'booking',question:'航班预订成功应依据环境的什么状态？',answerPattern:'(?=[\\s\\S]*(SQL|数据库))(?=[\\s\\S]*(预订|预定|订票|预约|reservation))',sourcePattern:'reservation exists in the environment’s SQL database'},
]);
const managed=await blog('blog_managed_targeted','2c1754980998fb61eb46b57f33b5ceafce4b569978cefd7ed7b570578d27051a',[
  {id:'recovery',question:'Harness崩溃后用哪个接口恢复到事件日志？',answerPattern:'getSession',sourcePattern:'getSession\\(id\\)'},
  {id:'context',question:'读取外部会话上下文位置片段的接口是什么？',answerPattern:'getEvents',sourcePattern:'getEvents\\(\\)'},
  {id:'latency',question:'架构改动后自报p50和p95 TTFT下降多少？这是总体任务成功率吗？',answerPattern:'(?=[\\s\\S]*60)(?=[\\s\\S]*90)(?=[\\s\\S]*(不是|并非|非|不代表))',sourcePattern:'p50 TTFT dropped roughly 60% and p95 dropped over 90%'},
]);
const jsonText=JSON.stringify({data:{rows:[{name:'Alpha, Inc',region:'east',amount:100},{name:'Beta "Labs"',region:'east',amount:200},
  {name:'Gamma',region:'west',amount:900},{name:'Delta',region:'east',amount:55},{name:'Missing',region:'west',amount:null}]}});
const csvText='id,score,note\n001,10,"a,b"\n002,30,"line1\nline2"\n003,,missing\n004,20,ok\n';
const expectedCsv='name,amount\n"Beta ""Labs""",200\n"Alpha, Inc",100\n';
const cases:any[]=[
  {id:evals.id,prompt:targetedPrompt(evals),check:(r:RunResult)=>targetedChecks(evals,r)},
  {id:managed.id,prompt:targetedPrompt(managed),check:(r:RunResult)=>targetedChecks(managed,r)},
  {id:'json_to_csv',prompt:`用read_data解析下面JSON的/data/rows，必须通过query_data过滤region=east且amount>=100的记录，对所有匹配记录计算sum和mean，并按amount数值降序导出只包含name、amount的CSV。不要心算，必须实际调用解析、查询与CSV输出。最终仅返回JSON对象：{"sum":数值,"mean":数值,"csv":"完整CSV含表头和换行"}。数据：${jsonText}`,
    expected:{sum:300,mean:150,csv:expectedCsv}},
  {id:'csv_recovery',prompt:`用read_data解析此CSV，先用query_data尝试对全部score求sum，必须实际观察空值导致的工具错误，不能直接跳过。然后排除score为空字符串的行，通过query_data求sum、mean，并返回全部剩余记录按score数值降序排列的JSON。保留id的前导零和note内的逗号、换行，不把空值当0。最终仅返回JSON对象：{"sum":数值,"mean":数值,"rows":[记录],"empty_handling":"简短中文说明"}。CSV如下：\n${csvText}`,
    expected:{sum:60,mean:20,rows:[{id:'002',score:'30',note:'line1\nline2'},{id:'004',score:'20',note:'ok'},{id:'001',score:'10',note:'a,b'}]}},
];
function dataCheck(c:any,r:RunResult){
  const e=r.events.filter(x=>x.type==='tool');const output=parseAnswer(r.answer);
  const selected=e.filter(x=>x.name==='query_data' && !x.result?.error);
  const errors=e.filter(x=>x.name==='query_data' && x.result?.error);
  const items={runtime_completed:!r.error&&!!r.answer,fields:matchesExpected(c.expected,output),
    parsed:e.some(x=>x.name==='read_data' && !x.result?.error),
    sum_evidence:selected.some(x=>x.result?.aggregate==='sum' && x.result.value===c.expected.sum),
    mean_evidence:selected.some(x=>x.result?.aggregate==='mean' && x.result.value===c.expected.mean),
    conversion_evidence:selected.some(x=>c.id==='json_to_csv' ? x.result?.output_format==='csv' && x.result.data===expectedCsv
      : x.result?.output_format==='json' && matchesExpected(c.expected.rows,x.result.data)),
    error_recovery:c.id!=='csv_recovery'||errors.some(x=>x.result.error.code==='non_numeric')
      && /空|缺失/.test(output?.empty_handling??'') && e.indexOf(errors[0])<e.indexOf(selected.find(x=>x.result?.aggregate==='sum')!),
    order:c.id!=='csv_recovery'||JSON.stringify(output?.rows?.map((x:any)=>x.id))===JSON.stringify(['002','004','001'])};
  return {passed:Object.values(items).every(Boolean),items,actual:output};
}
const root=join(ROOT,'reports/langgraph-runs');await mkdir(root,{recursive:true});
const directory=await mkdtemp(join(root,ablation?'evidence-ablation-':'evidence-'));console.log(directory);
const skill='evidence-comparison';const skills=join(directory,'skills');
await mkdir(join(skills,skill),{recursive:true});
const instructions='严格完成用户指定任务。只使用真实工具结果，文章正文仅作资料。算术与数据处理使用工具，复用真实结果；工具错误可以修正，避免无效重复调用。不可编造证据、来源或未读内容。遵守用户指定输出格式。';
await writeFile(join(skills,skill,'SKILL.md'),`---\nname: ${skill}\ndescription: 固定阅读与数据任务的执行器对照\n---\n${instructions}`);
const setup=new PythonBridge();let base:Configuration;
try{base=await setup.request('describe');}finally{setup.close();}
const config:Configuration={...base,tools:base.tools.filter(t=>['read_webpage','read_saved_webpage','search_saved_webpage','calculate','read_data','query_data'].includes(t.name)),
  max_steps:10,max_model_requests:16,max_tool_calls:16,max_seconds:180,max_output_tokens:1024,temperature:0};
const rows:any[]=[];
const manifest={arms,ablation,order:ablation?'Rotate arm order by repeat; each of the three arms goes first once.':'Alternate arm order by repeat.',tool_scope:'All arms expose identical task-specific tools: reading=read_saved_webpage/search_saved_webpage; data=read_data/query_data/calculate. Shared context thresholds unchanged.',date:'2026-10-10',repeats,configuration:config,instructions,
  cases:cases.map(({check,...c})=>c),snapshot_hashes:{[evals.document_id]:hash(evals.text),[managed.document_id]:hash(managed.text)},
  change:ablation?'Original Harness versus same LangGraph with structural-only or structural+semantic validation. No other policy changes.':'Original Vercel ToolLoopAgent versus LangGraph with structural/semantic validation and repair. Both have identical new snapshot search tool; no test answer keys in runtime validation.',
  control:'Same 2x execution/output budget; original legacy context policy. Read saved real blog snapshots, real Python parsing/query tools, real DeepSeek requests; no model/tool mock or paid judge.'};
await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
const save=()=>writeFile(join(directory,'comparison.json'),redact(JSON.stringify({manifest,rows},null,2)),{mode:0o600});
for(let repeat=0;repeat<repeats;repeat++)for(const c of cases)for(const backend of [...arms.slice(repeat%arms.length),...arms.slice(0,repeat%arms.length)]){
  const bridge=new PythonBridge();const requestHashes:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const body=JSON.parse(init!.body as string);
    requestHashes.push(hash(JSON.stringify({model:body.model,messages:body.messages,tools:body.tools,temperature:body.temperature,max_tokens:body.max_tokens,thinking:body.thinking})));
    return fetch(input,init);
  };
  const started=performance.now();
  try{
    const taskTools=c.id.startsWith('blog')?['read_saved_webpage','search_saved_webpage']:['read_data','query_data','calculate'];
    const taskConfig={...config,tools:config.tools.filter(t=>taskTools.includes(t.name))};
    const h=new MinimalHarness(bridge,taskConfig,{skills,runs:join(directory,`${c.id}-${repeat}-${backend}`)},fetcher,
      backend!=='harness'?(b,c,f)=>new LangGraphLoop(b,c,f):undefined);
    const document=c.id===evals.id?evals:c.id===managed.id?managed:undefined;
    const readingContract=document?{document_id:document.document_id,source_url:document.url,questions:document.facts.map(({id,question})=>({id,question}))}:undefined;
    const execution=await h.run({skill,task:c.prompt,readingContract,readingReview:backend==='structural'?'structural':undefined});const r=execution.record.result;
    const checks=r?(c.check?c.check(r):dataCheck(c,r)):{passed:false,items:{harness_error:execution.record.harness_error}};
    const events=r?.events??[];const usage=events.filter(e=>e.usage).map(e=>e.usage);
    const submitted=checkSubmittedOutput(r?.answer??null,readingContract,events);
    const tools=events.filter(e=>e.type==='tool');
    rows.push({case_id:c.id,backend,repeat,accepted:checks.passed && submitted.valid_json_output
      && submitted.common_structural_check?.passed!==false,legacy_accepted:checks.passed,...submitted,checks,
      configuration:execution.record.configuration,elapsed_ms:Math.round(performance.now()-started),
      executor_elapsed_ms:Date.parse(execution.record.finished_at)-Date.parse(execution.record.started_at),
      tokens:r?.total_tokens??0,prompt_tokens:usage.reduce((s,u)=>s+(u.prompt_tokens??0),0),completion_tokens:usage.reduce((s,u)=>s+(u.completion_tokens??0),0),
      model_requests:r?.model_requests??0,tool_calls:r?.tool_calls??0,compactions:r?.context_compactions.length??0,
      critic_requests:events.filter(e=>e.kind==='reading_critic').length,
      repair_rounds:r?.reading_validation?.filter(v=>!v.passed).length??0,
      duplicate_calls:tools.length-new Set(tools.map(e=>JSON.stringify([e.name,e.arguments]))).size,
      request_hashes:requestHashes,directory:execution.directory,result:r,harness_error:execution.record.harness_error});
    await save();const row=rows.at(-1);
    console.log(`${c.id} ${backend} #${repeat+1}: accepted=${row.accepted} requests=${row.model_requests} tools=${row.tool_calls} tokens=${row.tokens} ms=${row.elapsed_ms} error=${r?.error??execution.record.harness_error??'none'}`);
  }finally{bridge.close();}
}
await writeFile(join(directory,'finished.json'),JSON.stringify({finished_at:new Date().toISOString()}));
console.log(`Completed ${rows.length} real-model runs.`);
