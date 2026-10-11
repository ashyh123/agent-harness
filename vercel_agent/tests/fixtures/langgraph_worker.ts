import { join } from 'node:path';
import { openLangGraphBackend } from '../../langgraph_backend.js';
import { fixtureHarness } from '../../langgraph_fixture.js';
const [directory, action, fault] = process.argv.slice(2);
const backend = await openLangGraphBackend(directory, input => fixtureHarness(join(directory, 'harness'), input),
  point => { if (point === fault) process.exit(73); });
try {
  const result = action === 'start' ? await backend.start({ skill: 'calculation-audit', task: '计算123乘456' })
    : await backend.resume(action === 'approve' ? true : undefined);
  console.log(JSON.stringify(result));
} finally { backend.close(); }
