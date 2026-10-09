"""把 Agent 已实际读过的网页分析保存为独立 Obsidian vault 的 Markdown。"""
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .errors import ToolError
from .webpage_store import load_webpage

VAULT_DIR = Path(os.getenv("MINIMAL_AGENT_OBSIDIAN_VAULT",
                           Path.home() / "Documents/Obsidian/Agent 博客阅读")).expanduser()


def _directory(path):
    if not path.is_absolute():
        raise ToolError("invalid_vault", "Obsidian vault 配置必须是绝对路径")
    for parent in [*reversed(path.parents), path]:
        if parent.is_symlink():
            raise ToolError("invalid_vault", "不能通过符号链接写入 vault")
    path.mkdir(parents=True, exist_ok=True)


def _write_once(path, content):
    data = content.encode("utf-8")
    if path.is_symlink():
        raise ToolError("invalid_note", "不能写入符号链接笔记")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        try:
            # 原子地创建，不覆盖已有笔记。相同内容可重复运行。
            os.link(temporary, path)
            created = True
        except FileExistsError:
            created = False
        if path.is_symlink() or path.read_bytes() != data:
            raise ToolError("note_conflict", "已有文件内容不同，未覆盖；请保留并检查该笔记")
        return created, hashlib.sha256(data).hexdigest()
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _initial_file(path, content):
    if path.is_symlink():
        raise ToolError("invalid_vault", "vault 初始化文件不能是符号链接")
    if not path.exists():
        _write_once(path, content)


def save_obsidian_blog(document_id, summary, takeaway, evidence_quote, *, context=None):
    document = load_webpage(document_id)
    reads = [event for event in (context.events if context else [])
             if event.get("type") == "tool" and event.get("name") in {"read_webpage", "read_saved_webpage"}
             and event.get("result", {}).get("document_id") == document_id
             and isinstance(event.get("result", {}).get("content"), str)]
    if not reads:
        raise ToolError("read_required", "本轮必须先用网页或快照工具读取此文档，不能只凭搜索摘要保存分析")
    normalise = lambda value: ''.join(value.split())
    if not any(normalise(evidence_quote) in normalise(event["result"]["content"]) for event in reads):
        raise ToolError("quote_not_in_read_content", "证据引文没有逐字出现在本轮实际读过的正文中；请回查并纠正")
    if len(summary) >= len(document["content"]):
        raise ToolError("not_simplified", "总结未比提取原文短，请先简化")

    for folder in [VAULT_DIR, VAULT_DIR / '.obsidian', VAULT_DIR / '阅读笔记', VAULT_DIR / '提取原文']:
        _directory(folder)
    _initial_file(VAULT_DIR / '.obsidian/app.json', '{}\n')
    _initial_file(VAULT_DIR / '首页.md', '# Agent 博客阅读\n\n阅读笔记由最小 Agent 的 obsidian-blog-reader Skill 生成。\n\n'
                  '在「阅读笔记」目录查看简化内容与优化启发，在「提取原文」目录回查保存的网页提取文本。\n\n'
                  '每篇笔记记录来源、证据和实际阅读范围；模型分析仍需核对，不代表读完原网页。\n')
    title = document.get('title') or '未命名博客'
    safe_title = re.sub(r'[\x00-\x1f/\\:*?"<>|\[\]#^]', '-', title).strip('. ')[:90] or '博客阅读'
    identity = hashlib.sha256(json.dumps([document_id, summary, takeaway, evidence_quote],
                                         ensure_ascii=False).encode()).hexdigest()[:12]
    path = VAULT_DIR / '阅读笔记' / f'{safe_title}--{identity}.md'
    original_path = VAULT_DIR / '提取原文' / f'{document_id}.md'
    original = f'# {title}\n\n来源：{document["url"]}\n\n这是工具提取文本，网页完整性未验证。\n\n{document["content"]}\n'
    _write_once(original_path, original)
    coverage = []
    for event in reads:
        result = event['result']
        if event['name'] == 'read_webpage':
            coverage.append(f'- 网页预览：{len(result["content"])} 字符；truncated={str(result.get("truncated")).lower()}。不能据预览长度断言连续区间。')
        else:
            coverage.append(f'- 快照回读：{result["content_format"]} [{result["offset"]}, {result["end_offset"]})。')
    # 日期仅用于展示，重复保存以同一文档/分析内容标识文件，不覆盖已有版本。
    if path.exists() and not path.is_symlink():
        # 返回已存版本也核验分析内容，不能仅以文件存在冒充写入成功。
        saved = path.read_text(encoding='utf-8')
        if not all(value in saved for value in [document_id, summary, takeaway, evidence_quote]):
            raise ToolError("note_conflict", "已有笔记与本次分析不一致，未覆盖")
        data = saved.encode('utf-8')
        created, digest = False, hashlib.sha256(data).hexdigest()
    else:
        frontmatter = {'title': title, 'source': document['url'], 'document_id': document_id,
                       'created': datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat(),
                       'tags': ['agent-reading', 'ai-blog'], 'completeness': 'not_verified'}
        metadata = '\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key, value in frontmatter.items())
        note = f'---\n{metadata}\n---\n\n# {title}\n\n## 简化内容\n\n{summary}\n\n## 对我的 Agent 的启发\n\n{takeaway}\n\n'
        note += '## 原文证据\n\n' + '\n'.join('> ' + line for line in evidence_quote.splitlines()) + '\n\n'
        note += f'## 来源与阅读范围\n\n[原网页]({document["url"]}) · [[提取原文/{document_id}|提取原文快照]]\n\n'
        note += '\n'.join(coverage) + '\n\n完整性未验证；摘要可能遗漏细节，优化启发属于推论，不是厂商承诺。\n'
        created, digest = _write_once(path, note)
    return {'status': 'saved' if created else 'already_saved', 'verified': True,
            'vault_path': str(VAULT_DIR), 'note_path': str(path), 'original_path': str(original_path),
            'document_id': document_id, 'source_url': document['url'], 'sha256': digest,
            'summary_chars': len(summary), 'source_chars': len(document['content']),
            'note_bytes': path.stat().st_size}
