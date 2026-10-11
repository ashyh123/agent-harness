import { join } from 'node:path';
import type { Configuration } from './agent.js';

export const PERSON_SKILL = 'person-agent';
export const PERSON_MAX_SECONDS = 360;
export const COORDINATOR_SKILL = 'task-coordinator';

export function harnessEnvironment(skill: string, workspace?: string): NodeJS.ProcessEnv {
  const person = skill === PERSON_SKILL;
  return { ...process.env, MINIMAL_AGENT_CODEX_DELEGATION: person ? '1' : '0',
    MINIMAL_AGENT_TASK_COORDINATION: skill === COORDINATOR_SKILL && process.env.MINIMAL_AGENT_TASK_CENTER_SOCKET ? '1' : '0',
    MINIMAL_AGENT_NODE_BIN: process.execPath,
    ...(person && workspace ? { MINIMAL_AGENT_TASK_ROOT: join(workspace, 'delegated') } : {}),
  };
}
export function harnessConfiguration(config: Configuration, skill: string): Configuration {
  if (skill === COORDINATOR_SKILL) return { ...config, max_steps: 8, max_model_requests: 12,
    max_tool_calls: 16, max_seconds: 180, max_output_tokens: 2048,
    context_policy: { ...config.context_policy, trigger_tokens: 40000, target_tokens: 28000 } };
  if (skill === 'task-executor') return { ...config, max_output_tokens: 1024 };
  // 委派工具的描述与子任务文件索引需要更多空间；不丢弃必须保留的交接资料。
  return skill === PERSON_SKILL ? { ...config, max_seconds: PERSON_MAX_SECONDS,
    context_policy: { ...config.context_policy, trigger_tokens: 24_000, target_tokens: 16_000 } } : config;
}
