/** URL-stable article cards. Once created, the whole note belongs to the user. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const EMPTY_BRIEF = '暂无自动简介，打开原文后可自行补充。';
export function cardIdentity(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请提供不含账号密码的 HTTP(S) URL');
  url.hash = '';
  const id = createHash('sha256').update(url.href).digest('hex').slice(0, 12);
  const slug = `${url.hostname}-${url.pathname.split('/').filter(Boolean).at(-1) ?? 'article'}`
    .replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 70);
  return { url: url.href, filename: `${slug}--${id}.md` };
}
async function safe(path: string): Promise<void> {
  const absolute = resolve(path);
  if (dirname(absolute) !== absolute) await safe(dirname(absolute));
  const stat = await lstat(absolute).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat?.isSymbolicLink()) throw new Error(`不写入或读取符号链接：${absolute}`);
}
function field(text: string, name: string) {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  const value = header.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
  try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ''); }
}
function info(text: string) {
  const section = text.match(/^## 简介\s*\n([\s\S]*?)(?=^## |$)/m)?.[1]?.trim() ?? '';
  const brief = section.split(/\n\s*\n/)[0];
  const tags = field(text, 'tags');
  return { title: String(field(text, 'title')), reading_status: String(field(text, 'status') || '待阅读'),
    topics: Array.isArray(tags) ? tags.filter((v): v is string => typeof v === 'string') : [],
    brief_available: !!brief && brief !== EMPTY_BRIEF };
}
export async function findCard(vault: string, url: string) {
  const identity = cardIdentity(url), directory = join(resolve(vault), '文章卡片');
  await safe(directory);
  const matches = async (path: string) => {
    await safe(path);
    const text = await readFile(path, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!text) return null;
    try {
      return cardIdentity(String(field(text, 'source'))).url === identity.url ? { path, ...info(text) } : null;
    } catch { return null; }
  };
  const exact = await matches(join(directory, identity.filename));
  if (exact) return exact;
  // Users may rename or group cards; source remains the stable identity.
  async function walk(folder: string): Promise<Awaited<ReturnType<typeof matches>>> {
    await safe(folder);
    const entries = await readdir(folder, { withFileTypes: true }).catch(e => {
      if (e.code === 'ENOENT') return []; throw e;
    });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = join(folder, entry.name);
      const found = entry.isDirectory() ? await walk(path)
        : entry.isFile() && entry.name.endsWith('.md') ? await matches(path) : null;
      if (found) return found;
    }
    return null;
  }
  return walk(directory);
}
export async function createCard(vault: string, url: string, draft: {
  title: string; brief: string; topics: string[]; scope: string;
}) {
  const existing = await findCard(vault, url);
  if (existing) return { ...existing, existing: true };
  const identity = cardIdentity(url), directory = join(resolve(vault), '文章卡片');
  await safe(directory);
  await mkdir(directory, { recursive: true });
  const path = join(directory, identity.filename);
  const title = draft.title.replace(/[\r\n]/g, ' ').trim().slice(0, 180) || identity.url;
  const properties = { type: 'article-card', source: identity.url, title, status: '待阅读',
    tags: draft.topics, preview_scope: draft.scope,
    created: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) };
  const text = '---\n' + Object.entries(properties).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
    + `\n---\n\n# ${title}\n\n[打开原文](<${identity.url}>)\n\n`
    + '自动简介用于选文，依据仅为标题和短预览。正文、状态和链接可由你自由编辑。\n\n'
    + `## 简介\n\n${draft.brief || EMPTY_BRIEF}\n\n## 我的笔记\n\n\n## 相关笔记\n\n`;
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx' });
  try { await link(temporary, path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const concurrent = await findCard(vault, url);
    if (!concurrent) throw new Error(`目标文件已有不同内容，未覆盖：${path}`);
    return { ...concurrent, existing: true };
  } finally { await unlink(temporary); }
  return { path, ...info(text), existing: false };
}
