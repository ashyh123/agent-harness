import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonBridge } from '../bridge.js';
import { MinimalHarness } from '../harness.js';
import { VercelLoop, type Configuration } from '../agent.js';
import { harnessConfiguration } from '../person_profile.js';
import { SKILLS_ROOT } from '../skills.js';
import { collectEvidence, compactedMessages } from '../context.js';

function completion(text: string | null, calls: any[] = []) {
  return { id: 'offline', object: 'chat.completion', created: 1, model: 'deepseek-flash',
    choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
      role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}),
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
}
const call = (id: string, name: string, input: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });

async function setup(t: TestContext, respond: (request: any, index: number) => any, failCodex = false) {
  const directory = await mkdtemp(join(tmpdir(), 'person-agent-'));
  const executable = join(directory, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}\n`
    + `import {mkdir,writeFile} from 'node:fs/promises';\n`
    + `let task='';for await(const chunk of process.stdin)task+=chunk;\n`
    + `await mkdir('obsidian/阅读笔记',{recursive:true});await mkdir('obsidian/.obsidian',{recursive:true});\n`
    + `await writeFile('source.md','离线测试材料，不是实际抓取的博客');\n`
    + `await writeFile('evidence.json',JSON.stringify({source_url:'https://example.com/',claims:[{fact:'离线事实',quote:'fixture',location:'fixture'}],recommendations:[{suggestion:'离线推论',is_inference:true}]}));\n`
    + `await writeFile('obsidian/阅读笔记/blog.md','# 离线笔记\\n事实与推论待验收');\n`
    + `await writeFile('obsidian/.obsidian/app.json','{}');\n`
    + `const args=process.argv.slice(2);await writeFile(args[args.indexOf('--output-last-message')+1],'离线CLI结束');\n`
    + `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'}));\n`
    + (failCodex ? `console.log(JSON.stringify({type:'turn.failed',error:{message:'offline failure'}}));\n`
      : `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}));\n`), { mode: 0o700 });
  const bridge = new PythonBridge({ ...process.env, DEEPSEEK_API_KEY: 'offline-test-key',
    MINIMAL_AGENT_CODEX_DELEGATION: '1', MINIMAL_AGENT_NODE_BIN: process.execPath,
    MINIMAL_AGENT_CODEX_BIN: executable, MINIMAL_AGENT_TASK_ROOT: join(directory, 'delegated') });
  t.after(async () => { bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const config = harnessConfiguration(await bridge.request<Configuration>('describe'), 'person-agent');
  const requests: any[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    requests.push(request);
    return new Response(JSON.stringify(respond(request, requests.length - 1)), { headers: { 'content-type': 'application/json' } });
  };
  return { bridge, config, requests, directory, fetcher,
    harness: new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'runs') }, fetcher) };
}

const delegatedInput = { task: '离线流程验收', expected_files: ['source.md', 'evidence.json', 'obsidian/阅读笔记/blog.md', 'obsidian/.obsidian/app.json'] };

test('真实SDK调用委派工具，经Python和路由器启动假CLI，结果回到父模型，再由父模型回读产物', async t => {
  let receipt: any;
  const { harness, requests, config } = await setup(t, (request, index) => {
    if (index === 0) return completion(null, [call('delegate-1', 'delegate_to_codex', delegatedInput)]);
    if (index === 1) {
      const returned = request.messages.find((message: any) => message.role === 'tool' && message.tool_call_id === 'delegate-1');
      receipt = JSON.parse(returned.content);
      assert.equal(receipt.status, 'completed');
      assert.equal(receipt.files.length, 4);
      return completion(null, [call('read-json', 'read_delegated_file', { task_id: receipt.task_id, path: 'evidence.json' }),
        call('read-note', 'read_delegated_file', { task_id: receipt.task_id, path: 'obsidian/阅读笔记/blog.md' })]);
    }
    assert.equal(index, 2, '不应额外请求模型');
    const reads = request.messages.filter((message: any) => ['read-json', 'read-note'].includes(message.tool_call_id));
    assert.equal(reads.length, 2);
    assert.ok(reads.every((message: any) => JSON.parse(message.content).hash_verified));
    assert.match(reads.map((message: any) => message.content).join('\n'), /离线事实|离线笔记/);
    return completion(`已回读子任务产物，事实仍待核实。${receipt.workspace}/obsidian/阅读笔记/blog.md`);
  });
  const { record } = await harness.run({ skill: 'person-agent', task: '交给Codex处理离线样例，再审阅文件' });
  assert.equal(config.tools.length, 10);
  assert.equal(config.max_seconds, 360);
  assert.equal(config.context_policy?.trigger_tokens, 24_000);
  assert.equal(config.context_policy?.target_tokens, 16_000);
  assert.equal(config.max_steps, 5);
  assert.equal(record.runtime_status, 'completed');
  assert.equal(record.task_verdict, 'needs_review');
  assert.equal(record.automatic_checks?.passed, true);
  assert.equal(record.result?.model_requests, 3, '父模型次数不包含子CLI内部调用');
  assert.equal(record.result?.tool_calls, 3);
  assert.equal(record.result?.total_tokens, 45, '父模型用量单列');
  const toolEvents = record.result!.events.filter(event => event.type === 'tool');
  assert.deepEqual(toolEvents.map(event => event.tool_call_id), ['delegate-1', 'read-json', 'read-note']);
  assert.equal(toolEvents[0].result.usage.input_tokens, 100);
  assert.ok(requests[0].tools.some((tool: any) => tool.function.name === 'delegate_to_codex'));
  const child = JSON.parse(await readFile(toolEvents[0].result.record_path, 'utf8'));
  assert.equal(child.status, 'completed');
});

test('父模型重复委派同一任务只启动一个CLI，结果复用仍计入父工具次数', async t => {
  const { bridge, config, fetcher } = await setup(t, (_request, index) => {
    return index === 0 ? completion(null, [call('a', 'delegate_to_codex', delegatedInput), call('b', 'delegate_to_codex', delegatedInput)]) : completion('复用同一个子任务');
  });
  const result = await new VercelLoop(bridge, config, fetcher).run([{ role: 'user', content: '重复调用测试' }]);
  assert.equal(result.error, null);
  const events = result.events.filter(event => event.type === 'tool');
  assert.equal(events.length, 2);
  assert.equal(events[0].result.task_id, events[1].result.task_id);
  assert.equal(events[0].result.reused, false);
  assert.equal(events[1].result.reused, true);
  assert.equal(result.tool_calls, 2);
});

test('子Agent失败仍作为工具资料回给父模型，父模型解释后不能通过验收', async t => {
  const { harness } = await setup(t, (request, index) => {
    if (index === 0) return completion(null, [call('failed', 'delegate_to_codex', delegatedInput)]);
    const returned = JSON.parse(request.messages.find((message: any) => message.tool_call_id === 'failed').content);
    assert.equal(returned.status, 'failed');
    assert.equal(returned.task_verdict, 'not_completed');
    return completion('Codex未完成，不能报告已完成博客任务');
  }, true);
  const { record } = await harness.run({ skill: 'person-agent', task: '执行失败场景' });
  assert.equal(record.runtime_status, 'completed');
  assert.equal(record.task_verdict, 'failed_checks');
  assert.equal(record.automatic_checks?.items.find(item => item.name === 'delegation_succeeded')?.passed, false);
});

test('父模型只收到子Agent口头回答但不回读文件，拒绝验收', async t => {
  const { harness } = await setup(t, (_request, index) => index === 0
    ? completion(null, [call('delegate', 'delegate_to_codex', delegatedInput)]) : completion('子Agent说已完成，所以全部完成'));
  const { record } = await harness.run({ skill: 'person-agent', task: '口头完成不能代替回读' });
  assert.equal(record.task_verdict, 'failed_checks');
  assert.equal(record.automatic_checks?.items.find(item => item.name === 'parent_read_artifacts')?.passed, false);
});

test('上下文压缩保留子任务ID、文件路径、hash及分页位置，回查无需重启子Agent', () => {
  const messages: any[] = [{ role: 'user', content: '审阅子任务' },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'delegate', toolName: 'delegate_to_codex', output: { type: 'json', value: {
      task_id: 'task', workspace: '/workspace', status: 'completed', files: [{ path: 'note.md', sha256: 'hash' }], answer: 'x'.repeat(3000),
    } } }, { type: 'tool-result', toolCallId: 'read', toolName: 'read_delegated_file', output: { type: 'json', value: {
      task_id: 'task', path: 'note.md', sha256: 'hash', hash_verified: true, offset: 0, end_offset: 3000, next_offset: 3000, content: 'x'.repeat(3000),
    } } }] }];
  const evidence: any = collectEvidence(messages);
  assert.equal(evidence[0].result.task_id, 'task');
  assert.equal(evidence[0].result.files[0].path, 'note.md');
  assert.equal(evidence[1].result.next_offset, 3000);
  assert.equal(evidence[1].result.sha256, 'hash');
  assert.ok(!JSON.stringify(compactedMessages(messages, '继续回读')).includes('x'.repeat(3000)));
});
