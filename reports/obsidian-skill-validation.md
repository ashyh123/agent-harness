# 博客阅读文件存入 Obsidian：Skill 与验证

2026-10-08。按用户修改后的方案使用 Skill，不新增一套独立生产流水线。

## 分工

- `skills/obsidian-blog-reader/SKILL.md`：让现有 Harness/Agent 读取正文或已有快照，简化内容，区分厂商事实与个人优化启发，再保存。
- `tool_library/obsidian.py` 的 `save_obsidian_blog`：真正写入本地 Obsidian vault，并回读验证；工具注册、参数校验和预算仍复用 `tools.py`。
- `vercel_agent/harness.ts`：显式选择 Skill，单篇运行；只有工具返回真实保存并核验成功的收据，才结束运行。通过 Loop 的可选 `toolCompletion` 实现，通用 Loop 不包含 Obsidian 业务逻辑。
- `vercel_agent/verify_obsidian.ts`：测试入口，从候选池随机选择三家各一篇，模拟采集端真实抓取，再把文档 ID 交给 Skill。不是另写一个生产 Agent Loop。

Skill 是流程指令，不能自己完成磁盘写入；现有执行器调用工具才会产生真实 Markdown 文件。Obsidian vault 本身是本地目录，这里不需安装 REST 插件或配置新的账号/密钥。

## 实际 vault

已创建并在 Obsidian 中登记、打开：

`/Users/ashyh666/Documents/Obsidian/Agent 博客阅读`

```text
Agent 博客阅读/
  .obsidian/app.json
  首页.md
  阅读笔记/        简化内容、Agent 优化启发、短引文、来源与实际阅读范围
  提取原文/        网页提取文本快照，文件名为 document_id
```

通过 Obsidian 窗口菜单切到“Agent 博客阅读”，文件浏览器已显示三家文章和对应阅读笔记。原个人 vault 保留。登记时关闭应用后保留原 registry 条目，新增专属 vault，再启动验证；这不是写入工具每次修改全局配置的行为。

`MINIMAL_AGENT_OBSIDIAN_VAULT` 可指定其他绝对路径；默认使用上述 Home/Documents 位置。工具不接受模型提供任意文件路径。文件名来自快照标题和分析内容 hash，不同分析形成不同版本，相同内容可重复保存；已有文件不会被覆盖，手工修改不符时返回冲突。验证过程中产生的不同分析版本保留。

工具要求本轮真实读过文档，证据逐字出现在本轮工具正文中，总结比提取原文短；写完回读字节并返回 SHA256 和真实路径。生成的文件使用 Markdown、属性和原文快照链接。快照是提取文本，完整性仍未验证；保存全文快照不代表模型读过全文。

## 随机样本与最终验收

随机 seed `810836465`，从 Anthropic、OpenAI、Google 各两个官网候选中分层随机抽一篇。后续修复沿用同一组样本以比较行为，没有更换失败样本。最终完整验证记录为 `reports/obsidian-runs/blogs-AFi36h/verification.json`，独立 Harness 记录路径见该文件。

采集端真实读取网页，保存 capture.json 与本地快照，不使用伪造 fixture。Skill 每篇真实读取该快照 text 的前 4000 字符，基于这一范围分析；笔记诚实标明后文未覆盖。

| 厂商与文章 | 分析模型请求 | 分析工具调用 | 简化字符数 / 提取原文字符数 | 验收 |
| --- | --- | --- | --- | --- |
| Anthropic：Effective context engineering for AI agents | 2 | 2 | 291 / 21559 | 文件、引文、来源、hash 和简化长度通过 |
| OpenAI：The next evolution of the Agents SDK | 2 | 2 | 427 / 6065 | 同上 |
| Google：What's new in Managed Agents in Gemini API | 3 | 3 | 344 / 8298 | 同上 |

每篇另有一次采集工具调用，不调用模型，不计入随后独立分析任务的计数。Anthropic/OpenAI 的分析调用顺序为 `read_saved_webpage → save_obsidian_blog`。Google 首次保存调用被 SDK 参数校验拒绝，未执行写入；模型重新提交后保存通过，因此计 3 次模型请求、3 次工具尝试。这不是引文匹配失败，记录没有提供更细的无效参数原因。成功后宿主返回保存收据，不再增加模型请求口头确认。最终这一轮分析分别使用 6124、6293、11173 tokens，共 23590 tokens；这些是实际用量，不包含此前失败验证。

最终笔记：

- `阅读笔记/Effective context engineering for AI agents - Anthropic--3f8d546eaa37.md`
- `阅读笔记/The next evolution of the Agents SDK - OpenAI--2543b36c84cc.md`
- `阅读笔记/What’s new in Managed Agents in Gemini API--c95dca0377fe.md`

验收另外直接读取磁盘文件，确认保存的分析和引文存在、文件 hash 与工具收据一致、document_id 与真实采集文件一致、来源 URL 与采集返回一致、提取原文文件存在。没有以模型说“已保存”代替检查。

人工观察：Anthropic 概括上下文配置、有限注意力与召回退化；OpenAI 概括开发者从原型到生产的取舍、原生 harness/沙箱和工作区 Manifest；Google 概括异步任务 ID、远程 MCP 与客户端函数交接。概括针对实际读取的开头，不能代表整篇文章的全部要点；优化启发明确标注推论。自动检查不能证明语义保真，任务仍为 `needs_review`。

## 失败记录与修复

早期直接把长 URL 交给模型，Anthropic/Google 触发压缩后，固定 1024-token 摘要加上 Skill/来源索引超过 6500 目标。压缩器现按固定指令与索引之外的剩余空间限制摘要字数、下调生成上限，原次数预算不放宽。

一轮 Anthropic 文件已经保存，但随后要求模型最终确认导致预算停止。此单篇 Skill 改为以“工具保存且回读核验”的实际产物为运行终点，宿主直接返回原分析和收据；不把工具调用错误或仅文件名出现当成成功。`completion_source=verified_tool` 区分宿主收据与模型最终回答。语义仍由人工验收。

直接 URL 的长文任务仍多次出现超出必要范围的分页读取，耗尽 5 次外层请求；仅增加提示约束未证明能稳定解决。失败的 `blogs-rYyEMJ`、`blogs-bM4tN2`、`blogs-ADDsfr` 和单篇 `obsidian-blog-reader-reSJqR` 记录保留。这些失败没有被标为成功。

最终验证回到用户的“采集端已有阅读文件 → Skill 分析 → Obsidian”场景：采集与分析分开，Skill 精确读取已有文件的指定范围，三篇均正常完成。它证明该文件输入路径可用，不保证所有 URL、所有长文通读任务在当前预算下完成。

## 离线检查

59 项 Python 测试、40 项 TypeScript 测试和类型检查通过。新增测试覆盖真实文件回读/hash/原文、重复保存、手工修改不覆盖、必须先读与逐字引文、路径参数拒绝、符号链接拒绝，以及真实 SDK+Python+Skill 在压缩后落盘并以核验收据结束；只有口头“保存了”会被自动验收否决。Skill 创建校验器通过；PyYAML 仅在临时校验目录安装，未新增项目运行依赖。

## 使用

在项目 `vercel_agent` 目录运行：

```sh
npm run harness -- obsidian-blog-reader "处理 document_id <实际ID>，简化分析并保存到 Obsidian"
npm run verify:obsidian
npm run verify:obsidian -- 810836465
```

第一版每任务一篇；多个 URL 会被拒绝，调用方逐篇运行。已有文件用快照 ID，避免重新抓取；无文件时也可提供 URL，但长文直接阅读的可靠性限制见上。验证会产生实际模型用量，每次保存新目录，不覆盖日常 CLI 记录。
