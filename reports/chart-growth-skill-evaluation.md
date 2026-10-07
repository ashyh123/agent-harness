# chart-growth 验证与 Harness 阅读路线

2026-10-07。沿用当前 Skill、模型、工具、512 token 输出上限和全部预算，没有为了通过测试修改提示词、扩大预算或重跑挑选答案。

## 结论及验证范围

主要流程可行，严格证据要求尚未全部通过。正常样例实际识别 120、150，按三步计算得到 25.00%；异常数据时停止增长率计算。发现局部表述和额外算术缺少证据的问题，记录如下。

| 场景 | 验证方式 | 实际行为 | 人工判断 |
| --- | --- | --- | --- |
| 120 → 150 | 完整 Harness、真实图片和视觉模型、真实计算 | analyze_image → subtract → divide → multiply；返回 25.00% | 本次通过 |
| 图片不存在 | 完整 Harness、真实工具 | image_not_found，不调用 calculate，说明原因并请求补充 | 失败处理符合主要要求，未取得用户要求的数值结果 |
| 0 → 150 | 真实主模型、固定视觉返回、真实计算工具 | 读图两次，不调用 calculate，不给百分比 | 核心零基数处理正确；额外输出绝对增量 150，没有算术工具记录，严格证据核对未通过 |
| 2025 可能为 150 或 180 | 同上 | 保留歧义、暂停计算、请求清晰图片或数值 | 核心处理正确；将工具未提供的标题/轴信息表述为“未能识别”，证据表述未通过 |
| 2025 数值缺失 | 同上 | 保留已知数值，说明缺口，不计算 | 本次受控流程通过 |
| 120 元 → 150 人 | 同上 | 指出单位不同，不计算 | 本次受控流程通过 |
| 150 → 120 | 同上 | calculate 返回 -30、-0.2、-20；输出 -20.00%，说明下降 | 本次受控流程通过 |

零基数的两次读图问题不同，不能据此声称违反了“反复提交同一无效调用”；但在已收到清晰读数后再次读图增加开销。同一张图片重复读取也不是独立来源。

固定视觉返回的测试只检查主模型收到异常资料后如何处理。模拟路径没有对应真实图片；固定返回不依据模型的具体视觉问题变化，也没有发起内部视觉模型请求。因此这些样例不证明视觉识别可靠性，不能与真实样例直接比较耗时或模型请求成本。单次成功也不能保证之后都成功。

本次七个场景合计 36532 tokens。原始记录：

- [正常任务答案](harness/chart-growth-RWgnK2/answer.md)、[完整记录](harness/chart-growth-RWgnK2/run.json)。
- [图片不存在任务答案](harness/chart-growth-d1NUq9/answer.md)、[完整记录](harness/chart-growth-d1NUq9/run.json)。
- [五个受控样例](chart-growth-controlled-validation.json)，包含固定资料、检查结果、答案、调用记录和人工评估。

`harness/` 原始任务记录为本地 Git 忽略文件；报告中的链接在当前工作区可用，其他检出未必存在。Harness 的 `needs_review` 状态保持不变，此处的人工判断没有伪装成程序自动验收。

## 从一次真实执行理解代码

先读新增的三个文件，再回到已经熟悉的 SDK Loop。先追踪数据怎样流动，不必先研究桥接协议所有细节。

### 1. 入口：harness_cli.ts

读 [main()](../vercel_agent/harness_cli.ts:6)，重点是第 13、18、20、21 行。

`chart-growth` 进入 `skill`，后面的任务文本进入 `task`。程序加载环境、启动 PythonBridge，通过 `describe` 取得原工具库及预算，最后调用 `MinimalHarness.run({ skill, task })`。

这里没有模型自动选择 Skill，也没有重新注册图表专用工具。`--list` 是给人看的流程目录。

### 2. 加载：skills.ts

读 [loadSkill()](../vercel_agent/skills.ts:12)。第 14 行读取 Markdown，第 16 行解析这个 Demo 支持的简单元数据，第 20 行返回 `name`、`description` 和 `instructions`。

这一步是文件读取，不是 LLM 请求，也不是执行 Markdown 中的程序。正文成为一段待传给模型的指令。当前解析器只支持两字段的固定简单格式。

### 3. 核心接线：harness.ts

读 [run()](../vercel_agent/harness.ts:28)，重点分四段：

- 第 29–45 行：检查输入，加载 Skill，为本次任务创建独立目录，先保存 `running` 记录。
- 第 47–50 行：复制原配置，将 Skill 正文追加到原系统提示词。原工具列表继续复用；Skill 不能凭空新增工具。
- 第 52–58 行：用新消息列表提交用户任务，将模型、工具和时间预算传入已有 Loop。单任务使用独立上下文。
- 第 59–75 行：更新运行状态、保留待验收标记，保存完整记录和用户可读答案。桥接失败等也会记录。

核心两处可以单独对照：

```ts
system_prompt: `${this.config.system_prompt}\n\n当前选定 Skill：${skill.name}\n${skill.instructions}`
```

```ts
record.result = await loop.run([{ role: 'user', content: input.task }], {
  limits: {
    max_model_requests: this.config.max_model_requests,
    max_tool_calls: this.config.max_tool_calls,
    max_seconds: this.config.max_seconds,
  },
});
```

前者提供流程指导；后者传递任务及代码执行的限制。Skill 中的自然语言规则不会自动转换成强制校验。

### 4. 执行：agent.ts

读 [工具包装](../vercel_agent/agent.ts:65)、[ToolLoopAgent 配置](../vercel_agent/agent.ts:79) 和 [generate()](../vercel_agent/agent.ts:103)。

Skill 合并后的 `system_prompt` 成为 `instructions`。模型按它决定调用哪些工具；SDK 调用 `execute`，通过桥接交给 Python，并将结果按调用 ID 交回下一次模型请求。

读 [实际请求计数](../vercel_agent/agent.ts:31) 理解为什么预算是代码控制：模型请求前先向共享运行上下文申请预算。读 [tool_bridge.py](../vercel_agent/tool_bridge.py:95) 可以看到超过外层次数或总模型次数时如何拒绝继续。

正常任务的实际路径：

```text
外层模型请求 1 → analyze_image → 内部视觉模型请求 → 120、150
外层模型请求 2 → calculate(subtract, 150, 120) → 30
外层模型请求 3 → calculate(divide, 30, 120) → 0.25
外层模型请求 4 → calculate(multiply, 0.25, 100) → 25
外层模型请求 5 → 最终答案 25.00%
```

所以本次是 6 次模型请求（含视觉）、4 次工具调用，恰好用完 5 次外层请求预算。没有截断或自动精简重试；如果最后一步截断或需要额外纠错，目前可能没有外层请求余量。这是现有预算与任务步骤的匹配问题。

### 5. 收尾与验收：harness.ts 和 run.json

回看 [状态判断](../vercel_agent/harness.ts:59)：代码只检查是否有运行错误，以及是否返回非空答案，然后标记 `completed` 和 `needs_review`。

它没有执行 Skill 里的“人工验收标准”。例如模型把缺失信息说成识别失败，或跳过应有的算术工具，这里仍可能得到 `completed`。

打开本次 `run.json` 的 `result.events`，对照每个工具的 `arguments`、`result` 和最终答案。不要只看工具名字是否出现；要检查参数、数据依赖和结论一致性。

### 6. 最后看测试

读 [harness.test.ts](../vercel_agent/tests/harness.test.ts:37)。它验证 Skill 指令与任务隔离、工具库复用、记录不覆盖和预算停止证据。这些是运行外壳的确定性行为；模型能否理解图表和严格遵循工作流程，需要本报告这样的实际任务评估。

当前不必从 `bridge.ts` 的 pending Map 开始读。需要理解 TypeScript 怎样调用原 Python 工具时，再读 [request()](../vercel_agent/bridge.ts:41) 与 [Python 调度](../vercel_agent/tool_bridge.py:44)。本地 JSON Lines 桥接是为了复用语言不同的工具库，不是 Harness 必须采用的架构。

## 第一个理解检查

如果只在 Skill 中加入“最多读取一次图片”，当前程序会自动执行这个次数限制吗？

建议先观察 `harness.ts` 的指令拼接，再观察 `agent.ts`/Python 预算检查：自然语言指导和代码强制限制分别在哪里，这正是阅读这次 Harness 最值得弄清楚的边界。
