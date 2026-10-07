import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './bridge.js';

export const SKILLS_ROOT = join(ROOT, 'skills');
export interface Skill {
  name: string;
  description: string;
  instructions: string;
}

export async function loadSkill(name: string, root = SKILLS_ROOT): Promise<Skill> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Skill 名称只能包含小写字母、数字和连字符');
  const source = await readFile(join(root, name, 'SKILL.md'), 'utf8');
  // 本 Demo 只支持两个单行元数据字段，不引入完整 YAML 解析器。
  const parts = /^---\r?\nname: ([^\r\n]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n([\s\S]+)$/.exec(source);
  if (!parts || parts[1] !== name || !parts[2].trim() || !parts[3].trim()) {
    throw new Error('Skill 格式无效：name 必须等于目录名，并提供 description 和正文');
  }
  return { name, description: parts[2].trim(), instructions: parts[3].trim() };
}

export async function listSkills(root = SKILLS_ROOT): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  return Promise.all(names.map(name => loadSkill(name, root)));
}
