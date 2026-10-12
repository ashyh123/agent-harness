import { BlogAgent } from './blog_agent.js';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import type { Configuration } from './execution_runtime.js';
import { ObsidianKnowledge } from './obsidian_knowledge.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('用法：npm run blog:agent -- "https://博客地址"');
  loadLocalEnv();
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('请在.env配置DEEPSEEK_API_KEY');
  const bridge = new PythonBridge({ ...process.env,
    MINIMAL_AGENT_TASK_COORDINATION: '0', MINIMAL_AGENT_CODEX_DELEGATION: '0' });
  try {
    const config = await bridge.request<Configuration>('describe');
    const result = await new BlogAgent(bridge, config).run(args[0], notice => console.log(redact(notice)));
    console.log(redact(result.saved ? `已保存并回读核验：${result.receipt.note_path}`
      : `未完成保存：${result.record.result?.error ?? result.record.harness_error ?? '没有通过保存验收'}`));
    console.log(`运行记录：${result.directory}`);
    const usage = result.record.result;
    if (usage) console.log(`模型请求 ${usage.model_requests} 次，工具 ${usage.tool_calls} 次，tokens ${usage.total_tokens}`);
    if (!result.saved) process.exitCode = 1;
    else {
      try {
        const indexing = await new ObsidianKnowledge(result.receipt.vault_path, config).index(result.receipt.note_path);
        console.log(redact(`共同概念整理：${indexing.article_path}；额外tokens ${indexing.total_tokens}`));
      } catch (e) { console.log(redact(`博客已保存；共同概念整理未完成：${(e as Error).message}。可用 blog:index 单独重试。`)); }
    }
  } finally { bridge.close(); }
}
main().catch(error => { console.error(redact(error instanceof Error ? error.message : '博客 Agent 启动失败')); process.exitCode = 1; });
