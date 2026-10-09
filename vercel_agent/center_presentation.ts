import { join } from 'node:path';
import type { CenterTask } from './task_center.js';

/** 路径由实际收据提供，避免依靠模型复述长目录。 */
export function completedTaskPaths(tasks: CenterTask[]) {
  const rows = tasks.filter(job => job.status === 'completed').flatMap(job => {
    const attempt = job.attempts.at(-1)!;
    const record = attempt.record;
    if (!record) return [];
    return job.input.acceptance.expected_files.filter(path => record.artifacts.some(file => file.path === path))
      .map(path => ({ task_id: job.id, attempt_id: attempt.id, path, full_path: join(record.workspace, path) }));
  });
  return rows;
}
export function renderCompletedTaskPaths(tasks: CenterTask[]) {
  const rows = completedTaskPaths(tasks);
  return rows.length ? '\n\n调度器收据中的完整产物路径：\n' + rows.map(row => `[${row.task_id.slice(0, 8)}] ${row.full_path}`).join('\n') : '';
}
