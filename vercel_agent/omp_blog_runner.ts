/** Loopback adapter for a controlled OMP-vs-LangGraph comparison. No agent loop here. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PythonBridge, ROOT, BridgeError, redact } from './bridge.js';
import { createExecutionRuntime, type Configuration } from './execution_runtime.js';
import { BLOG_TOOLS } from './blog_agent.js';
import { loadSkill } from './skills.js';
import { CONTEXT_INSTRUCTION } from './context.js';
import { blogSaveGuard } from './blog_evidence.js';
import { checkObsidianBlogReader } from './checks.js';

export function boundedPayload(input: any, config: Configuration) {
  if (!Array.isArray(input.messages)) throw new Error('Missing model messages');
  const names = input.tools?.map((t: any) => t.function?.name) ?? [];
  if (names.some((n: string) => !BLOG_TOOLS.has(n))) throw new Error('Unexpected OMP tool');
  return { ...input, model: config.model, max_tokens: config.max_output_tokens,
    max_completion_tokens: undefined, temperature: config.temperature ?? 0,
    thinking: { type: 'disabled' }, store: undefined,
    ...(names.length ? { tools: config.tools.filter(t => BLOG_TOOLS.has(t.name))
      .map(t => ({ type: 'function', function: t })) } : {}) };
}

export async function runOmpBlog(bridge: PythonBridge, config: Configuration, url: string,
  directory: string, fixtures: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  await mkdir(directory, { recursive: true });
  const skill = await loadSkill('obsidian-blog-reader');
  const instructions = `${config.system_prompt}\n\n当前选定 Skill：${skill.name}\n${skill.instructions}\n\n${CONTEXT_INSTRUCTION}`;
  const tools = config.tools.filter(t => BLOG_TOOLS.has(t.name));
  const runtime = createExecutionRuntime(bridge, { ...config, tools }, fetcher);
  const guard = blogSaveGuard(bridge, config);
  let receipt: any = null, fatal: string | null = null;
  let firstRequestAt = 0, lastToolAt = 0;
  const payloads: any[] = [];
  const token = randomUUID();
  const respond = (res: any, body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return respond(res, { error: 'unauthorized' }, 401);
    try {
      let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1_000_000) throw new Error('Payload too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === '/control') return respond(res, { model: config.model, max_output_tokens: config.max_output_tokens, tools, instructions });
      if (req.url === '/invalid') return respond(res, await bridge.request('invalid_tool', input));
      if (req.url === '/tool') {
        if (!BLOG_TOOLS.has(input.name) || receipt) throw new Error('Tool unavailable');
        const validation = await bridge.request('validate_tool', { name: input.name, arguments: input.arguments });
        let output: any;
        if (!validation.valid) output = await bridge.request('invalid_tool', input);
        else {
          const rejection = await guard({ toolName: input.name, input: input.arguments }, runtime);
          output = await bridge.request(rejection ? 'reject_tool' : 'call_tool', { ...input,
            ...(rejection ? { rejection } : {}) });
        }
        lastToolAt = performance.now();
        if (input.name === 'save_obsidian_blog' && output.verified === true) receipt = output;
        return respond(res, output);
      }
      if (req.url !== '/v1/chat/completions') return respond(res, { error: 'not_found' }, 404);
      if (receipt || fatal) return respond(res, { error: { message: 'Task already stopped', type: 'budget_exceeded' } }, 409);
      const payload = boundedPayload(input, config);
      payloads.push(payload);
      if (!firstRequestAt) firstRequestAt = performance.now();
      const reservation = await bridge.request('begin_model', { kind: 'omp' });
      let upstream: Response, text: string;
      try {
        upstream = await fetcher('https://api.deepseek.com/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(30, reservation.remaining_seconds) * 1000))),
        });
        // Buffer the unchanged SSE body to record all billed usage before tool dispatch.
        // End-to-end latency, not time-to-first-token, is measured in this experiment.
        text = await upstream.text();
      } catch (error) {
        await bridge.request('end_model', { event_id: reservation.event_id, error_type: (error as Error).name });
        throw error;
      }
      const frames = text.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      let json: any;
      if (!frames.length) { try { json = JSON.parse(text); } catch { /* record HTTP failure without exposing body */ } }
      const usage = [...frames].reverse().find(f => f.usage)?.usage ?? json?.usage;
      const reason = [...frames].reverse().find(f => f.choices?.[0]?.finish_reason)?.choices[0].finish_reason ?? json?.choices?.[0]?.finish_reason;
      await bridge.request('end_model', { event_id: reservation.event_id, usage: usage ?? null,
        finish_reason: reason ?? null, ...(upstream.ok ? {} : { error_type: 'HTTPError', status_code: upstream.status }) });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' }); res.end(text);
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : 'adapter_error';
      if (code === 'budget_exceeded') fatal = (error as Error).message;
      respond(res, { error: { code, message: code === 'budget_exceeded' ? fatal : (error as Error).name } },
        req.url === '/tool' ? 200 : 400);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const overlay = join(directory, 'config.yml');
  await writeFile(overlay, `startup:\n  quiet: true\n  showSplash: false\npersonality: none\nincludeModelInPrompt: false\nretry:\n  enabled: false\n  modelFallback: false\nadvisor:\n  enabled: false\nmemory:\n  backend: off\nautolearn:\n  enabled: false\ncompaction:\n  enabled: true\n  asyncEnabled: false\n  methodOrder: [soft]\n  thresholdTokens: 12000\n  keepRecentTokens: 2000\n  reserveTokens: 512\n`);
  const env: NodeJS.ProcessEnv = Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR'].map(k => [k, process.env[k]]));
  Object.assign(env, { PI_CODING_AGENT_DIR: join(directory, 'omp-state'),
    OMP_BLOG_BRIDGE: `http://127.0.0.1:${address.port}`, OMP_BLOG_TOKEN: token });
  const started = performance.now();
  await bridge.request('start', { fixtures, limits: { max_steps: config.max_steps, max_model_requests: config.max_model_requests,
    max_tool_calls: config.max_tool_calls, max_seconds: config.max_seconds } });
  let output = '', errors = '', exit: number | null = null, timedOut = false;
  try {
    const child = spawn(join(process.env.HOME!, '.local/bin/omp'), ['--print', '--mode', 'json', '--no-tools', '--no-lsp',
      '--no-skills', '--no-rules', '--no-extensions', '--no-title', '--no-session', '--thinking', 'off',
      '--approval-mode', 'yolo', // Explicit benchmark authorization; only the four curated tools are active.
      '--config', overlay, '--extension', join(ROOT, 'vercel_agent/omp_blog_extension.mjs'),
      '--model', `blog-benchmark/${config.model}`, '--max-time', `${config.max_seconds}s`,
      '--system-prompt', instructions,
      `读取这篇博客，简化核心内容、提炼一个 Agent 改进启发，并实际保存到 Obsidian。来源：${url}`],
    { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    let hardStop: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
      hardStop = setTimeout(() => child.kill('SIGKILL'), 2000); }, config.max_seconds * 1000);
    try { exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timeout); clearTimeout(hardStop); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const trace = await bridge.request('trace');
  const checks = checkObsidianBlogReader(receipt?.note_path ?? '', trace.events);
  await writeFile(join(directory, 'omp-events.jsonl'), redact(output));
  await writeFile(join(directory, 'omp-stderr.txt'), redact(errors));
  await writeFile(join(directory, 'model-payloads.json'), redact(JSON.stringify(payloads, null, 2)));
  return { saved: !!receipt && checks.passed && !timedOut && !fatal, receipt, checks, trace,
    exit_code: exit, timed_out: timedOut, error: fatal ?? (timedOut ? 'process_timeout' : receipt ? null : 'no_verified_save'),
    elapsed_seconds: (performance.now() - started) / 1000,
    model_to_save_seconds: receipt && firstRequestAt ? (lastToolAt - firstRequestAt) / 1000 : null,
    model_payload_count: payloads.length };
}
