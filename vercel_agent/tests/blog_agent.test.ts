import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlogAgent } from '../blog_agent.js';
import { PythonBridge, ROOT } from '../bridge.js';
import { SKILLS_ROOT } from '../skills.js';
import type { Configuration } from '../execution_runtime.js';

const response = (content: string | null, calls: any[] = []) => new Response(JSON.stringify({
  id:'test',object:'chat.completion',created:1,model:'deepseek-flash',
  choices:[{index:0,finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content,tool_calls:calls}}],
  usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20},
}), {headers:{'content-type':'application/json'}});
const call=(name:string,args:any)=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('dedicated LangGraph agent restricts tools and verifies real note writes; text claims cannot pass', async t => {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'blog-agent-')));
  const env={...process.env,DEEPSEEK_API_KEY:'offline-test-key',MINIMAL_AGENT_TASK_COORDINATION:'0',MINIMAL_AGENT_CODEX_DELEGATION:'0',
    MINIMAL_AGENT_WEBPAGE_STORE_DIR:join(directory,'snapshots'),MINIMAL_AGENT_OBSIDIAN_VAULT:join(directory,'vault')};
  const id=execFileSync(join(ROOT,'.venv/bin/python'),['-c',
    'from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/blog", title="Agent loop", content="An agent uses tools in a loop. " * 100, footnotes_found=0, coverage_note="Not verified."))'],{cwd:ROOT,env,encoding:'utf8'}).trim();
  const bridge=new PythonBridge(env);
  t.after(async()=>{bridge.close();await rm(directory,{recursive:true,force:true});});
  const config=await bridge.request<Configuration>('describe');
  config.context_policy={...config.context_policy,trigger_tokens:40000,target_tokens:28000};
  let requests=0;
  const fetcher:typeof fetch=async(_url,init)=>{
    const payload=JSON.parse(String(init?.body));
    requests++;
    if (!payload.tools) return response(JSON.stringify({checks:['summary_facts','quote_supports_core','takeaway_is_inference'].map(id=>({id,verdict:'supported',reason:'原文支持'})),
      core_match: { claim: '模型如何在循环中选择工具', evidence_field: 'evidence_quote' }, risk_checks: []}));
    assert.deepEqual(payload.tools.map((x:any)=>x.function.name).sort(),['read_saved_webpage','read_webpage','save_obsidian_blog','search_saved_webpage']);
    if(requests===1)return response(null,[call('read_saved_webpage',{document_id:id,content_format:'text',limit:4000})]);
    assert.equal(requests,2,'second model turn proposes save');
    return response(null,[call('save_obsidian_blog',{document_id:id,summary:'文章说明模型如何在循环中选择工具、观察结果并继续判断任务，工具反馈构成上下文。',takeaway:'我的推论：保存工具结果有助于核查任务执行。',evidence_quote:'An agent uses tools in a loop.'})]);
  };
  const paths={skills:SKILLS_ROOT,runs:join(directory,'runs')};
  const agent=new BlogAgent(bridge,config,paths,fetcher);
  const result=await agent.run('https://example.com/blog');
  assert.equal(result.saved,true,JSON.stringify(result.record.result?.error));
  assert.equal(result.record.result?.completion_source,'verified_tool');
  assert.match(await readFile(result.receipt.note_path,'utf8'),/工具结果/);
  assert.equal(requests,3);
  let turns = 0;
  let reviews = 0;
  const repaired = await new BlogAgent(bridge, config, paths, async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    if (!payload.tools) {
      reviews++;
      return response(JSON.stringify({ checks: ['summary_facts', 'quote_supports_core', 'takeaway_is_inference']
        .map(id => ({ id, verdict: reviews === 1 && id === 'quote_supports_core' ? 'insufficient' : 'supported', reason: '需要支持核心结论的引文' })),
        core_match: { claim: '模型如何在循环中选择工具', evidence_field: 'evidence_quote' }, risk_checks: [] }));
    }
    turns++;
    if (turns === 1) return response(null,[call('read_saved_webpage',{document_id:id,content_format:'text',limit:4000})]);
    if (turns === 3) assert.match(JSON.stringify(payload.messages), /evidence_not_supported/);
    return response(null,[call('save_obsidian_blog',{document_id:id,
      summary:'文章说明模型如何在循环中选择工具、观察结果并继续判断任务，工具反馈构成上下文。',
      takeaway:'我的推论：保存工具结果有助于核查任务执行。',evidence_quote:'An agent uses tools in a loop.'})]);
  }).run('https://example.com/blog');
  assert.equal(repaired.saved, true);
  assert.equal(repaired.record.result?.model_requests, 5, 'review and repair share the original model budget');
  assert.equal(repaired.record.result?.tool_calls, 3, 'rejected save is still a tool attempt');
  assert.equal(repaired.record.result?.events.filter(e => e.type === 'tool' && e.name === 'save_obsidian_blog' && e.result?.verified).length, 1);
  const liar=new BlogAgent(bridge,config,paths,async()=>response('已经保存到Obsidian。'));
  assert.equal((await liar.run('https://example.com/blog')).saved,false);
  await assert.rejects(agent.run('file:///tmp/example'),/HTTP/);
});
