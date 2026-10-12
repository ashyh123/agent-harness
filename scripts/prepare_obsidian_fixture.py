"""Prepare an independent acceptance vault; never writes the user's learning vault."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import trafilatura
from tool_library.obsidian_retrieval import no_symlinks
ROOT = Path(__file__).resolve().parents[1]
TEST_NOTES = {
 '阅读笔记/后台任务练习.md': '''# 后台任务练习（测试资料）

这是本次验收编写的案例，不是用户真实心得。

我想让一个阅读任务在窗口关闭后继续执行，并且下次回来能看到结果。
第一步分离提交请求与长时间执行：提交后返回任务ID，用轮询或重连查询状态。
第二步把事件日志和任务状态持久化，避免执行容器重启就丢失进度。
第三步明确取消、超时和失败重试；保存文件时检查是否重复写入，保留个人正文。
Gemini的后台交互提供异步执行与ID；Anthropic Managed Agents讨论session、harness与sandbox分离。

## 相关笔记
[[文章卡片/gemini-background]]
[[文章卡片/managed-agents]]
''',
 '阅读笔记/笔记搜索练习.md': '''# 笔记搜索练习（测试资料）

这是本次验收编写的案例，不是用户真实心得。

以前写“异步执行”，今天却问“关掉窗口后还会不会继续跑”，字面搜索可能找不到。
BM25依赖关键词，Embedding把查询和笔记映射到向量，适合寻找不同措辞的相关内容。
两个排名用RRF融合，再让重排序模型判断问题与候选片段的关联程度。
检索只提供候选，不保证原文事实；应实际读取命中笔记，输出来源链接。
文章卡片帮助判断是否值得阅读，自己的学习正文保留在“我的笔记”；待阅读不等于已读。
''',
 '知识图谱/概念/输出格式与任务成功.md': '''# 输出格式与任务成功（测试资料）

这是本次验收编写的案例，不是用户真实心得。

结构化输出通过JSON Schema约束形状和字段类型，能减少格式解析失败。
但返回合法JSON不代表事实正确，也不代表用户任务完成。
应分别检查格式合法、数值计算、证据支持、文件实际保存与任务目标是否达到。
工具成功返回也是局部执行结果；不能因此把整个任务标成完成。

## 相关笔记
[[文章卡片/structured-outputs]]
[[文章卡片/writing-tools]]
'''
}

def prepare(directory, browser_extracts=None):
    directory = no_symlinks(directory)
    directory.mkdir(parents=True, exist_ok=True)
    manifest_path = directory / 'manifest.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        for item in manifest['notes']:
            if hashlib.sha256((directory/'vault'/item['path']).read_bytes()).hexdigest() != item['sha256']:
                raise RuntimeError('Fixture changed; use a fresh output directory')
        return manifest
    vault = directory/'vault'
    entries = []
    sources = json.loads((ROOT/'fixtures/obsidian-retrieval/sources.json').read_text())
    with httpx.Client(timeout=40, follow_redirects=True, headers={'User-Agent':'ObsidianLearningAcceptance/1.0'}) as client:
        for source in sources:
            print('Fetching', source['url'], flush=True)
            cached = (browser_extracts / (source['id']+'.json')) if browser_extracts else None
            if cached and cached.exists():
                data = json.loads(cached.read_text())
                if data.get('url') != source['url'] or not data.get('text'):
                    raise RuntimeError('Invalid browser extraction')
                text, title = data['text'], data['title']
                source['extraction'] = data['extraction']
            else:
                response = client.get(source['url']); response.raise_for_status()
                text = trafilatura.extract(response.text, include_comments=False, include_tables=True)
                metadata = trafilatura.extract_metadata(response.text)
                title = metadata.title if metadata and metadata.title else source['id']
                source['extraction'] = 'httpx+trafilatura'
            if not text or len(text) < 500:
                raise RuntimeError('Insufficient source content: '+source['url'])
            excerpt = text[:7500]
            note = ('---\n'+f'title: {json.dumps(title,ensure_ascii=False)}\nsource: {json.dumps(source["url"])}\n'
                    +'status: "待阅读"\ntype: "source-excerpt-fixture"\n---\n\n'
                    +f'# {title}\n\n独立检索验收资料，非用户心得。这里只包含提取正文的开头最多7500字符，未分析全文。\n\n'
                    +f'[原文](<{source["url"]}>)\n\n## 原文摘取范围\n\n{excerpt}\n')
            target = vault/source['path']; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(note, encoding='utf-8')
            entries.append({**source, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
                'extracted_chars':len(text),'included_chars':len(excerpt)})
    for path, body in TEST_NOTES.items():
        target = vault/path; target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(body,encoding='utf-8')
        entries.append({'id':path,'path':path,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
                        'kind':'agent-authored-test-note-not-user-writing'})
    manifest={'version':1,'vault':str(vault),'notes':entries,
              'scope':'8 live vendor-blog excerpts + 3 explicit test notes; not a representative production corpus'}
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=ROOT/'reports/obsidian-retrieval/acceptance')
    parser.add_argument('--browser-extracts',type=Path)
    args=parser.parse_args();manifest=prepare(args.output,args.browser_extracts);print('Vault:',manifest['vault'])
