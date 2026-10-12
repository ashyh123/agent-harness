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

`obsidian-study` 使用 OMP 已有 `grep` 和 `read`，优先搜索文章卡片、阅读笔记与概念目录，挑少量相关内容读取，必要时沿内部链接查找。普通学习问题满足后停止，确实需要细节才回查原文。它区分自动简介、旧AI推论、明确的用户正文和新建议；默认只读，回答附真实笔记链接。

该 Skill 可由 OMP 根据任务选择，也可显式 `/skill:obsidian-study ...`。其他任务 Skill 需要复用学习库时，可指示先读取 `skill://obsidian-study` 再按该流程取用笔记。Skill提供流程指令，文件搜索和读取由OMP原生工具执行，没有新增RAG服务。

## 安装与代码

在项目根 `.env` 配置 `DEEPSEEK_API_KEY`，可选 `MINIMAL_AGENT_OBSIDIAN_VAULT`（默认 `~/Documents/Obsidian/Agent 博客阅读`），然后：

```sh
cd vercel_agent
npm run omp:install-collect
omp
```

安装到 `~/.omp/agent/extensions/blog-collect.js` 和 `~/.omp/agent/skills/obsidian-study/SKILL.md`；支持 `PI_CODING_AGENT_DIR`。安装器替换Skill模板中的vault路径，不修改OMP模型或密钥。已有不同内容的同名文件会被保留并报错。自定义profile需安装到对应目录。移动项目后需更新扩展路径；修改vault或Skill后需同步安装副本。

| 文件 | 作用 |
| --- | --- |
| `omp_collect_extension.mjs` | 命令注册、子进程、并发保护、取消、结果展示 |
| `collect_blog.ts` | 短预览、单次简介生成、回执和计量 |
| `article_cards.ts` | 稳定URL身份、查找已有卡片、只创建不覆盖 |
| `omp-skills/obsidian-study/SKILL.md` | 按任务检索、少量读取、来源区分、只读边界 |
| `install_omp_collect.ts` | 安装命令和指向实际vault的Skill |

旧 `blog`、`blog:agent` 和 `blog:index` 保留为之前的实验入口；日常 `/collect` 不再调用它们。

## 本机验收（2026-10-12）

通过已安装命令的真实OMP RPC会话收录上述Google博客：新建待阅读卡片，1次请求，607tokens，收录服务3.44秒。重复收录0次请求、0tokens，文件字节完全一致；原有笔记均保持原样。

离线测试验证：正文、个人外链、内部链接和已读状态在改名后仍完整保留；读取失败保留链接；无效简介不伪装成功；冲突文件不覆盖；命令不启动额外模型回合。类型检查通过。实际任务“学习给 Agent 加后台任务”通过 OMP 原生 `grep`、`read` 找到文章卡片、旧阅读笔记和概念笔记，输出两条建议与可解析的内部链接，并明确卡片待阅读、个人正文为空、旧AI推论不属于用户心得。该次10.73秒，4次OMP模型请求、42329tokens（含缓存读取）；检索没有生成文件或改动笔记。验收还发现一次相对路径读取错误，模型自行改为绝对路径完成；Skill已补明确的绝对路径规则。记录留在Git忽略的 `reports/collections/card-acceptance/`。
