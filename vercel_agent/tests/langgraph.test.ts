import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openLangGraphBackend } from '../langgraph_backend.js';
import { fixtureHarness } from '../langgraph_fixture.js';
const input = { skill: 'calculation-audit', task: '计算123乘456' };
async function directory(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'langgraph-test-'));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function worker(dir: string, action: string, fault = '') {
  return spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/langgraph_worker.ts', import.meta.url)), dir, action, fault],
    { encoding: 'utf8', timeout: 30000 });
}
for (const fault of ['', 'after_receipt', 'after_delivery']) {
  test(`fresh process recovery: ${fault || 'approval pause'}`, async t => {
    const dir = await directory(t);
    const started = worker(dir, 'start', fault === 'after_receipt' ? fault : '');
    assert.equal(started.status, fault === 'after_receipt' ? 73 : 0, started.stderr);
    if (fault === 'after_receipt') {
      const recovered = worker(dir, 'resume'); assert.equal(recovered.status, 0, recovered.stderr);
    }
    await assert.rejects(readFile(join(dir, 'delivery.md')), /ENOENT/);
    const approved = worker(dir, 'approve', fault === 'after_delivery' ? fault : '');
    assert.equal(approved.status, fault === 'after_delivery' ? 73 : 0, approved.stderr);
    const before = await readFile(join(dir, 'delivery.md'), 'utf8');
    const beforeStat = await stat(join(dir, 'delivery.md'));
    const recovered = worker(dir, 'resume'); assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).status, 'delivered');
    assert.equal(await readFile(join(dir, 'delivery.md'), 'utf8'), before);
    const afterStat = await stat(join(dir, 'delivery.md'));
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'recovery must not write delivery again');
    assert.equal((await readdir(join(dir, 'harness'))).length, 1, 'executor must not rerun');
    const receipt = JSON.parse(await readFile(join(dir, 'execution.json'), 'utf8'));
    assert.equal(receipt.record.result.model_requests, 2);
    assert.equal(receipt.record.result.tool_calls, 1);
  });
}
test('same budget failure takes rejection branch without approval or delivery', async t => {
  const dir = await directory(t);
  const backend = await openLangGraphBackend(dir, input => fixtureHarness(join(dir, 'harness'), input, 1));
  try {
    const result = await backend.start(input);
    assert.equal(result.status, 'not_delivered');
    assert.equal(result.execution.record.result?.model_requests, 1);
    assert.equal(result.execution.record.result?.tool_calls, 1);
    await assert.rejects(readFile(join(dir, 'delivery.md')), /ENOENT/);
  } finally { backend.close(); }
});
test('deny approval and reject duplicate start', async t => {
  const dir = await directory(t);
  const backend = await openLangGraphBackend(dir, input => fixtureHarness(join(dir, 'harness'), input));
  try {
    await backend.start(input);
    await assert.rejects(backend.start(input), /already exists/);
    await assert.rejects(backend.resume(), /Approval required/);
    assert.equal((await backend.resume(false)).status, 'not_delivered');
    await assert.rejects(readFile(join(dir, 'delivery.md')), /ENOENT/);
  } finally { backend.close(); }
});
test('uncertain in-flight executor cannot silently reset budget and replay', async t => {
  const dir = await directory(t); let calls = 0;
  const backend = await openLangGraphBackend(dir, async () => { calls++; throw new Error('injected failure'); });
  try {
    await assert.rejects(backend.start(input), /injected failure/);
    await assert.rejects(backend.resume(), /Uncertain executor outcome/);
    assert.equal(calls, 1);
  } finally { backend.close(); }
});
test('side-effect skills rejected before executor', async t => {
  const dir = await directory(t);
  const backend = await openLangGraphBackend(dir, async () => { throw new Error('should not execute'); });
  try { await assert.rejects(backend.start({ skill: 'obsidian-blog-reader', task: 'save' }), /only supports/); }
  finally { backend.close(); }
});
test('existing failed_checks verdict cannot reach approval', async t => {
  const dir = await directory(t);
  const backend = await openLangGraphBackend(dir, async task => {
    const execution = await fixtureHarness(join(dir, 'harness'), task);
    execution.record.task_verdict = 'failed_checks';
    return execution;
  });
  try {
    assert.equal((await backend.start(input)).status, 'not_delivered');
    assert.equal((await backend.state()).tasks.some(task => task.interrupts?.length), false);
    await assert.rejects(readFile(join(dir, 'delivery.md')), /ENOENT/);
  } finally { backend.close(); }
});
