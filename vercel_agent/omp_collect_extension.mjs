/** Daily OMP slash command. No model dispatch and no new agent loop. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('./', import.meta.url));

export function collectionUrl(args) {
  const input = args.trim();
  if (!input || /\s/.test(input)) throw new Error('用法：/collect https://博客地址（每次一篇）');
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请使用不含账号密码的HTTP(S)博客URL');
  return url.href;
}
export function formatCollection(r) {
  const title = r.status === 'complete' ? (r.existing ? '已有文章卡片，正文和链接保持原样' : '文章卡片已收录')
    : r.status === 'partial' ? '卡片已保存，简介待补充' : '文章卡片收录失败';
  return [title, r.note_path ? `笔记：${r.note_path}` : null,
    r.reading_status ? `阅读状态：${r.reading_status}` : null,
    r.topics?.length ? `主题：${r.topics.join('、')}` : null,
    typeof r.total_tokens === 'number' ? `用量：${r.usage_complete ? '' : '至少'}${r.total_tokens} tokens；${r.model_requests}次模型请求；${r.elapsed_seconds.toFixed(2)}秒` : null,
    r.error ? `原因：${r.error}` : null,
    r.record_path ? `记录：${r.record_path}` : null,
  ].filter(Boolean).join('\n');
}
export function startCollection(url) {
  const child = spawn('node', ['--import', 'tsx', 'collect_cli.ts', url],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let output = '', timedOut = false;
  const kill = signal => {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  let force;
  const cancel = () => { kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 1500); force.unref(); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 125000);
  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', data => { output += data; });
    // Keep raw provider diagnostics and secrets out of the OMP transcript.
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', () => {
      if (timedOut) return reject(new Error('收录执行超时；若笔记已生成，请保留并检查收录记录。'));
      try {
        const result = JSON.parse(output.trim());
        if (!['complete', 'partial', 'failed'].includes(result.status)) throw new Error('缺少收录状态');
        resolve(result);
      } catch { reject(new Error('收录进程未返回有效结果；请检查项目环境与收录记录。')); }
    });
  }).finally(() => { clearTimeout(timer); clearTimeout(force); });
  return { promise, cancel };
}

export default function (pi, start = startCollection) {
  let busy = false, running = null;
  pi.registerCommand('collect', {
    description: '制作待阅读文章卡片；已有卡片保留正文和链接：/collect URL',
    async handler(args, ctx) {
      if (busy) { ctx.ui.notify('当前博客正在收录，请等待本次结果。', 'warning'); return; }
      let url;
      try { url = collectionUrl(args); } catch (e) { ctx.ui.notify(e.message, 'error'); return; }
      busy = true;
      ctx.ui.notify('开始收录文章卡片，完成后会在这里显示结果。', 'info');
      ctx.ui.setStatus('blog-collect', '文章卡片收录中…');
      // Return the command immediately; keep slow network work outside handler deadlines.
      ctx.setTimeout(async () => {
        try {
          running = start(url);
          const result = await running.promise;
          pi.sendMessage({ customType: 'ashyh.blog-collection', display: true,
            content: formatCollection(result), details: result }, { triggerTurn: false });
        } catch (e) {
          pi.sendMessage({ customType: 'ashyh.blog-collection', display: true,
            content: `博客收录未完成：${e.message}`, details: { status: 'failed' } }, { triggerTurn: false });
        } finally { busy = false; running = null; ctx.ui.setStatus('blog-collect', undefined); }
      }, 0);
    },
  });
  pi.on('session_shutdown', () => { if (running) running.cancel(); });
}
