import type { Submission } from './task_center.js';

const routingQuestions = {
  capability: { type: 'choice', instructions: '选择task完成所必需的主要能力。需要编写/运行脚本或生成任意指定文件时选择coding；现有数据工具可处理内联数据并回答时选择data。', criteria: {
    general: '一般文字任务', web: '查找或阅读网页资料', data: '用已有解析和查询工具处理数据，无需编写程序或任意文件',
    math: '算术计算', image: '理解图片或图表', coding: '编写、修改、调试或运行程序，或创建工具不能直接生成的文件',
  } },
  complexity: { type: 'choice', instructions: '评估task的工作复杂度，不要把需要编写简单脚本自动判断成complex。', criteria: {
    simple: '单一明确任务，少量步骤、无需复杂分析', complex: '多来源交叉核验、长论文深度分析、复杂实现或多阶段推理',
  } },
} as const;
export const runtimeCapabilities = {
  shell: 'The Harness automatically writes the final answer to result.md in the task workspace. Asking to save/report the answer in result.md requires NO programming and NO file-writing tool.',
  tools: {
    math: 'calculate performs arithmetic.',
    data: 'read_data parses inline/URL JSON and CSV; query_data queries, filters, sorts and aggregates loaded data. Answers can include tables or JSON text.',
    web: 'web_search finds pages; read_webpage reads HTTP pages; saved webpage tools retrieve stored source evidence.',
    image: 'Image-reading tool extracts visual information.',
  },
  limits: 'Routine worker cannot write arbitrary user-named files or run arbitrary scripts. Creating out.csv/stats.json/script.py, modifying existing files, or explicitly writing/running code requires coding. result.md is ONLY the final-answer artifact exception; a request to write code inside result.md still requires coding.',
} as const;
export const capabilityQuestion = { ...routingQuestions.capability,
  instructions: 'Select the main work capability using runtime_capabilities. Ignore automatic saving of the final answer to result.md when identifying the work. Arithmetic plus result.md is math; data analysis plus result.md is data; webpage reading plus result.md is web. Explicit code writing/execution or additional arbitrary files requires coding. Do not infer coding just from save/write/report verbs.',
};
/** Only override two fields after the coordinator has chosen to submit. */
export function jevSubmissionClassifier(log: (record: unknown) => Promise<void>, fetcher: typeof fetch = fetch) {
  const cache = new Map<string, Promise<Submission>>();
  return (submission: Submission): Promise<Submission> => {
    const key = JSON.stringify(submission);
    if (cache.has(key)) return cache.get(key)!;
    const pending = (async () => {
      const start = performance.now();
      try {
        const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` },
          body: JSON.stringify({ model: 'jev-1.13.0', state: { task: submission.task, expected_files: submission.acceptance.expected_files, runtime_capabilities: runtimeCapabilities },
            questions: { capability: capabilityQuestion, complexity: routingQuestions.complexity } }),
          signal: AbortSignal.timeout(8000),
        });
        const body = await response.json();
        const capability = body.answers?.capability?.choice, complexity = body.answers?.complexity?.choice;
        const valid = response.ok && Object.hasOwn(routingQuestions.capability.criteria, capability)
          && Object.hasOwn(routingQuestions.complexity.criteria, complexity);
        await log({ key: submission.key, elapsed_ms: performance.now() - start, usage: body.usage ?? null,
          cost_usd: Number.isFinite(body.usage?.input_tokens) ? body.usage.input_tokens * .042 / 1e6 : null,
          fallback: !valid, original: { capability: submission.capability, complexity: submission.complexity }, capability, complexity });
        if (valid) return { ...submission, capability, complexity };
        if (!submission.capability || !submission.complexity) throw new Error('ClassificationUnavailable');
        return submission;
      } catch {
        await log({ key: submission.key, elapsed_ms: performance.now() - start, fallback: true, cost_usd: null });
        if (!submission.capability || !submission.complexity) throw new Error('Jev分类失败，任务未提交；不可猜测分类。');
        return submission;
      }
    })();
    cache.set(key, pending); return pending;
  };
}
