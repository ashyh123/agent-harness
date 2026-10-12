import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPayload } from '../omp_blog_runner.js';
import type { Configuration } from '../execution_runtime.js';
import { runOmpBlog } from '../omp_blog_runner.js';
import { PythonBridge, ROOT } from '../bridge.js';
import { mkdtemp, realpath, rm, readFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('OMP comparison forces the same model, output cap, temperature and tool schemas, rejects extra tools', () => {
  const config = { model: 'same-model', max_output_tokens: 512, temperature: 0,
    tools: [{ name: 'read_webpage', description: 'shared', parameters: { type: 'object' } }] } as Configuration;
  const input = { model: 'different', max_tokens: 8192, max_completion_tokens: 8192, temperature: 1,
    messages: [{ role: 'user', content: 'read' }], stream: true,
    tools: [{ type: 'function', function: { name: 'read_webpage', description: 'different' } }] };
  const output = boundedPayload(input, config);
  assert.equal(output.model, 'same-model'); assert.equal(output.max_tokens, 512);
  assert.equal(output.max_completion_tokens, undefined); assert.equal(output.temperature, 0);
  assert.equal(output.tools[0].function.description, 'shared'); assert.equal(output.stream, true);
  assert.deepEqual(output.thinking, { type: 'disabled' }); assert.deepEqual(output.messages, input.messages);
  assert.throws(() => boundedPayload({ ...input, tools: [{ function: { name: 'bash' } }] }, config));
});

test('installed OMP really selects shared tools, includes evidence-gate cost and stops after verified save', async t => {
  try { await access(join(process.env.HOME!, '.local/bin/omp')); } catch { t.skip('OMP not installed'); return; }
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'omp-integration-')));
  const env = { ...process.env, MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0',
    MINIMAL_AGENT_WEBPAGE_STORE_DIR: join(dir, 'snapshots'), MINIMAL_AGENT_OBSIDIAN_VAULT: join(dir, 'vault') };
  const id = execFileSync(join(ROOT, '.venv/bin/python'), ['-c',
    'from tool_library.webpage_store import save_webpage; print(save_webpage(url="https://example.com/blog", title="Tools", content="An agent uses tools in a loop. " * 100, footnotes_found=0, coverage_note="Not verified."))'],
    { cwd: ROOT, env, encoding: 'utf8' }).trim();
  const bridge = new PythonBridge(env);
  t.after(async () => { bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const config = await bridge.request<Configuration>('describe');
  let calls = 0, reviews = 0;
  const draft = { document_id: id, summary: '文章介绍模型使用工具并观察工具结果，将反馈用于下一轮任务判断，从而形成执行循环。',
    takeaway: '我的推论：应保留工具结果，便于回查和验收。', evidence_quote: 'An agent uses tools in a loop.' };
  const fake: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) {
      reviews++;
      return new Response(JSON.stringify({ id: 'review', object: 'chat.completion', created: 1, model: config.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
          checks: ['summary_facts', 'quote_supports_core', 'takeaway_is_inference'].map(id => ({ id, verdict: 'supported', reason: '真实原文' })),
          core_match: { claim: '模型使用工具', evidence_field: 'evidence_quote' }, risk_checks: [],
        }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }),
        { headers: { 'content-type': 'application/json' } });
    }
    const turn = calls++;
    const first = turn === 0;
    const args = first ? { url: 'https://example.com/blog' } : turn === 1 ? { ...draft, evidence_quote: 'x'.repeat(233) } : draft;
    const chunk = { id: 'fake', object: 'chat.completion.chunk', created: 1, model: config.model };
    const frames = [
      { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-'+turn, type: 'function',
        function: { name: first ? 'read_webpage' : 'save_obsidian_blog', arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { ...chunk, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    ];
    return new Response(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await runOmpBlog(bridge, config, 'https://example.com/blog', join(dir, 'run'), {
    read_webpage: { document_id: id, url: 'https://example.com/blog', content: 'An agent uses tools in a loop.',
      total_chars: 3000, truncated: true, content_format: 'text' },
  }, fake);
  assert.equal(result.saved, true, JSON.stringify({ error: result.error, exit: result.exit_code }));
  assert.equal(calls, 3, 'OMP executes its own model/tool turns, no post-save model request');
  assert.equal(reviews, 1); assert.equal(result.trace.model_requests, 4);
  assert.equal(result.trace.events.reduce((n: number, e: any) => n + (e.usage?.total_tokens ?? 0), 0), 80);
  assert.equal(result.trace.tool_calls, 3, 'local parameter rejection consumes the shared tool budget');
  assert.ok(result.trace.events.some((e: any) => e.type === 'tool' && e.result?.error?.code === 'sdk_validation_error'));
  assert.match(await readFile(result.receipt.note_path, 'utf8'), /保留工具结果/);
});
