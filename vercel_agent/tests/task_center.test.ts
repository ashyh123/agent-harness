import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { TaskRouter, type AgentAdapter } from '../task_router.js';
import { TaskCenter, executorProfiles, selectExecutor, type Submission } from '../task_center.js';
import { TaskCenterServer } from '../task_center_server.js';
import { CenterConversation } from '../center_conversation.js';
import { PythonBridge } from '../bridge.js';
import { MinimalHarness } from '../harness.js';
import type { Configuration } from '../agent.js';
import { COORDINATOR_SKILL, harnessConfiguration } from '../person_profile.js';
import { SKILLS_ROOT } from '../skills.js';
import { compactedMessages, collectEvidence } from '../context.js';
import { createTaskAdapters } from '../task_adapters.js';
import { completedTaskPaths, renderCompletedTaskPaths } from '../center_presentation.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('离线流程等待超时'); await sleep(20); }
}
const task = (key: string, extra: Partial<Submission> = {}): Submission => ({
  key, task: `独立任务${key}：返回42`, capability: 'general', complexity: 'simple',
  acceptance: { expected_files: ['result.md'], file_contains: [{ path: 'result.md', text: '42' }] }, ...extra,
});

async function setup(t: TestContext, options: { wrong?: 'routine' | 'all'; delay?: number; hang?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'center-test-'));
  const script = join(directory, 'worker.mjs');
  await writeFile(script, `import {writeFile,appendFile} from 'node:fs/promises';\n`
    + `import {spawn} from 'node:child_process';\n`
    + `let stdin='';for await(const chunk of process.stdin)stdin+=chunk;\n`
    + `const spec=JSON.parse(stdin);const now=Date.now();\n`
    + `await appendFile(spec.log,JSON.stringify({kind:'start',agent:spec.agent,cwd:process.cwd(),at:now})+'\\n');\n`
    + `console.log(JSON.stringify({type:'harness.notice',message:'离线进度'}));\n`
    + (options.hang ? `if(spec.task.includes('hang')){const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();await writeFile('child.pid',String(child.pid));setInterval(()=>{},1000);await new Promise(()=>{});}\n` : '')
    + `await new Promise(resolve=>setTimeout(resolve,${options.delay ?? 160}));\n`
    + `const wrong=${JSON.stringify(options.wrong ?? '')}==='all'||(${JSON.stringify(options.wrong ?? '')}==='routine'&&spec.agent==='harness');\n`
    + `const answer=wrong?'错误内容':'结果42';await writeFile('result.md',answer);\n`
    + `await writeFile('data.json',JSON.stringify({value:wrong?0:42,nested:{a:1,b:2}}));\n`
    + `await writeFile('stdin.txt',spec.task);\n`
    + `await appendFile(spec.log,JSON.stringify({kind:'end',agent:spec.agent,cwd:process.cwd(),at:Date.now()})+'\\n');\n`
    + `console.log(JSON.stringify({type:'finished',answer,usage:{input_tokens:10,output_tokens:5}}));\n`);
  const adapters: AgentAdapter[] = ['harness', 'codex'].map(id => ({ id, description: '离线执行端',
    validate: async () => {},
    launch: async input => ({ executable: process.execPath, args: [script],
      stdin: JSON.stringify({ agent: id, task: input.task, log: join(directory, 'timeline.jsonl') }) }),
    result: async events => { const event = events.find((event: any) => event?.type === 'finished') as any;
      return { completed: !!event, answer: event?.answer ?? null, error: event ? null : '取消或失败', usage: event?.usage ?? null }; },
  }));
  const center = new TaskCenter(join(directory, 'center'), new TaskRouter(adapters, join(directory, 'executions')));
  await center.initialize();
  t.after(async () => { await center.shutdown(); await rm(directory, { force: true, recursive: true }); });
  return { directory, center };
}
async function reviewAll(center: TaskCenter, passed = true) {
  for (const job of center.state().filter(job => job.status === 'awaiting_review')) {
    const attempt = job.attempts.at(-1)!;
    await center.read(job.id, attempt.id, 'result.md');
    await center.review(job.id, attempt.id, passed, passed ? '实际回读结果满足要求' : '语义验收失败',
      passed ? [{ path: 'result.md', quote: '42' }] : []);
  }
}

test('三项独立任务真实进程并发，提交立即返回，第三项排队且最多同时运行两个', async t => {
  const { center, directory } = await setup(t, { delay: 300 });
  const receipt = await center.submit([task('a'), task('b'), task('c')]);
  assert.equal(receipt.tasks.length, 3);
  assert.ok(center.state().every(job => ['queued', 'running'].includes(job.status) && !job.attempts[0].record),
    '任务可以立即开始，但提交收据不等待工具或模型完成');
  await center.settled();
  assert.ok(center.state().every(job => job.status === 'awaiting_review'));
  const timeline = (await readFile(join(directory, 'timeline.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  let active = 0, maximum = 0;
  for (const event of timeline) { active += event.kind === 'start' ? 1 : -1; maximum = Math.max(maximum, active); }
  assert.equal(maximum, 2, '并发应是实际执行进程的重叠，不是仅同时打印running');
  assert.equal(active, 0);
  assert.equal(new Set(timeline.filter(event => event.kind === 'start').map(event => event.cwd)).size, 3);
  await reviewAll(center);
  assert.ok(center.state().every(job => job.status === 'completed' && job.verdict === 'agent_reviewed'));
  const paths = completedTaskPaths(center.state());
  assert.equal(paths.length, 3);
  const canonicalDirectory = await realpath(directory);
  assert.ok(paths.every(path => path.full_path.startsWith(canonicalDirectory + '/') && path.full_path.endsWith('/result.md')));
  const rendered = renderCompletedTaskPaths(center.state());
  assert.ok(paths.every(path => rendered.includes(path.full_path)), '完整路径来自收据，不依靠模型缩写');
});

test('能力优先、复杂度分层、指定路线和不可用候选均有明确规则', () => {
  const profiles = executorProfiles();
  assert.equal(selectExecutor(task('a'), profiles).selected.id, 'deepseek');
  assert.equal(selectExecutor(task('b', { complexity: 'complex' }), profiles).selected.id, 'codex');
  assert.equal(selectExecutor(task('c', { capability: 'coding' }), profiles).selected.id, 'codex');
  assert.throws(() => selectExecutor(task('d', { route: 'deepseek', capability: 'coding' }), profiles), /能力/);
  assert.throws(() => selectExecutor(task('e', { route: 'unknown' }), profiles), /不可用/);
  assert.equal(selectExecutor(task('f'), executorProfiles(false, true)).selected.id, 'codex');
});

test('首次程序验收失败自动升级一次，保留初次文件、原因和独立用量', async t => {
  const { center } = await setup(t, { wrong: 'routine' });
  await center.submit([task('upgrade')]); await center.settled();
  const job = center.state()[0], [first, second] = job.attempts;
  assert.equal(job.status, 'awaiting_review'); assert.equal(job.attempts.length, 2);
  assert.equal(first.executor, 'deepseek'); assert.equal(second.executor, 'codex');
  assert.ok(first.checks?.some(check => !check.passed));
  assert.ok(second.checks?.every(check => check.passed));
  assert.notEqual(first.record?.workspace, second.record?.workspace);
  assert.equal((await center.read(job.id, first.id, 'result.md')).content, '错误内容');
  assert.match(await readFile(join(second.record!.workspace, 'stdin.txt'), 'utf8'), /前一执行未通过|contains:result.md/);
  assert.deepEqual(first.record?.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(second.record?.usage, { input_tokens: 10, output_tokens: 5 });
  await assert.rejects(center.review(job.id, first.id, true, '不能覆盖旧轮'), /当前待验收/);
  await reviewAll(center);
  assert.equal(center.state()[0].status, 'completed');
});

test('两次失败强制结束；高级候选初次失败不会重试；时限不足不升级', async t => {
  const { center } = await setup(t, { wrong: 'all' });
  await center.submit([task('twice'), task('advanced', { complexity: 'complex' }), task('budget', { timeout_seconds: 1 })]);
  await center.settled();
  const jobs = center.state();
  assert.ok(jobs.every(job => job.status === 'failed'));
  assert.equal(jobs.find(job => job.input.key === 'twice')!.attempts.length, 2);
  assert.equal(jobs.find(job => job.input.key === 'advanced')!.attempts.length, 1);
  assert.equal(jobs.find(job => job.input.key === 'budget')!.attempts.length, 1);
});

test('主Agent实际回读后语义拒绝也能升级，未回读、伪造证据、重复审阅均拒绝', async t => {
  const { center } = await setup(t);
  await center.submit([task('semantic')]); await center.settled();
  const job = center.state()[0], first = job.attempts[0];
  await assert.rejects(center.review(job.id, first.id, true, '口头完成'), /先实际回读/);
  await center.read(job.id, first.id, 'result.md', 0, 2);
  await assert.rejects(center.review(job.id, first.id, true, '未读到数字', [{ path: 'result.md', quote: '42' }]), /实际回读范围/);
  await center.review(job.id, first.id, false, '数值正确但任务单位和格式不符');
  await center.settled();
  const second = center.state()[0].attempts[1];
  await center.read(job.id, second.id, 'result.md');
  await center.review(job.id, second.id, false, '第二轮仍不符合语义要求');
  assert.equal(center.state()[0].status, 'failed');
  assert.equal(center.state()[0].attempts.length, 2);
  await assert.rejects(center.review(job.id, second.id, true, '覆盖最终失败'), /当前待验收/);
});

test('幂等key复用，整批预检、范围和收件箱cursor不串任务、不重复消息', async t => {
  const { center } = await setup(t);
  const original = task('idempotent');
  const first = await center.submit([original, original]);
  assert.equal(first.tasks[0].task_id, first.tasks[1].task_id);
  assert.equal(first.tasks[1].reused, true);
  await assert.rejects(center.submit([task('new'), { ...original, task: '不同内容' }]), /同一key/);
  assert.equal(center.state().length, 1);
  await assert.rejects(center.submit([task('bad', { acceptance: { expected_files: ['../outside'] } })]), /相对产物/);
  await center.settled();
  const messages = await center.updates(0, 1);
  assert.equal(messages.events.length, 1); assert.equal(messages.has_more, true);
  const next = await center.updates(messages.next_cursor);
  assert.ok(next.events.every(event => event.sequence > messages.next_cursor));
  await assert.rejects(center.updates(999999), /cursor/);
  await assert.rejects(center.cancel('00000000-0000-0000-0000-000000000000'), /本中心/);
  const job = center.state()[0];
  await assert.rejects(center.read(job.id, job.attempts[0].id, '../outside'), /路径/);
});

test('JSON Pointer断言按原值验收，键顺序无关，错误预期不能被模型通过覆盖', async t => {
  const { center } = await setup(t);
  await center.submit([task('json-ok', { acceptance: { expected_files: ['result.md', 'data.json'],
    json_checks: [{ path: 'data.json', pointer: '/value', equals: 42 }, { path: 'data.json', pointer: '/nested', equals: { b: 2, a: 1 } }] } }),
    task('json-bad', { complexity: 'complex', acceptance: { expected_files: ['data.json'],
      json_checks: [{ path: 'data.json', pointer: '/value', equals: 999 }] } })]);
  await center.settled();
  const good = center.state().find(job => job.input.key === 'json-ok')!, bad = center.state().find(job => job.input.key === 'json-bad')!;
  assert.equal(good.status, 'awaiting_review'); assert.equal(bad.status, 'failed');
  await assert.rejects(center.review(bad.id, bad.attempts[0].id, true, '模型说通过'), /当前待验收/);
});

test('修改产物触发失败，不能读取符号链接；取消一个进程树不影响另一任务且不升级', async t => {
  const { center, directory } = await setup(t, { hang: true });
  await center.submit([task('hang', { task: 'hang' }), task('other', { complexity: 'complex' })]);
  const hung = center.state().find(job => job.input.key === 'hang')!;
  let pid = 0;
  await until(async () => {
    const rows = await center.updates(0, 20, hung.id);
    // 运行期间还没有最终收据，通过测试目录观察真实子进程的已落盘PID。
    const { readdir } = await import('node:fs/promises');
    const agentRoot = join(directory, 'executions', 'harness');
    try {
      for (const date of await readdir(agentRoot)) for (const id of await readdir(join(agentRoot, date))) {
        const file = join(agentRoot, date, id, 'workspace', 'child.pid');
        try { pid = Number(await readFile(file, 'utf8')); return !!pid; } catch { /* 尚未启动 */ }
      }
    } catch { /* 尚未创建目录 */ }
    return rows.tasks.length < 0;
  });
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已清理 */ } });
  await center.cancel(hung.id); await center.settled();
  assert.equal(center.state().find(job => job.id === hung.id)!.status, 'cancelled');
  assert.equal(center.state().find(job => job.id === hung.id)!.attempts.length, 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const other = center.state().find(job => job.input.key === 'other')!, attempt = other.attempts[0];
  assert.equal(other.status, 'awaiting_review');
  await writeFile(join(attempt.record!.workspace, 'result.md'), '修改后内容');
  await assert.rejects(center.read(other.id, attempt.id, 'result.md'), /hash/);
  assert.equal(center.state().find(job => job.id === other.id)!.status, 'failed');
  await rm(join(attempt.record!.workspace, 'data.json'));
  await symlink(join(directory, 'worker.mjs'), join(attempt.record!.workspace, 'data.json'));
  await assert.rejects(center.read(other.id, attempt.id, 'data.json'), /符号链接/);
});

test('真实Vercel SDK、Python校验和Unix IPC：主模型提交、回读、审阅，业务工具不暴露给主Agent', async t => {
  const { center, directory } = await setup(t, { delay: 300 });
  const server = new TaskCenterServer(center), env = await server.start();
  const bridge = new PythonBridge({ ...process.env, ...env, MINIMAL_AGENT_TASK_COORDINATION: '1', DEEPSEEK_API_KEY: 'offline-test-key' });
  t.after(async () => { bridge.close(); await server.close(); });
  const config = harnessConfiguration(await bridge.request<Configuration>('describe'), COORDINATOR_SKILL);
  assert.equal(config.tools.length, 5); assert.ok(!config.tools.some(tool => tool.name === 'calculate'));
  let phase: 'submit' | 'review' = 'submit';
  const call = (id: string, name: string, arguments_: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(arguments_) } });
  const complete = (text: string | null, calls?: unknown[]) => ({ id: 'fixture', object: 'chat.completion', model: 'fixture',
    choices: [{ index: 0, finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text, ...(calls ? { tool_calls: calls } : {}) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    const outputs = request.messages.filter((message: any) => message.role === 'tool').map((message: any) => JSON.parse(message.content));
    let result;
    if (phase === 'submit') result = outputs.length ? complete('已提交两项独立任务，等待外壳通知')
      : complete(null, [call('submit', 'submit_tasks', { tasks: [task('sdk-a'), task('sdk-b', { complexity: 'complex' })] })]);
    else if (!outputs.length) result = complete(null, [call('updates', 'get_task_updates', {})]);
    else if (outputs.at(-1).events) result = complete(null, outputs.at(-1).tasks.map((job: any, index: number) =>
      call('read-' + index, 'read_task_artifact', { task_id: job.task_id, attempt_id: job.attempt_id, path: 'result.md' })));
    else if (outputs.at(-1).hash_verified) result = complete(null, outputs.filter((item: any) => item.hash_verified).map((item: any, index: number) =>
      call('review-' + index, 'review_task', { task_id: item.task_id, attempt_id: item.attempt_id, passed: true, reason: '实际回读结果42' })));
    else result = complete('两项任务已回读并审阅：' + outputs.filter((item: any) => item.full_path).map((item: any) => item.full_path).join('\n'));
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  };
  const harness = new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'main-runs') }, fetcher);
  const first = await harness.run({ skill: COORDINATOR_SKILL, task: '发布两项独立任务' });
  assert.equal(first.record.result?.tool_calls, 1); assert.equal(first.record.runtime_status, 'completed');
  await center.settled(); phase = 'review';
  const second = await harness.run({ skill: COORDINATOR_SKILL, task: '收到完成消息，回读审阅' });
  assert.equal(second.record.runtime_status, 'completed');
  assert.equal(second.record.result?.tool_calls, 5);
  assert.deepEqual(second.record.result?.events.filter(event => event.type === 'tool').map(event => event.tool_call_id),
    ['updates', 'read-0', 'read-1', 'review-0', 'review-1']);
  assert.ok(center.state().every(job => job.status === 'completed'));
  assert.equal(second.record.result?.total_tokens, 60, '主模型用量不包含执行端');
});

test('对话入口保持可接受新消息，主模型决策串行，普通工作进度不触发模型', async t => {
  const { center } = await setup(t, { delay: 180 });
  let calls = 0, active = 0, maximum = 0;
  const conversation = new CenterConversation(center, async input => {
    calls++; active++; maximum = Math.max(maximum, active);
    await sleep(25);
    if (input.split('当前用户消息').at(-1)!.includes('发布首次任务')) await center.submit([task('conversation-a'), task('conversation-b')]);
    else await reviewAll(center);
    active--; return '按当前状态回复';
  });
  t.after(() => conversation.close());
  const first = conversation.send('发布首次任务');
  const second = conversation.send('查看当前事务');
  await Promise.all([first, second]); await conversation.settle();
  assert.equal(maximum, 1); assert.ok(calls >= 3 && calls <= 4);
  assert.ok(center.state().every(job => job.status === 'completed'));
});

test('IPC拒绝无凭据的连接，执行端不继承中心凭据，压缩保留任务和执行索引', async t => {
  const { center } = await setup(t);
  const server = new TaskCenterServer(center), env = await server.start();
  t.after(() => server.close());
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect(env.MINIMAL_AGENT_TASK_CENTER_SOCKET); let text = '';
    socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', op: 'get_task_updates', arguments: {} }) + '\n'));
    socket.on('data', data => { text += data; }); socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
  assert.match(reply, /凭据无效/);
  const previous = process.env.MINIMAL_AGENT_TASK_CENTER_TOKEN;
  process.env.MINIMAL_AGENT_TASK_CENTER_TOKEN = 'test-center-secret';
  t.after(() => { if (previous === undefined) delete process.env.MINIMAL_AGENT_TASK_CENTER_TOKEN; else process.env.MINIMAL_AGENT_TASK_CENTER_TOKEN = previous; });
  const launch = await createTaskAdapters().find(adapter => adapter.id === 'harness')!.launch(
    { agent: 'harness', skill: 'task-executor', task: '任务' }, { directory: '/tmp', workspace: '/tmp' });
  assert.equal(launch.env?.MINIMAL_AGENT_TASK_CENTER_TOKEN, undefined);
  const messages: any[] = [{ role: 'user', content: '回收任务' }, { role: 'tool', content: [{ type: 'tool-result',
    toolCallId: 'read', toolName: 'read_task_artifact', output: { type: 'json', value: {
      task_id: 'id', attempt_id: 'attempt', path: 'result.md', sha256: 'hash', content: 'x'.repeat(5000), next_offset: 3000,
    } } }] }];
  const evidence: any = collectEvidence(messages);
  assert.equal(evidence[0].result.attempt_id, 'attempt'); assert.equal(evidence[0].result.next_offset, 3000);
  assert.ok(!JSON.stringify(compactedMessages(messages, '继续审阅')).includes('x'.repeat(5000)));
});

test('主模型提交后一次请求失败不重启工作，完成消息仍能触发审阅', async t => {
  const { center } = await setup(t);
  let first = true, failures = 0;
  const conversation = new CenterConversation(center, async () => {
    if (first) { first = false; await center.submit([task('brain-failure-a'), task('brain-failure-b')]); throw new Error('离线模型503'); }
    await reviewAll(center); return '现有任务已审阅，未重新提交';
  }, () => {}, () => { failures++; });
  t.after(() => conversation.close());
  await assert.rejects(conversation.send('提交工作'), /503/);
  await conversation.settle();
  assert.equal(failures, 1);
  assert.equal(center.state().length, 2);
  assert.ok(center.state().every(job => job.status === 'completed' && job.attempts.length === 1));
});
