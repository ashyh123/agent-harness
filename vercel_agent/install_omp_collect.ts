import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadLocalEnv } from './bridge.js';
loadLocalEnv();
const root = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME!, '.omp/agent');
const directory = join(root, 'extensions');
const path = join(directory, 'blog-collect.js');
const module = new URL('./omp_collect_extension.mjs', import.meta.url).href;
const content = '// Blog collection command; implementation remains in the agent-harness project.\n'
  + `export { default } from ${JSON.stringify(module)};\n`;
await mkdir(directory, { recursive: true });
const existing = await readFile(path, 'utf8').catch(e => {
  if (e.code === 'ENOENT') return null; throw e;
});
// The initial installation encoded '+' as %2B; both name the same local module.
const sameEncodedPath = content.replace(module, module.replace(/\+/g, '%2B'));
if (existing !== null && existing !== content && existing !== sameEncodedPath)
  throw new Error(`已有不同扩展，未覆盖：${path}`);
if (existing === null) await writeFile(path, content, { flag: 'wx' });
const skillDirectory = join(root, 'skills/obsidian-study');
const skillPath = join(skillDirectory, 'SKILL.md');
const vault = process.env.MINIMAL_AGENT_OBSIDIAN_VAULT ?? join(process.env.HOME!, 'Documents/Obsidian/Agent 博客阅读');
const skill = (await readFile(new URL('./omp-skills/obsidian-study/SKILL.md', import.meta.url), 'utf8'))
  .replace('__VAULT_PATH__', vault);
await mkdir(skillDirectory, { recursive: true });
const oldSkill = await readFile(skillPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
if (oldSkill !== null && oldSkill !== skill) throw new Error(`已有不同 Skill，未覆盖：${skillPath}`);
if (oldSkill === null) await writeFile(skillPath, skill, { flag: 'wx' });
console.log(`已安装 /collect：${path}\n已安装 obsidian-study：${skillPath}\n重新启动 OMP 后使用 /collect URL，或 /skill:obsidian-study 你的学习任务`);
