import { resolve, join } from 'node:path';
import { openLangGraphBackend } from './langgraph_backend.js';
import { MinimalHarness } from './harness.js';
import { PythonBridge, loadLocalEnv, redact } from './bridge.js';
import { SKILLS_ROOT } from './skills.js';
import { harnessConfiguration, harnessEnvironment } from './person_profile.js';
import type { Configuration } from './agent.js';

async function main() {
  const [action, path, ...args] = process.argv.slice(2);
  if (!path || !['start', 'resume', 'status'].includes(action)) throw new Error('Usage: langgraph start <directory> <task> | resume <directory> [approve|reject] | status <directory>');
  if (action === 'resume' && (args.length > 1 || (args.length && !['approve', 'reject'].includes(args[0])))) throw new Error('Expected approve or reject');
  // No model, bridge or .env access during status/approval recovery.
  const directory = resolve(path);
  const backend = await openLangGraphBackend(directory, async input => {
    loadLocalEnv();
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY required');
    const bridge = new PythonBridge(harnessEnvironment(input.skill));
    try {
      const base = harnessConfiguration(await bridge.request<Configuration>('describe'), input.skill);
      const config = { ...base, tools: base.tools.filter(tool => tool.name === 'calculate') };
      return await new MinimalHarness(bridge, config, { skills: SKILLS_ROOT, runs: join(directory, 'harness') }).run(input);
    } finally { bridge.close(); }
  });
  try {
    const result = action === 'start' ? await backend.start({ skill: 'calculation-audit', task: args.join(' ') })
      : action === 'resume' ? await backend.resume(args.length ? args[0] === 'approve' : undefined) : await backend.state();
    console.log(redact(JSON.stringify(result, null, 2)));
  } finally { backend.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
