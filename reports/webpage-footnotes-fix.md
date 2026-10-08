# 网页脚注与覆盖范围修复

日期：2026-10-08。基于提交 3c18b6f 的工作区修改，尚未提交。

## 原因确认

最初实跑遗漏了 Ironclad 博客脚注。排查时成功读取了原始 HTML，确认脚注以 `citation-bottom-1` 等锚点存在于正文外的列表中。原正文提取器的返回没有这些脚注；随后按文本长度生成的 `truncated=false` 被模型误解成“完整读取”。

## 代码改动

完整补丁：[webpage-footnotes.diff](webpage-footnotes.diff)，包含五个已跟踪文件的改动与新增测试文件。它不包含本说明和上次的试跑报告。

| 文件 | 改动 | 作用 |
| --- | --- | --- |
| tool_library/network.py | 增加 extract_footnotes | 从 HTML 中补取语义脚注及常见脚注锚点，排除脚本、样式、模板和 SVG 文本 |
| 同上 | 预留脚注空间并去重 | 总输出仍限制为 10000 字符，补充脚注最多 3000 字符，避免尾部限定被长正文挤掉；裁切边界外的脚注仍会补回 |
| 同上 | 增加 footnotes_found、completeness、coverage_note | 分别表达检测到的脚注数、整页覆盖未验证、长度裁切与完整性的区别 |
| tools.py | 更新 read_webpage 的描述 | 让模型在选择工具前就了解返回值的含义；两种 Loop 共用同一注册表 |
| skills/webpage-reader/SKILL.md | 明确正文与脚注一起读、保留评测限定、保留引文大小写、谨慎表述缺失信息 | 指导模型生成报告；这是软性指令，不是程序保证 |
| requirements.txt | 显式固定 lxml==6.1.3 | 代码直接使用 HTML 解析器，因此声明直接依赖；本地已有此版本，无额外安装 |
| README.md | 解释新增返回字段与边界 | 避免调用者继续把未裁切当作已完整提取 |
| tests/test_webpage_coverage.py | 新增 9 项回归测试 | 固定脚注丢失、脚注在裁切边界外、去重、长度限制、覆盖声明及真实提取器的行为 |

## 阅读顺序

1. `network.py` 的 `extract_footnotes()`：如何从网页结构取得补充资料。
2. `read_webpage()` 尾部：如何分配有限输出空间并表达读取范围。
3. `tools.py` 的 read_webpage 描述：模型怎样知道新的返回值含义。
4. `webpage-reader/SKILL.md`：资料进入上下文以后，如何指导模型使用它。
5. 测试中的正文外脚注与裁切边界案例：为什么只将脚注附在全文末尾仍不够。

模型、SDK Loop 与 Harness 没有新增流程分支。Python 与 TypeScript 入口都通过原注册表取得更新后的工具。网页资料仍是待分析数据，脚注提取不赋予网页文本新的指令权限。

## 验证结果与限制

- 34 项 Python 测试通过，包括新增 9 项；其中一项使用真实 Trafilatura 提取本地 HTML，只模拟下载。
- 21 项 SDK/Harness 离线测试通过，依赖一致性检查通过。
- 使用与上次完全相同的任务文本、预算和模型进行真实复测；read_webpage 两次返回 HTTP 403。模型如实返回无法读取，未伪造正文。此次 3 次模型请求、2 次工具调用、4978 tokens。
- [真实复测答案](harness/webpage-reader-XhPjqw/answer.md)、[运行记录](harness/webpage-reader-XhPjqw/run.json) 位于本地忽略目录。

因此可以确认本地脚注恢复、边界处理和覆盖声明的代码行为；尚不能确认修改后的模型能对这篇真实博客完成合格的阅读报告。未重复请求网站以挑选一次成功结果，也未放宽验收标准。

脚注提取支持语义标记和常见数字锚点，不覆盖所有网页结构；不会执行 JavaScript。`completeness` 始终保守地标记为 `not_verified`。引用和语义核对仍需人工验收，这次没有加入自动语义验收器。
