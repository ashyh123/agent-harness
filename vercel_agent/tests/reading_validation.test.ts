import test from 'node:test';
import assert from 'node:assert/strict';
import {checkReading,checkCritic,validateReadingContract, type ReadingContract} from '../reading_validation.js';
import {LangGraphLoop} from '../langgraph_loop.js';
import {PythonBridge} from '../bridge.js';
import type {Configuration} from '../execution_runtime.js';
const contract:ReadingContract={document_id:'a'.repeat(64),source_url:'https://example.com/post',questions:[{id:'size',question:'How many tasks?'}]};
const content='Start with 20-50 tasks from real failures. Do not measure success by a claim.';
const answer=JSON.stringify({facts:[{id:'size',answer:'从20–50个真实失败任务开始',quote:'20-50 tasks from real failures'}],source_url:contract.source_url,reading_scope:'targeted',page_completeness:'not_verified'});
const observation={type:'tool',name:'read_saved_webpage',result:{document_id:contract.document_id,url:contract.source_url,content_format:'text',content,offset:0,end_offset:content.length}};
const critic=JSON.stringify({checks:[{id:'size',verdict:'supported',reason:'数量和来源一致'}]});
test('实际原文、所有问题与逐字引文合规才进入语义核对；不读取答案正则',()=>{
 const r=checkReading(answer,contract,[observation]);assert.equal(r.validation.passed,true);assert.equal(r.evidence.length,1);
 assert.equal(checkReading(answer,contract,[]).validation.passed,false);
 assert.equal(checkReading(answer,contract,[{...observation,name:'search_saved_webpage'}]).validation.passed,false);
 assert.equal(checkReading(answer,contract,[{...observation,result:{...observation.result,document_id:'b'.repeat(64)}}]).validation.passed,false);
});
test('邻接分段支持跨段引文，但不能用未读空洞补全；保留非BMP字符',()=>{
 const split=20;const parts=[{...observation,result:{...observation.result,content:content.slice(0,split),end_offset:split}},
 {...observation,result:{...observation.result,content:content.slice(split),offset:split}}];
 assert.equal(checkReading(answer,contract,parts).validation.passed,true);
 parts[1].result.offset++;parts[1].result.content=content.slice(split+1);
 assert.equal(checkReading(answer,contract,parts).validation.passed,false);
});
test('缺问题、过长引文、不同来源、不合法JSON和未知完成范围均拒绝',()=>{
 for(const a of ['not JSON',JSON.stringify({...JSON.parse(answer),facts:[]}),JSON.stringify({...JSON.parse(answer),source_url:'https://bad.example'}),
 JSON.stringify({...JSON.parse(answer),reading_scope:'full'}),JSON.stringify({...JSON.parse(answer),facts:[{id:'size',answer:'20',quote:'x'.repeat(101)}]})])
 assert.equal(checkReading(a,contract,[observation]).validation.passed,false);
});
test('模型核对必须完整覆盖ID，否定、缺失、重复、截断和非法结论不能放行',()=>{
 assert.equal(checkCritic(critic,contract).passed,true);
 for(const c of ['bad','{}',JSON.stringify({checks:[]}),critic.replace('supported','unsupported'),critic.replace('supported','insufficient'),critic.replace('supported','true'),critic.replace('size','other')])
 assert.equal(checkCritic(c,contract).passed,false);
 assert.throws(()=>validateReadingContract({...contract,questions:[contract.questions[0],contract.questions[0]]}));
});
function completion(text:string|null,calls:any[]=[],finish=calls.length?'tool_calls':'stop'){return {id:'offline',object:'chat.completion',created:1,model:'deepseek-flash',choices:[{index:0,finish_reason:finish,message:{role:'assistant',content:text,...(calls.length?{tool_calls:calls}:{})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};}
function read(){return completion(null,[{id:'read',type:'function',function:{name:'read_saved_webpage',arguments:JSON.stringify({document_id:contract.document_id,content_format:'text'})}}]);}
async function setup(t:any,responses:any[]){
 const bridge=new PythonBridge({...process.env,DEEPSEEK_API_KEY:'offline-test-key'});t.after(()=>bridge.close());
 const base=await bridge.request<Configuration>('describe');const requests:any[]=[];
 const config={...base,tools:base.tools.filter(t=>t.name==='read_saved_webpage'),max_steps:8,max_model_requests:8};
 const fetcher:typeof fetch=async(_,init)=>{requests.push(JSON.parse(init!.body as string));assert.ok(responses.length,'unexpected request');return new Response(JSON.stringify(responses.shift()),{headers:{'content-type':'application/json'}});};
 return {loop:new LangGraphLoop(bridge,config,fetcher),requests};
}
test('缺证据先修正，再独立核对；成功工具不重跑，核对计入共享预算',async t=>{
 const {loop,requests}=await setup(t,[read(),completion(answer.replace('20-50 tasks from real failures','missing evidence')),completion(answer),completion(critic)]);
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,fixtures:{read_saved_webpage:observation.result}});
 assert.equal(result.error,null);assert.equal(result.answer,answer);assert.equal(result.model_requests,4);assert.equal(result.tool_calls,1);
 assert.equal(result.events.filter(e=>e.kind==='reading_critic').length,1);
 assert.equal(result.reading_validation?.[0].passed,false);
 assert.ok(requests[2].messages.some((m:any)=>m.content?.includes('Harness验收未通过')));
 const review=requests[3];assert.equal(review.tools,undefined);assert.ok(review.messages.some((m:any)=>m.content?.includes('How many tasks?')));
 assert.ok(!JSON.stringify(review).includes('Harness验收未通过'));
});
test('语义核对否决后修正答案再核对，最终成功才提交历史',async t=>{
 const bad=answer.replace('从20–50个真实失败任务开始','从200个任务开始');
 const {loop}=await setup(t,[read(),completion(bad),completion(critic.replace('supported','unsupported')),completion(answer),completion(critic)]);
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,fixtures:{read_saved_webpage:observation.result}});
 assert.equal(result.error,null);assert.equal(result.model_requests,5);assert.equal(result.tool_calls,1);
 assert.equal(result.reading_validation?.filter(r=>r.stage==='semantic'&&!r.passed).length,1);
});
test('最后一次请求生成答案后没有预算核对：必须失败，不返回未验收答案',async t=>{
 const {loop,requests}=await setup(t,[read(),completion(answer)]);const messages:any[]=[{role:'user',content:'answer'}];
 const result=await loop.run(messages,{readingContract:contract,limits:{max_steps:2},fixtures:{read_saved_webpage:observation.result}});
 assert.match(result.error??'',/上限/);assert.equal(result.answer,null);assert.equal(result.model_requests,2);assert.equal(requests.length,2);assert.equal(messages.length,1);
});

test('检索预览从压缩索引移出，只保留回读定位且不声称已读',async()=>{
 const {collectEvidence}=await import('../context.js');
 const records=collectEvidence([{role:'tool',content:[{type:'tool-result',toolCallId:'search',toolName:'search_saved_webpage',
 output:{type:'json',value:{document_id:contract.document_id,url:contract.source_url,query:'tasks',content_format:'text',matches:[{offset:20000,end_offset:21000,preview:'large preview'.repeat(200)}]}}}]}]);
 const value=records[0].result as any;assert.equal(value.previews_omitted,true);assert.deepEqual(value.matches,[{offset:20000,end_offset:21000}]);
 assert.ok(!JSON.stringify(value).includes('large preview'));
});


test('输出截断恢复后仍交付合法JSON，通知与答案分开且工具不重跑',async t=>{
 const {loop}=await setup(t,[read(),completion('half',[],'length'),completion(answer),completion(critic)]);
 const notices:string[]=[];
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,fixtures:{read_saved_webpage:observation.result},onNotice:n=>notices.push(n)});
 assert.equal(result.error,null);assert.equal(result.answer,answer);assert.equal(result.compact_retry_used,true);
 assert.equal(result.tool_calls,1);assert.equal(result.model_requests,4);assert.ok(notices.length);
 assert.deepEqual(JSON.parse(result.answer!),JSON.parse(answer));
});

test('程序验收模式不执行critic，最后一次模型请求返回合规答案即可完成',async t=>{
 const {loop,requests}=await setup(t,[read(),completion(answer)]);
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,readingReview:'structural',limits:{max_steps:2},fixtures:{read_saved_webpage:observation.result}});
 assert.equal(result.error,null);assert.equal(result.answer,answer);assert.equal(result.model_requests,2);
 assert.equal(requests.length,2);assert.equal(result.reading_review,'structural');
 assert.ok(!result.graph_nodes?.includes('critic'));assert.ok(!result.events.some(e=>e.kind==='reading_critic'));
 assert.ok(result.reading_validation?.every(v=>v.stage==='structural'));
});

test('关闭critic仍拒绝缺引文并继续修正；复用已成功工具结果',async t=>{
 const {loop}=await setup(t,[read(),completion(answer.replace('20-50 tasks from real failures','missing evidence')),completion(answer)]);
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,readingReview:'structural',fixtures:{read_saved_webpage:observation.result}});
 assert.equal(result.error,null);assert.equal(result.model_requests,3);assert.equal(result.tool_calls,1);
 assert.equal(result.reading_validation?.[0].passed,false);assert.equal(result.reading_validation?.at(-1)?.passed,true);
});

test('程序验收通过不代表语义正确：相同真实引文不能自动判定错误数字',async t=>{
 const bad=answer.replace('从20–50个真实失败任务开始','从200个任务开始');
 const {loop}=await setup(t,[read(),completion(bad)]);
 const result=await loop.run([{role:'user',content:'answer'}],{readingContract:contract,readingReview:'structural',fixtures:{read_saved_webpage:observation.result}});
 assert.equal(result.error,null);assert.equal(result.answer,bad);assert.equal(result.model_requests,2);
});
