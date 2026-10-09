# person agent 委派 Codex：真实验收

验收日期：2026-10-09。DeepSeek 父 Agent 已经在原 Vercel SDK 循环内自行委派 Codex，收到子任务收据后实际回读文件并给出审阅说明。不是手动运行 Codex 再把结果复制给 DeepSeek。

## 任务与实际产物

两轮使用相同要求：把 [Anthropic Managed Agents 博客](https://www.anthropic.com/engineering/managed-agents) 交给 Codex 读取分析，生成来源记录、三项事实及两项推论、Obsidian 笔记；DeepSeek 收到结果后回读证据和笔记、审阅并报告实际路径。每轮都是新任务，没有复用此前博客产物。

最终成功任务：

- 父任务：`b0c9f446-2f0f-4560-9253-9a6f242bf9cb`
- [DeepSeek 最终回答](</Users/ashyh666/Documents/Agent-Runs/harness/2026-10-09/b0c9f446-2f0f-4560-9253-9a6f242bf9cb/workspace/result.md>)
- [实际生成的博客笔记](</Users/ashyh666/Documents/Agent-Runs/harness/2026-10-09/b0c9f446-2f0f-4560-9253-9a6f242bf9cb/workspace/delegated/codex/2026-10-09/6f4fcb84-b8af-4f1e-8ad5-e16d49447f7a/workspace/obsidian/阅读笔记/blog.md>)
- [机器可读验收记录](person-agent-summary.json)

笔记在本次子任务的独立 Obsidian vault 里。没有自动合并进用户其他 vault。

实际工具顺序是：

```text
DeepSeek → delegate_to_codex → Codex 实际读取与写文件
        ← 子任务状态、回答、文件清单和原生用量
DeepSeek → read_delegated_file(evidence.json)
DeepSeek → read_delegated_file(obsidian/阅读笔记/blog.md)
        → DeepSeek 最终审阅说明与真实路径
```

## 两次运行结果

| 指标 | 首轮：旧上下文容量 | 最终：person 专用容量 |
| --- | --- | --- |
| 父任务状态 / 验收结论 | failed / not_completed | completed / needs_review |
| 压缩触发 / 目标估算容量 | 12000 / 8500 | 24000 / 16000 |
| DeepSeek 模型请求 | 2 | 4 |
| 父工具调用 | 3 | 3 |
| DeepSeek 总 tokens | 10143 | 25599 |
| Codex 子任务启动 | 1 | 1 |
| 回读文件 | 2，全量、hash 一致 | 2，全量、hash 一致 |
| 用时 | 88.064 秒 | 94.979 秒 |
| 实际上下文压缩 | 0 | 0 |
| 回答长度重试 | 无 | 1 次，仅重试模型 |

首轮 Codex 已完成，DeepSeek 也已经回读两份文件，但最终回答前失败：必须保留的任务、工具描述和来源索引放不进旧压缩目标。它没有被标记成成功；失败记录与文件仍保留。

修复为 person profile 单独增加容量，保留原 legacy 压缩策略和 64000 安全容量。最终运行仍有一次输出长度不足，已有的精简回答重试成功；这使模型请求增加到四次，没有重启 Codex 或重新执行工具。这是容量与运行预算的不同边界。

仅凭这一个博客样本，不能断言该配置对所有长文都最佳，也不能用两轮的 token 差异衡量框架效率：真实模型执行路径并非固定。

## 文件与内容检查

最终父任务清单里的 14 个文件均与实际字节数及 SHA-256 一致；两轮合计检查 28 个文件。DeepSeek 确实读取了证据 JSON 的 1219 字符及笔记的 1132 字符，没有仅根据 Codex 的完成声明作答。

自动检查三项都通过：委派成功、父模型回读实际产物、最终回答包含已回读文件的绝对路径。结论保持 needs_review，因为这些检查不能证明引文或语义推理正确。

独立对照原网页后，证据中三条短引文均能找到对应原文，三项事实也与正文一致：外部 session log 支持 harness 故障恢复、生成代码的 sandbox 无法接触令牌、模型上下文通过 session log 持久保存。来源为上述 [Anthropic 原文](https://www.anthropic.com/engineering/managed-agents)。笔记中的两项工程建议明确标注为推论，尚未作为实际功能测试。

DeepSeek 最终回答诚实说明自己只回读产物，没有独立向原网页核实。它的最终输出主要是审阅状态、阅读限制和路径；实质文章分析在 Codex 生成的笔记里。因此此轮证明了委派与回读链路，也暴露了后续可以改善的输出质量，不能把它等同于完整的自动事实验证。

## 用量边界

成功轮的 DeepSeek 用量是父模型请求的 25599 tokens。Codex 原生收据单列：

- input_tokens：197664
- cached_input_tokens：159744（输入统计中的缓存部分，不能再加一遍）
- output_tokens：2544
- reasoning_output_tokens：312

父任务的八次模型上限不约束 Codex 内部模型循环；外部 CLI 没有在此实现 token 硬上限。父子共享墙钟时间边界，父任务取消或超时会清理嵌套进程。默认每个父任务最多实际启动一次 Codex；相同参数重复调用复用收据，仍计入父工具调用。

## 离线验证

最终代码验证全部通过：

- TypeScript：89 项测试，类型检查通过。
- Python：79 项测试，依赖一致性检查通过。
- 新 Skill 通过 skill-creator 的 quick_validate；没有给项目新增依赖。
- 离线测试覆盖 SDK → Python 桥接 → 路由器 → 假 CLI → 工具结果回传 → 文件回读；重复委派、失败收据、参数校验、hash/符号链接边界、压缩索引，以及父任务超时清理嵌套进程。

## 改动入口

没有重写原模型循环。两个新工具通过现有工具注册表接入：

- `skills/person-agent/SKILL.md`：委派、回读、输出和失败规则。
- `tool_library/delegation.py`、`tools.py`、`runtime.py`：委派执行、参数 Schema、本轮收据与文件绑定。
- `vercel_agent/person_profile.ts`：启用两个工具、专用时间和上下文容量。
- `vercel_agent/router_cli.ts`：结构化 JSON 与 stdin 任务输入。
- `vercel_agent/task_router.ts`、`task_adapters.ts`：嵌套执行的进程组清理。
- `vercel_agent/context.ts`、`checks.ts`：保留子任务文件索引与父流程检查。
- `harness_cli.ts`、`router_worker.ts`、`package.json`：运行入口与父子用量分别记录。

运行方式及代码阅读顺序见 [PERSON_AGENT.md](../vercel_agent/PERSON_AGENT.md)。
