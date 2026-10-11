/** Durable task-phase backend. The existing model/tool loop remains the executor. */
import { Annotation, StateGraph, START, END, interrupt, Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessRecord, TaskInput } from './harness.js';

export interface Execution { directory: string; record: HarnessRecord }
export type Executor = (input: TaskInput) => Promise<Execution>;
const State = Annotation.Root({
  input: Annotation<TaskInput>(),
  execution: Annotation<Execution>(),
  approved: Annotation<boolean>(),
  status: Annotation<string>(),
});

async function json(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function atomic(path: string, body: string) {
  await writeFile(path + '.tmp', body, { mode: 0o600 });
  await rename(path + '.tmp', path);
}

/** One local caller per database. Side-effect tools are deliberately excluded in v1. */
export async function openLangGraphBackend(directory: string, execute: Executor,
  fault?: (point: 'after_receipt' | 'after_delivery') => void) {
  if ([process.env.LANGSMITH_TRACING, process.env.LANGCHAIN_TRACING_V2, process.env.LANGCHAIN_TRACING].some(value => value?.toLowerCase() === 'true')) {
    throw new Error('Disable LangSmith tracing for this local backend');
  }
  await mkdir(directory, { recursive: true });
  const saver = SqliteSaver.fromConnString(join(directory, 'checkpoints.sqlite'));
  const graph = new StateGraph(State)
    .addNode('execute', async state => {
      if (state.input.skill !== 'calculation-audit' || !state.input.task.trim()) {
        throw new Error('LangGraph v1 only supports nonempty calculation-audit tasks');
      }
      const receipt = await json(join(directory, 'execution.json')) as Execution | null;
      if (receipt) {
        if (JSON.stringify(receipt.record.input) !== JSON.stringify(state.input)) throw new Error('Task identity mismatch');
        return { execution: receipt, status: 'executed' };
      }
      // Exclusive intent survives a crash within the opaque executor. Never restart it silently.
      try { await writeFile(join(directory, 'execution.started'), JSON.stringify(state.input), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Uncertain executor outcome: inspect harness records; automatic retry blocked');
        throw error;
      }
      const execution = await execute(state.input);
      await atomic(join(directory, 'execution.json'), JSON.stringify(execution));
      fault?.('after_receipt');
      return { execution, status: 'executed' };
    })
    .addNode('review', () => ({ status: 'needs_review' }))
    .addNode('reject', () => ({ status: 'not_delivered' }))
    .addNode('approval', state => {
      const decision = interrupt({ action: 'write local delivery.md', answer: state.execution.record.result?.answer,
        verdict: state.execution.record.task_verdict });
      if (!decision || typeof decision.approved !== 'boolean') throw new Error('Approval must be boolean');
      return { approved: decision.approved as boolean };
    })
    .addNode('deliver', async state => {
      const body = state.execution.record.result!.answer! + '\n';
      const path = join(directory, 'delivery.md');
      // Fixed identity + identical-content replay, rather than append or another external write.
      const previous = await readFile(path, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return null; throw error;
      });
      if (previous !== null && previous !== body) throw new Error('Delivery conflict');
      if (previous === null) await atomic(path, body);
      fault?.('after_delivery');
      return { status: 'delivered' };
    })
    .addEdge(START, 'execute')
    .addConditionalEdges('execute', state => state.execution.record.runtime_status === 'completed'
      && state.execution.record.task_verdict === 'needs_review' ? 'review' : 'reject')
    .addEdge('review', 'approval')
    .addConditionalEdges('approval', state => state.approved ? 'deliver' : 'reject')
    .addEdge('deliver', END).addEdge('reject', END)
    .compile({ checkpointer: saver });
  const config = { configurable: { thread_id: 'task' } };
  return {
    async start(input: TaskInput) {
      if ((await graph.getState(config)).createdAt) throw new Error('Task already exists; use resume');
      return graph.invoke({ input }, config);
    },
    async resume(approval?: boolean) {
      const state = await graph.getState(config);
      if (!state.createdAt) throw new Error('No saved task');
      const paused = state.tasks.some(task => task.interrupts?.length);
      if (paused && approval === undefined) throw new Error('Approval required: approve or reject');
      if (!paused && approval !== undefined) throw new Error('No approval pending');
      if (!state.next.length) return state.values;
      return graph.invoke(paused ? new Command({ resume: { approved: approval } }) : null, config);
    },
    state: () => graph.getState(config),
    close: () => saver.db.close(),
  };
}
