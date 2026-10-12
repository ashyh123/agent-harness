import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from pydantic import ValidationError
from fastmcp import Client
from obsidian_mcp_server import create_server
from tool_library.errors import ToolError
from tool_library.parameters import SearchParameters, ToolParameters
from tool_library.obsidian_retrieval import ObsidianRetrieval, SearchObsidianParameters, ReadObsidianParameters, LocalModels

class FakeModels:
    fingerprint='offline-fake-v1'
    def __init__(self):self.embeds=0;self.reranks=0
    def split(self,n):return [{'path':n.path,'offset':0,'end_offset':len(n.text),'text':n.text,'model_text':n.text}]
    def embed(self,texts):
        self.embeds+=1
        return np.array([[1,0] if ('后台' in x or 'background' in x) else [0,1] for x in texts],dtype=np.float32)
    def rerank(self,q,texts):
        self.reranks+=1
        return np.array([3 if '后台' in x else 0 for x in texts])

class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.vault=self.root/'vault';self.vault.mkdir()
        self.models=FakeModels();self.service=ObsidianRetrieval(self.vault,self.root/'cache',models=self.models)
    def write(self,path,body):
        p=self.vault/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(body);return p
    def test_models_reuse_original_validation_and_reject_coercion(self):
        self.assertTrue(issubclass(SearchObsidianParameters,SearchParameters))
        self.assertTrue(issubclass(ReadObsidianParameters,ToolParameters))
        for kwargs in [{'query':' '},{'query':'x','max_results':'3'},{'query':'x','method':'magic'},{'query':'x','unexpected':1}]:
            with self.assertRaises(ValidationError):SearchObsidianParameters(**kwargs)
        with self.assertRaises(ValidationError):ReadObsidianParameters(path='x.md',limit=10001)
    def test_empty_vault_does_not_load_models_or_invent_results(self):
        r=self.service.search(SearchObsidianParameters(query='后台',method='hybrid'))
        self.assertEqual(r['results'],[]);self.assertEqual(self.models.embeds,0)
    def test_omitted_method_uses_vector_and_explicit_choices_still_work(self):
        self.write('后台.md','# 后台任务\n窗口关闭后继续执行。')
        result=self.service.search(SearchObsidianParameters(query='background'))
        self.assertEqual(result['method'],'vector')
        self.assertEqual(result['results'][0]['path'],'后台.md')
        lexical=self.service.search(SearchObsidianParameters(query='background',method='bm25'))
        self.assertEqual(lexical['method'],'bm25');self.assertEqual(lexical['results'],[])
        hybrid=self.service.search(SearchObsidianParameters(query='background',method='hybrid'))
        self.assertEqual(hybrid['method'],'hybrid');self.assertTrue(hybrid['results'])
        configured=ObsidianRetrieval(self.vault,self.root/'cache',models=self.models,default_method='bm25')
        self.assertEqual(configured.search(SearchObsidianParameters(query='background'))['method'],'bm25')
    def test_neural_input_is_not_silently_truncated(self):
        models=LocalModels()
        models._tokenizer=lambda text,**kwargs: {'input_ids':list(range(len(text)))}
        with self.assertRaises(ToolError) as ctx:models.embed(['字'*129])
        self.assertEqual(ctx.exception.code,'embedding_input_too_long')
        self.assertIsNone(models._embedder)
    def test_all_modes_return_actual_locations_and_preserve_bytes(self):
        self.write('阅读笔记/后台.md','---\nstatus: 已读\n---\n# 后台任务\n我的正文🙂，保留 [[概念]]。')
        self.write('文章卡片/data.md','# 数据处理\nJSON rows columns')
        before={str(p):p.read_bytes() for p in self.vault.rglob('*.md')}
        for method in ['bm25','vector','hybrid']:
            r=self.service.search(SearchObsidianParameters(query='后台任务',method=method))
            hit=r['results'][0];self.assertEqual(hit['path'],'阅读笔记/后台.md')
            read=self.service.store.read(ReadObsidianParameters(path=hit['path'],offset=hit['offset'],limit=1000,expected_sha256=hit['sha256']))
            self.assertIn('[[概念]]',read['content']);self.assertEqual(hit['status'],'已读')
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.vault.rglob('*.md')})
        self.assertEqual(self.models.reranks,1)
    def test_edit_deletion_and_rename_invalidate_index_and_old_hash(self):
        p=self.write('a.md','# 后台任务\nbackground');self.write('b.md','# Data')
        r=self.service.search(SearchObsidianParameters(query='后台',method='vector'));old=r['results'][0]
        generation=self.service._generation;p.write_text('# 修改后的正文')
        with self.assertRaises(ToolError) as ctx:self.service.store.read(ReadObsidianParameters(path='a.md',expected_sha256=old['sha256']))
        self.assertEqual(ctx.exception.code,'note_changed')
        self.service.search(SearchObsidianParameters(query='data',method='vector'));self.assertNotEqual(generation,self.service._generation)
        p.rename(self.vault/'renamed.md');(self.vault/'b.md').unlink()
        r=self.service.search(SearchObsidianParameters(query='修改',method='vector'))
        self.assertEqual([x['path'] for x in r['results']],['renamed.md'])
    def test_escape_symlinks_hidden_files_offsets_and_invalid_cache(self):
        self.write('a.md','# 后台任务\n🙂 hello')
        (self.vault/'link.md').symlink_to(self.vault/'a.md')
        self.write('.obsidian/secret.md','secret')
        for path in ['../outside.md','/etc/passwd','.obsidian/secret.md','link.md']:
            with self.assertRaises(ToolError):self.service.store.read(ReadObsidianParameters(path=path))
        with self.assertRaises(ToolError):self.service.store.read(ReadObsidianParameters(path='a.md',offset=1000))
        r=self.service.search(SearchObsidianParameters(query='后台',method='vector'));self.assertEqual(r['note_count'],1)
        np.save(self.root/'cache'/f'{self.service._generation}.npy',np.array(3))
        self.service._vectors=None
        self.assertTrue(self.service.search(SearchObsidianParameters(query='后台',method='vector'))['results'])
    def test_real_fastmcp_discovery_validation_read_and_errors(self):
        self.write('a.md','# 后台任务\n这是测试正文，[[关联]]。')
        async def run():
            async with Client(create_server(self.service)) as client:
                tools=await client.list_tools();self.assertEqual({t.name for t in tools},{'search_obsidian','read_obsidian'})
                for t in tools:self.assertTrue(t.annotations.read_only_hint)
                result=await client.call_tool('search_obsidian',{'request':{'query':'后台','method':'bm25'}})
                hit=result.data['results'][0]
                result=await client.call_tool('read_obsidian',{'request':{'path':hit['path'],'expected_sha256':hit['sha256']}})
                self.assertIn('测试正文',result.data['content'])
                for name,args in [('search_obsidian',{'query':'后台','max_results':'3'}),('search_obsidian',{'query':'后台','extra':True}),('read_obsidian',{'path':'../bad.md'})]:
                    result=await client.call_tool(name,{'request':args},raise_on_error=False)
                    self.assertTrue(result.is_error)
        asyncio.run(run())

if __name__=='__main__':unittest.main()
