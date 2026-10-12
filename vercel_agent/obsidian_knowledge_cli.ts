import { join } from 'node:path';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import { ObsidianKnowledge } from './obsidian_knowledge.js';
loadLocalEnv();
(globalThis as any).AI_SDK_LOG_WARNINGS = false;
const paths = process.argv.slice(2);
if (!paths.length) throw new Error('用法：npm run blog:index -- /absolute/path/to/阅读笔记.md [更多笔记...]');
const bridge = new PythonBridge();
try {
  const config = await bridge.request('describe');
  const vault = process.env.MINIMAL_AGENT_OBSIDIAN_VAULT ?? join(process.env.HOME!, 'Documents/Obsidian/Agent 博客阅读');
  const indexer = new ObsidianKnowledge(vault, config);
  for (const path of paths) {
    try { console.log(redact(JSON.stringify(await indexer.index(path)))); }
    catch (e) { console.error(redact(`关联整理失败：${(e as Error).message}`)); process.exitCode = 1; }
  }
} finally { bridge.close(); }
