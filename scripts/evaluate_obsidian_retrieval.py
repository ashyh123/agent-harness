"""Frozen note-level relevance evaluation. No LLM answer grading or harness comparison."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import platform
from importlib.metadata import version
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tool_library.obsidian_retrieval import ObsidianRetrieval,SearchObsidianParameters,METHODS,EMBED_MODEL,EMBED_REVISION,RERANK_MODEL,RERANK_REVISION
ROOT=Path(__file__).resolve().parents[1]

def score(paths,relevance,k=3):
    values=[relevance.get(path,0) for path in paths[:k]]
    positives={p for p,g in relevance.items() if g>0}
    found=set(paths[:k])&positives
    dcg=sum((2**g-1)/math.log2(i+2) for i,g in enumerate(values))
    ideal=sum((2**g-1)/math.log2(i+2) for i,g in enumerate(sorted(relevance.values(),reverse=True)[:k]))
    return {'hit_at_3':float(bool(found)),'primary_hit_at_3':float(any(g==2 for g in values)),
            'recall_at_3':len(found)/len(positives),
            'mrr_at_3':next((1/(i+1) for i,g in enumerate(values) if g>0),0),
            'ndcg_at_3':dcg/ideal if ideal else 0}

def mean_metrics(rows):
    return {key:statistics.mean(r['metrics'][key] for r in rows) for key in ['hit_at_3','primary_hit_at_3','recall_at_3','mrr_at_3','ndcg_at_3']}

def evaluate(directory,repeats):
    manifest=json.loads((directory/'manifest.json').read_text());vault=Path(manifest['vault'])
    before={n['path']:hashlib.sha256((vault/n['path']).read_bytes()).hexdigest() for n in manifest['notes']}
    assert all(before[n['path']]==n['sha256'] for n in manifest['notes']), 'Source fixture changed'
    query_bytes=(ROOT/'fixtures/obsidian-retrieval/queries.json').read_bytes();queries=json.loads(query_bytes)
    assert len({q['id'] for q in queries})==len(queries)
    assert all(set(q['relevance'])<=set(before) and q['relevance'] for q in queries)
    (directory/'frozen-queries.json').write_bytes(query_bytes)
    service=ObsidianRetrieval(vault,directory/'cache')
    cold={}
    for method in METHODS:
        result=service.search(SearchObsidianParameters(query=queries[0]['query'],max_results=3,method=method))
        cold[method]=result['elapsed_ms'];print('WARMED',method,round(cold[method],2),'ms',flush=True)
    rows=[]
    for repeat in range(repeats):
        ordered=queries[:];random.Random(1200+repeat).shuffle(ordered)
        for query in ordered:
            methods=list(METHODS);random.Random(1000+repeat*len(queries)+queries.index(query)).shuffle(methods)
            for method in methods:
                result=service.search(SearchObsidianParameters(query=query['query'],max_results=3,method=method))
                paths=[r['path'] for r in result['results']]
                rows.append({'id':query['id'],'query':query['query'],'group':query['group'],'repeat':repeat+1,
                    'method':method,'paths':paths,'elapsed_ms':result['elapsed_ms'],'metrics':score(paths,query['relevance'])})
        print('REPEAT_COMPLETE',repeat+1,flush=True)
    after={p:hashlib.sha256((vault/p).read_bytes()).hexdigest() for p in before};assert before==after,'Vault modified'
    summary={}
    for method in METHODS:
        subset=[r for r in rows if r['method']==method];timings=sorted(r['elapsed_ms'] for r in subset)
        summary[method]={**mean_metrics(subset),'runs':len(subset),'median_ms':statistics.median(timings),
            'p95_ms':timings[math.ceil(len(timings)*.95)-1], 'total_seconds':sum(timings)/1000,
            'by_group':{g:mean_metrics([r for r in subset if r['group']==g]) for g in sorted({q['group'] for q in queries})}}
    report={'runtime':{'python':platform.python_version(),'platform':platform.platform(),
       'packages':{name:version(name) for name in ['fastmcp','pydantic','sentence-transformers','transformers','torch','numpy','rank-bm25','jieba']}},
       'notes':len(before),'chunks':len(service.chunks),'queries':len(queries),'repeats':repeats,
       'top_k':3,'query_sha256':hashlib.sha256(query_bytes).hexdigest(), 'cold_warmup_ms':cold,
       'models':{'embedding':{'id':EMBED_MODEL,'revision':EMBED_REVISION},'reranker':{'id':RERANK_MODEL,'revision':RERANK_REVISION}},
       'settings':{'device':'cpu','threads':4,'candidate_pool_per_retriever':40,'rerank_candidates':24,'rrf_constant':60,
                   'chunk_tokens':100,'overlap_tokens':20,'note_deduplication':True},
       'metrics_definition':{'recall_at_3':'relevant notes retrieved / all annotated relevant notes',
           'mrr_at_3':'reciprocal rank of first relevance>0 within top3','ndcg_at_3':'graded labels:2 primary,1 supporting',
           'primary_hit_at_3':'at least one primary note returned within top3'},
       'corpus_unchanged':True,'summary':summary,'rows':rows,
       'limits':'Small acceptance set authored for this feature, not a held-out general benchmark; unannotated notes count as nonrelevant. No evidence that retrieval ranking alone proves answer correctness.'}
    (directory/'comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    lines=['# Obsidian 检索验收结果','',f'{len(before)}篇独立验收笔记，{len(queries)}个固定查询，每组重复{repeats}次；统一Top3、同一分块和标注。','',
           '| 方法 | Hit@3 | 主相关命中@3 | Recall@3 | MRR@3 | nDCG@3 | 热启动中位数(ms) | P95(ms) |','|---|---:|---:|---:|---:|---:|---:|---:|']
    for method,row in summary.items():lines.append(f"| {method} | {row['hit_at_3']:.3f} | {row['primary_hit_at_3']:.3f} | {row['recall_at_3']:.3f} | {row['mrr_at_3']:.3f} | {row['ndcg_at_3']:.3f} | {row['median_ms']:.2f} | {row['p95_ms']:.2f} |")
    lines+=['','首轮初始化/索引/模型加载单独统计：'+json.dumps({k:round(v,2) for k,v in cold.items()})+' ms。',
             '','检索阶段没有LLM生成或付费API请求；本地Embedding、重排序仍有CPU和模型存储开销。',
             '','标注与查询在测量前固定；没有根据输出改题、调模型或调整相关标签。资料为8篇在线厂商博客前部摘取与3篇明确标注的测试笔记。所有笔记字节保持不变。',
             '','小样本仅支持本验收集，不能据此证明生产效果。检索命中、实际读取和回答准确性分别判断。完整逐题结果见comparison.json。']
    (directory/'comparison.md').write_text('\n'.join(lines)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--directory',type=Path,default=ROOT/'reports/obsidian-retrieval/acceptance');parser.add_argument('--repeats',type=int,default=3)
    args=parser.parse_args()
    if not 1<=args.repeats<=10:parser.error('repeats must be1–10')
    evaluate(args.directory,args.repeats)
