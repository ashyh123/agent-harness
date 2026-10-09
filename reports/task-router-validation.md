# 统一任务入口验收（2026-10-09）

已接入手动选择的 `harness` 和 `codex`。任务在 `~/Documents/Agent-Runs/<agent>/<Asia-Shanghai日期>/<UUID>/workspace` 中执行；入口回收回答、结构化事件、实际文件和 SHA-256 清单。Codex CLI 已安装并使用现有 ChatGPT 登录，本次实际版本为 `codex-cli 0.162.0-alpha.2`。没有安装新路由服务或改写内部模型循环。

使用方式见 [ROUTER.md](../vercel_agent/ROUTER.md)，逐文件回读检查和原始任务路径见 [机器可读记录](task-router-summary.json)。

## 实际执行结果

| 任务 | 执行结果 | 调用/用量 | 验收观察 |
| --- | --- | --- | --- |
| Codex：程序计算并生成 JSON、Markdown | `completed / needs_review` | 原生用量：输入 36107、缓存输入 30848、输出 479 | 两个真实文件均回读并核对哈希；JSON 数字结果为 56877，Markdown 一致 |
| Harness：两步算术 | `completed / needs_review` | 模型 3 次、工具 2 次、11110 tokens | 工具返回 56088 → 56877，答案与 `result.md` 一致，原生运行记录保留 |
| Harness：Anthropic Managed Agents 博客 | `failed / not_completed` | 模型 4 次、工具 3 次、16865 tokens | 阅读、压缩及两次回查后，原五步预算不足以再压缩并续跑；保留快照和失败原因，没有创建笔记 |
| Harness：OpenAI Agents SDK 博客 | `completed / needs_review` | 模型 2 次、工具 2 次、9620 tokens | 读取 → 保存笔记；自动检查 4 项通过。笔记、原文和 vault 配置真实存在，逐字证据匹配实际读取内容，回读哈希正确 |

四次真实运行中三次正常完成执行，一次原 Harness 预算停止；失败记录也完整保存。共核对 17 个工作目录文件的字节数和哈希。没有统一两端模型、工具或预算，这不是 Codex 与 DeepSeek 的效果/成本对比。Codex 的缓存输入是原生输入统计的子项，不能再加一次计算总输入。

博客成功样本的概括为 401 字符，提取原文为 6065 字符，满足已有工具的“比原文短”检查，但超过 Skill 建议的 100–180 个中文字。来源、证据和实际保存已核对；概括的全部事实、限定与启发仍需人工验收，不能用保存成功替代语义正确。长博客失败说明新入口继承了现有阅读预算与压缩策略的限制，未调大预算来掩盖它。

## 打开真实产物

- [Codex 生成的计算报告](/Users/ashyh666/Documents/Agent-Runs/codex/2026-10-09/9bcce7c8-5b05-4b9b-94be-a94b9e04f165/workspace/report.md)
- [Codex 生成的 JSON](/Users/ashyh666/Documents/Agent-Runs/codex/2026-10-09/9bcce7c8-5b05-4b9b-94be-a94b9e04f165/workspace/result.json)
- [Harness 计算回答](/Users/ashyh666/Documents/Agent-Runs/harness/2026-10-09/deffb285-03eb-4724-abfc-f26b3e0bb186/workspace/result.md)
- [长博客失败记录](/Users/ashyh666/Documents/Agent-Runs/harness/2026-10-09/9faccdbb-9062-453f-b2e8-ac94a9d69145/task.json)
- [实际保存的 Obsidian 笔记](</Users/ashyh666/Documents/Agent-Runs/harness/2026-10-09/8168ef9f-74a0-4898-837e-6c40a1e64031/workspace/obsidian/阅读笔记/The next evolution of the Agents SDK - OpenAI--74fb2c941456.md>)

任务文件保存在用户 Documents 下，未进入项目 Git。博客使用的来源分别为 [Anthropic 原网页](https://www.anthropic.com/engineering/managed-agents) 和 [OpenAI 原网页](https://openai.com/index/the-next-evolution-of-the-agents-sdk/)；此处只记录执行观察，没有把搜索摘要当作正文。

## 本地检查

`npm test`：79/79 通过，其中新增 9 个路由测试，不调用模型。覆盖真实子进程和 stdin 传递、JSONL 结束协议、同日任务不覆盖、文件回读哈希、缺失文件、符号链接、超时终止整个进程组、取消、启动失败、协议错误、已知环境凭据脱敏，以及保留 Harness 原验收失败。初测发现 macOS 临时目录别名导致 cwd 不一致，已改为解析真实工作路径并复验通过。

`npm run typecheck` 和 `git diff --check` 通过。

## 本次修改的职责

| 文件 | 作用 |
| --- | --- |
| `vercel_agent/router_cli.ts` | 发布新任务、选择执行端、列出已登记执行端和已运行任务 |
| `vercel_agent/task_router.ts` | 创建目录、控制进程超时/取消、保存执行和验收两个状态、核对文件并建立清单 |
| `vercel_agent/task_adapters.ts` | 两个执行端的注册、启动参数、原生结果解析 |
| `vercel_agent/router_worker.ts` | 在新工作目录中运行已有 Harness，留本次原文快照和可选 Obsidian vault |
| `vercel_agent/bridge.ts` | 支持指定工作目录；原入口默认仍用项目目录 |
| `vercel_agent/package.json` | 新增 `npm run router` 命令；没有新增包依赖 |
| `vercel_agent/tests/task_router.test.ts` | 验证任务执行、失败与真实文件收录的边界 |

这一版直接等待一次任务结束，手动选择执行端。自动路由、其他 CLI、接管已有聊天、调度、会话恢复和多 Agent 协作还没有实现。路由任务的 Obsidian vault 位于本次工作目录，原直接 Harness 命令继续使用原有共享 vault。原有模型、工具注册表、上下文默认策略及预算没有因本次接入而改变。

参考 [agent-router 的项目说明](https://github.com/nidhi-singh02/agent-router/blob/main/README.md) 与 [启动实现](https://github.com/nidhi-singh02/agent-router/blob/main/packages/router/src/launch/herdr-launcher.ts)，借鉴其注册执行端和交接任务的分层。Codex 对接采用官方 [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode) 的 JSONL 与最终回答输出接口。
