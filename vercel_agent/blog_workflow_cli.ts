import { BlogWorkflow } from './blog_workflow.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';
import type { Configuration } from './execution_runtime.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ObsidianKnowledge } from './obsidian_knowledge.js';

async function main() {
  // Schema compatibility is documented; keep SDK transport diagnostics out of the blog UI.
  (globalThis as any).AI_SDK_LOG_WARNINGS = false;
  if (process.argv.length !== 3) throw new Error('用法：npm run blog -- "https://博客地址"（自主回查与修正用 blog:agent）');
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在.env配置DEEPSEEK_API_KEY');
  const bridge = new PythonBridge({ ...process.env,
    MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0' });
  try {
    const config = await bridge.request<Configuration>('describe');
    const started = performance.now();
    const result = await new BlogWorkflow(bridge, config).run(process.argv[2], { onNotice: console.log });
    const elapsed_seconds = (performance.now() - started) / 1000;
    let indexing: unknown = null;
    const directory = join(ROOT, 'reports/blog-workflow');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'last-run.json'), redact(JSON.stringify({ result, elapsed_seconds }, null, 2)) + '\n');
    console.log(redact(result.saved ? `证据核对通过，已保存并回读核验：${result.receipt.note_path}` : `未完成保存：${result.error}`));
    console.log(`模型请求 ${result.model_requests} 次，工具 ${result.tool_calls} 次，tokens ${result.total_tokens}`);
    console.log(`耗时 ${elapsed_seconds.toFixed(2)} 秒；最近一轮记录：${join(directory, 'last-run.json')}`);
    if (!result.saved) process.exitCode = 1;
    else {
      try {
        const indexed = await new ObsidianKnowledge(result.receipt.vault_path, config).index(result.receipt.note_path);
        indexing = indexed;
        console.log(redact(`共同概念整理：${indexed.article_path}；额外tokens ${indexed.total_tokens}`));
      } catch (e) {
        indexing = { status: 'failed', error: (e as Error).message };
        console.log(redact(`博客已保存；共同概念整理未完成：${(e as Error).message}。可用 blog:index 单独重试。`));
      }
    }
    await writeFile(join(directory, 'last-run.json'), redact(JSON.stringify({ result, elapsed_seconds, indexing,
      total_elapsed_seconds: (performance.now() - started) / 1000 }, null, 2)) + '\n');
    if (result.saved) console.log(`含概念整理总耗时 ${((performance.now() - started) / 1000).toFixed(2)} 秒`);
  } finally { bridge.close(); }
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
