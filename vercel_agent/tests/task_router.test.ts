import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskAdapters } from '../task_adapters.js';
import { TaskRouter, taskDate, type AgentId } from '../task_router.js';
import { ROOT } from '../bridge.js';

// 本地假CLI走真实的进程/JSONL/文件协议，不调用模型或搜索服务。
async function fixture(t: TestContext, body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'minimal-router-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}\n`
    + `import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';\n`
    + `import { spawn } from 'node:child_process';\n`
    + `import { join } from 'node:path';\n`
    + `let input = ''; for await (const chunk of process.stdin) input += chunk;\n`
    + `const args = process.argv.slice(2);\n`
    + `const emit = event => console.log(JSON.stringify(event));\n`
    + `const complete = async (text = '已完成') => {\n`
    + `  await writeFile(args[args.indexOf('--output-last-message') + 1], text);\n`
    + `  emit({type:'thread.started',thread_id:'offline-session'});\n`
    + `  emit({type:'item.completed',item:{type:'agent_message',text}});\n`
    + `  emit({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});\n`
    + `};\n` + body, { mode: 0o700 });
  const root = join(directory, 'runs');
  const adapters = createTaskAdapters({ codexBinary: executable });
  return { directory, root, adapters, executable, router: new TaskRouter(adapters, root, () => new Date('2026-10-08T16:30:00Z')) };
}

test('手动分发Codex，回收真实文件和hash，同一天两次运行不覆盖', async t => {
  const { router, directory } = await fixture(t, `
    await mkdir('nested');
    await writeFile('nested/result.json', JSON.stringify({value:56088}));
    await writeFile('report.md', '# Result\\n56088');
    await writeFile('invocation.json', JSON.stringify({input,args,cwd:process.cwd(),deepseek:process.env.DEEPSEEK_API_KEY ?? null}));
    await complete('结果56088，保存了report.md和nested/result.json');
  `);
  const marker = join(directory, 'must-not-exist');
  const task = '计算并保存；$(touch ' + marker + ') `touch ' + marker + '`';
  const first = await router.run({ agent: 'codex', task, expected_files: ['report.md', 'nested/result.json'] });
  const second = await router.run({ agent: 'codex', task: '另一个独立任务' });
  assert.equal(first.record.status, 'completed');
  assert.equal(first.record.task_verdict, 'needs_review', '退出成功不能自动证明任务语义正确');
  assert.equal(first.record.session_id, 'offline-session');
  assert.deepEqual(first.record.usage, { input_tokens: 10, output_tokens: 5 });
  assert.notEqual(first.directory, second.directory);
  assert.match(first.directory, /codex\/2026-10-09\//);
  const invocation = JSON.parse(await readFile(join(first.record.workspace, 'invocation.json'), 'utf8'));
  assert.equal(invocation.cwd, first.record.workspace);
  assert.ok(invocation.input.includes(task), '任务通过stdin按原文传递');
  assert.equal(invocation.deepseek, null);
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(invocation.args[invocation.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(!invocation.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const bytes = await readFile(join(first.record.workspace, 'nested/result.json'));
  const artifact = first.record.artifacts.find(file => file.path === 'nested/result.json')!;
  assert.equal(artifact.bytes, bytes.length);
  assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(join(first.directory, 'task.json'), 'utf8')), first.record);
  assert.equal((await router.runs()).length, 2);
});

test('没有结束事件、错误事件、非零退出、空回答均不能冒充完成', async t => {
  for (const body of [
    `emit({type:'item.completed',item:{type:'agent_message',text:'不完整'}});`,
    `emit({type:'turn.failed',error:{message:'失败'}}); await complete();`,
    `await complete(); process.exitCode = 3;`,
    `await complete('');`,
  ]) {
    const { router } = await fixture(t, body);
    const { record } = await router.run({ agent: 'codex', task: '验收失败分支' });
    assert.equal(record.status, 'failed');
    assert.equal(record.task_verdict, 'not_completed');
    assert.ok(record.error);
  }
});

test('文件缺失或指向外部的符号链接使文件检查失败，不读取外部内容', async t => {
  const { router, directory } = await fixture(t, `
    await symlink(input.split('EXTERNAL=')[1].trim(), 'report.md');
    await complete('声称生成了report.md');
  `);
  const external = join(directory, 'outside.md');
  await writeFile(external, '外部文件，不能作为任务产物收录');
  const { record } = await router.run({ agent: 'codex', task: `EXTERNAL=${external}`, expected_files: ['report.md', 'absent.json'] });
  assert.equal(record.status, 'completed');
  assert.equal(record.task_verdict, 'failed_checks');
  assert.deepEqual(record.missing_files, ['report.md', 'absent.json']);
  assert.deepEqual(record.skipped_paths, ['report.md']);
  assert.deepEqual(record.artifacts, []);
});

test('超时终止进程组并保留已有产物，不因主进程先退出而遗留子进程', async t => {
  const { router } = await fixture(t, `
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio:'ignore'});
    child.unref();
    await writeFile('child.pid', String(child.pid));
    await writeFile('partial.md', '尚未完成');
    setInterval(() => {}, 1000);
  `);
  const { record } = await router.run({ agent: 'codex', task: '超时任务', timeout_seconds: 1 });
  const pid = Number(await readFile(join(record.workspace, 'child.pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已结束 */ } });
  assert.equal(record.status, 'timed_out');
  assert.equal(record.task_verdict, 'not_completed');
  assert.ok(record.artifacts.some(file => file.path === 'partial.md'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('取消任务有明确状态，不等待预算到期', async t => {
  const { router } = await fixture(t, 'setInterval(() => {}, 1000);');
  const abort = new AbortController();
  const { record } = await router.run({ agent: 'codex', task: '取消任务', timeout_seconds: 30 }, {
    signal: abort.signal, onStatus: record => { if (record.status === 'running') abort.abort(); },
  });
  assert.equal(record.status, 'cancelled');
  assert.equal(record.task_verdict, 'not_completed');
});

test('stdout协议错误保存证据并报告失败；启动失败也留下任务记录', async t => {
  const { router, adapters, root } = await fixture(t, `console.log('非法stdout'); await complete();`);
  const bad = await router.run({ agent: 'codex', task: '协议错误' });
  assert.equal(bad.record.status, 'failed');
  assert.match(bad.record.error!, /JSONL/);
  assert.match(await readFile(join(bad.directory, 'events.jsonl'), 'utf8'), /router.invalid_output/);
  const codex = adapters.find(adapter => adapter.id === 'codex')!;
  const broken = new TaskRouter([{ ...codex, launch: async () => ({ executable: '/nonexistent/router-fixture', args: [], stdin: '任务' }) }], root);
  const start = await broken.run({ agent: 'codex', task: '启动失败' });
  assert.equal(start.record.status, 'failed');
  assert.match(start.record.error!, /启动失败/);
  assert.ok(start.record.finished_at);
});

test('非法Agent、文件路径、超时和缺少Skill在启动前拒绝', async t => {
  const { router, root } = await fixture(t, 'await complete();');
  await assert.rejects(router.run({ agent: 'unknown' as AgentId, task: '任务' }), /已注册/);
  await assert.rejects(router.run({ agent: 'codex', task: ' ' }), /不能为空/);
  for (const file of ['/tmp/outside.md', '../outside.md', 'sub/../../outside.md', 'sub\\file', './file']) {
    await assert.rejects(router.run({ agent: 'codex', task: '任务', expected_files: [file] }), /相对路径/);
  }
  await assert.rejects(router.run({ agent: 'codex', task: '任务', timeout_seconds: 0 }), /超时/);
  await assert.rejects(router.run({ agent: 'codex', task: '任务', skill: 'webpage-reader' }), /仅用于harness/);
  await assert.rejects(router.run({ agent: 'harness', task: '任务' }), /需要--skill/);
  await assert.rejects(router.run({ agent: 'harness', task: '任务', skill: '../outside' }), /Skill 名称/);
  await assert.rejects(readdir(root), { code: 'ENOENT' });
  assert.equal(taskDate(new Date('2026-10-08T16:30:00Z')), '2026-10-09');
});

test('已知环境凭据从入口日志、回答及任务元数据中脱敏', async t => {
  const before = process.env.MINIMAL_AGENT_TEST_SECRET;
  process.env.MINIMAL_AGENT_TEST_SECRET = 'offline-secret-do-not-save';
  t.after(() => { if (before === undefined) delete process.env.MINIMAL_AGENT_TEST_SECRET; else process.env.MINIMAL_AGENT_TEST_SECRET = before; });
  const { router } = await fixture(t, `
    const secret = process.env.MINIMAL_AGENT_TEST_SECRET;
    emit({type:'notice',text:secret}); console.error(secret); await complete(secret);
  `);
  const { record, directory } = await router.run({ agent: 'codex', task: 'offline-secret-do-not-save' });
  assert.equal(record.answer, '[REDACTED]');
  for (const file of ['task.json', 'events.jsonl', 'stderr.log', 'answer.md', 'last-message.txt', 'prompt.txt']) {
    const text = await readFile(join(directory, file), 'utf8');
    assert.ok(!text.includes('offline-secret-do-not-save'), file);
  }
});

test('Harness的原有验收失败仍保留，不被入口覆盖为成功', async t => {
  const { adapters, directory } = await fixture(t, 'await complete();');
  const harness = adapters.find(adapter => adapter.id === 'harness')!;
  const result = await harness.result([{ type: 'harness.result', runtime_status: 'completed', task_verdict: 'failed_checks',
    answer: '没有取得文章正文', usage: { model_requests: 2, tool_calls: 1, total_tokens: 100 } }], { directory, workspace: join(directory, 'workspace') });
  assert.equal(result.completed, true);
  assert.equal(result.task_verdict, 'failed_checks');
  assert.equal(result.usage?.model_requests, 2);
});

test('父任务超时同时终止嵌套路由器、Codex和忽略SIGTERM的子进程', async t => {
  const { root, executable } = await fixture(t, `
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    child.unref();await writeFile('child.pid',String(child.pid));setInterval(()=>{},1000);
  `);
  const router = new TaskRouter([{
    id: 'harness', description: '嵌套取消测试', validate: async () => {},
    launch: async (_task, paths) => ({ executable: process.execPath,
      args: [join(ROOT, 'vercel_agent/node_modules/tsx/dist/cli.mjs'), join(ROOT, 'vercel_agent/router_cli.ts'),
        'run', '--agent', 'codex', '--json', '--task-file', '-', '--timeout', '30'], stdin: '子任务',
      env: { ...process.env, MINIMAL_AGENT_CODEX_BIN: executable, MINIMAL_AGENT_CODEX_SUBTASK: '1',
        MINIMAL_AGENT_TASK_ROOT: join(paths.workspace, 'delegated') } }),
    result: async () => ({ completed: false, answer: null, error: '已取消' }),
  }], root);
  const { record } = await router.run({ agent: 'harness', task: '父任务', timeout_seconds: 2 });
  assert.equal(record.status, 'timed_out');
  const file = record.artifacts.find(artifact => artifact.path.endsWith('/child.pid'));
  assert.ok(file, '确实启动了嵌套子进程');
  const pid = Number(await readFile(join(record.workspace, file.path), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* 已终止 */ } });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
