import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { VercelLoop, type Configuration } from './agent.js';
import { PythonBridge, ROOT, loadLocalEnv, redact } from './bridge.js';

loadLocalEnv();
if (!process.env.DEEPSEEK_API_KEY) {
  console.error('请先在项目 .env 填入 DEEPSEEK_API_KEY。');
  process.exit(1);
}
const bridge = new PythonBridge();
try {
  const config = await bridge.request<Configuration>('describe');
  const agent = new VercelLoop(bridge, config);
  const messages: ModelMessage[] = [];
  async function runTurn(prompt: string) {
    const turnStart = messages.length;
    messages.push({ role: 'user', content: prompt });
    const result = await agent.run(messages);
    if (result.error) messages.splice(turnStart);
    await mkdir(join(ROOT, 'reports'), { recursive: true });
    await writeFile(join(ROOT, 'reports/vercel-last-run.json'), redact(JSON.stringify({ prompt, ...result }, null, 2)));
    console.log(redact(result.answer ?? `本轮未完成：${result.error}`));
    const names = result.events.filter(event => event.type === 'tool').map(event => event.name);
    console.log(`模型请求 ${result.model_requests} 次，工具 ${result.tool_calls} 次，tokens ${result.total_tokens}`);
    if (names.length) console.log(`工具顺序：${names.join(' → ')}`);
  }
  const prompt = process.argv.slice(2).join(' ').trim();
  if (prompt) await runTurn(prompt);
  else {
    console.log(`Vercel AI SDK Agent，模型 ${config.model}；输入 /exit 退出。`);
    const input = createInterface({ input: process.stdin, output: process.stdout });
    if (process.stdin.isTTY) {
      input.setPrompt('你：');
      input.prompt();
    }
    for await (const line of input) {
      if (line.trim() === '/exit') break;
      if (line.trim()) await runTurn(line.trim());
      if (process.stdin.isTTY) input.prompt();
    }
    input.close();
  }
} catch (error) {
  console.error(redact(`启动或桥接失败：${(error as Error).name}`));
  process.exitCode = 1;
} finally { bridge.close(); }
