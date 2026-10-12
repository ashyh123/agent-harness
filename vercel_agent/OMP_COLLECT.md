# OMP：文章卡片与学习笔记

日常入口是 `/collect URL`，用于判断文章是否值得读；阅读心得和关联由你在 Obsidian 中维护。任务需要已有知识时，`obsidian-study` Skill 按需搜索、读取笔记。

```text
/collect https://blog.google/innovation-and-ai/technology/developers-tools/expanding-managed-agents-gemini-api/
/skill:obsidian-study 我正在学习给 Agent 加后台任务。结合我的笔记给两条学习建议和笔记链接。
```

## 收录

固定步骤：检查已有卡片 → 获取网页标题和短预览 → 一次模型请求生成简介 → 新建文章卡片。模型只收到去除代码后的开头最多1800字符，简介上限120字符，最多4个主题词；不做全文分析、压缩、引文核对或自动概念整理。

卡片保存到 vault 的 `文章卡片/`，包含来源 URL、标题、`待阅读`状态、主题、简介，以及空白的“我的笔记”“相关笔记”。你可以自由写正文、改状态、加入 `[[概念链接]]`。自动简介是选文提示，不表示你已读过文章。

重复收录按 `source` URL 查找，去掉 fragment。已有卡片整个文件保持原样，0次网络及模型请求。卡片在 `文章卡片` 内重命名或移到子目录仍可找到；移出此目录或删除 `source` 属性后无法识别，因此请保留该属性。已有旧阅读笔记与概念图谱不迁移或改写。

- `complete`：新卡片带简介，或找到了带简介的已有卡片。
- `partial`：链接已保存，但简介待补充；网页或模型失败仍保留待阅读卡片。重复收录不自动重试简介，可自行填写。
- `failed`：没有成功保存或读取卡片，例如路径冲突或无写入权限。

每次显示路径、阅读状态、tokens和耗时。收录使用项目 `.env` 的 DeepSeek 配置，一次请求上限320输出tokens、45秒步骤预算；OMP子进程有125秒保护。命令不额外启动OMP普通模型回合；同一会话一次收录一篇，退出会取消运行。

## 按任务取用笔记

`obsidian-study` 使用 OMP 原生 MCP 连接 `obsidian-learning`，默认 `method: vector` 搜索任务相关笔记，再用 `read_obsidian` 读取少量正文，并传入搜索返回的相对路径与 SHA-256。需要更多正文时分页，需要相关概念时按内部链接再检索。BM25 与混合重排序可显式选择。普通学习问题满足后停止，确实需要细节才回查原文。它区分自动简介、旧AI推论、明确的用户正文和新建议；只读工具不会改写笔记，回答附真实内部链接。

该 Skill 可由 OMP 根据任务选择，也可显式 `/skill:obsidian-study ...`。其他任务 Skill 需要复用学习库时，可指示先读取 `skill://obsidian-study` 再按该流程取用笔记。Skill 提供流程，OMP 负责工具调用循环；检索和正文读取复用现有 FastMCP 服务，没有另外实现循环或 MCP 适配器。服务器不可用时说明连接问题；空库说明没有可检索笔记，不编造链接。

## 安装与代码

先按 [MCP 安装说明](../docs/OBSIDIAN_MCP.md)准备 `.venv-mcp` 和本地检索模型。在项目根 `.env` 配置 `DEEPSEEK_API_KEY`，可选 `MINIMAL_AGENT_OBSIDIAN_VAULT`（默认 `~/Documents/Obsidian/Agent 博客阅读`），然后：

```sh
cd vercel_agent
npm run omp:install-collect
omp
```

安装到 `~/.omp/agent/extensions/blog-collect.js`、`~/.omp/agent/mcp.json` 和 `~/.omp/agent/skills/obsidian-study/SKILL.md`；支持 `PI_CODING_AGENT_DIR`。安装器替换 Skill 模板中的 vault 路径，合并 MCP 配置，保留其他服务器和 OMP 的模型路由、密钥。已有不同内容的同名 Skill 会保留并报错；确需更新时先审阅副本，再给 Python 安装器传 `--previous-skill-sha256`，只替换与该 hash 完全一致的内容。自定义 profile 需安装到对应目录。移动项目或修改 vault 后需同步安装路径。当前会话可 `/mcp reload` 更新连接，重新启动 OMP 可同时刷新 Skill 发现。

| 文件 | 作用 |
| --- | --- |
| `omp_collect_extension.mjs` | 命令注册、子进程、并发保护、取消、结果展示 |
| `collect_blog.ts` | 短预览、单次简介生成、回执和计量 |
| `article_cards.ts` | 稳定URL身份、查找已有卡片、只创建不覆盖 |
| `omp-skills/obsidian-study/SKILL.md` | 按任务检索、少量读取、来源区分、只读边界 |
| `install_omp_collect.ts` | 安装命令和指向实际vault的Skill |
| `../scripts/install_obsidian_omp.py` | 合并 OMP 原生 MCP 配置、安装或受控更新 Skill |

旧 `blog`、`blog:agent` 和 `blog:index` 保留为之前的实验入口；日常 `/collect` 不再调用它们。

## 本机验收（2026-10-12）

通过已安装命令的真实OMP RPC会话收录上述Google博客：新建待阅读卡片，1次请求，607tokens，收录服务3.44秒。重复收录0次请求、0tokens，文件字节完全一致；原有笔记均保持原样。

离线测试验证：正文、个人外链、内部链接和已读状态在改名后仍完整保留；读取失败保留链接；无效简介不伪装成功；冲突文件不覆盖；命令不启动额外模型回合。类型检查通过。实际任务“学习给 Agent 加后台任务”通过 OMP 原生 `grep`、`read` 找到文章卡片、旧阅读笔记和概念笔记，输出两条建议与可解析的内部链接，并明确卡片待阅读、个人正文为空、旧AI推论不属于用户心得。该次10.73秒，4次OMP模型请求、42329tokens（含缓存读取）；检索没有生成文件或改动笔记。验收还发现一次相对路径读取错误，模型自行改为绝对路径完成；Skill已补明确的绝对路径规则。记录留在Git忽略的 `reports/collections/card-acceptance/`。

### MCP 接入后的验收

上述 grep/read 是旧版记录；当前版使用 MCP 相对路径。OMP 18.10.0 的真实 RPC 会话展开了已安装的 Skill，并通过原生注册的两个 MCP 工具执行任务，没有自行伪造检索结果。保留用户的 `router/balanced` 配置，实际路由到 `deepseek/deepseek-flash`。

日常库当前没有 Markdown 笔记：测试返回 `note_count: 0`、空结果，说明没有真实链接可给。5.63 秒，2次模型请求，7316 tokens（含缓存读取）。未向日常库填入测试笔记。

非空验收任务：“输出格式正确，但关掉窗口之后结果没了，该先学习什么？”使用原先的独立验收库，本轮项目级临时 MCP 定义覆盖 vault 和审计日志，不改日常默认配置。实际完成2次 vector 搜索、3次带 hash 的正文读取，建议学习状态持久化/恢复及结果落盘/完成判定，并返回3个可解析的笔记链接，明确测试笔记不是用户心得、厂商摘录不等于已核实全文。15.69 秒（含 OMP 和 MCP 启动），3次模型请求，17827 tokens（输入6265、输出1322、缓存读取10240）。11篇验收笔记全部字节不变。回答仍比要求的简短建议更长，本次不声称个人资料上的回答质量已全面验收。

证据在忽略目录 `reports/obsidian-retrieval/acceptance/omp/`：Skill 展开、真实模型响应与工具调用事件、服务器审计日志和最终回答。安装/校验/检索共16项 MCP 测试、TypeScript 类型检查、Skill 元数据校验通过。
