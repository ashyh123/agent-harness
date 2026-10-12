import { collectBlog } from './collect_blog.js';
import { loadLocalEnv, redact } from './bridge.js';
loadLocalEnv();
(globalThis as any).AI_SDK_LOG_WARNINGS = false;
try {
  if (process.argv.length !== 3) throw new Error('用法：collect_cli.ts https://博客地址');
  const result = await collectBlog(process.argv[2], { onNotice: text => console.error(redact(text)) });
  console.log(redact(JSON.stringify(result)));
  process.exitCode = result.status === 'complete' ? 0 : result.status === 'partial' ? 2 : 1;
} catch (e) {
  console.log(redact(JSON.stringify({ status: 'failed', error: (e as Error).message })));
  process.exitCode = 1;
}
