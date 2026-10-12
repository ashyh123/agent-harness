"""Verify discovery and retrieval/read over real stdio, with no Cursor substitution claim."""
import asyncio,json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastmcp import Client
from fastmcp.client.transports import StdioTransport
ROOT=Path(__file__).resolve().parents[1]
async def verify():
    vault=ROOT/'reports/obsidian-retrieval/acceptance/vault'
    transport=StdioTransport(command=str(ROOT/'.venv-mcp/bin/python'),args=[str(ROOT/'obsidian_mcp_server.py')],
       env={'MINIMAL_AGENT_OBSIDIAN_VAULT':str(vault),'OBSIDIAN_RETRIEVAL_METHOD':'hybrid','HF_HUB_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false'},cwd=str(ROOT),keep_alive=False)
    async with Client(transport) as client:
        tools=await client.list_tools();assert {t.name for t in tools}=={'search_obsidian','read_obsidian'}
        result=await client.call_tool('search_obsidian',{'request':{'query':'关掉窗口再回来，还想保留之前的任务进度和结果，该学什么？','max_results':3}})
        hits=result.data['results'];assert hits
        notes=[]
        for hit in hits[:2]:
            read=await client.call_tool('read_obsidian',{'request':{'path':hit['path'],'offset':hit['offset'],'limit':1500,'expected_sha256':hit['sha256']}})
            assert read.data['sha256']==hit['sha256'];notes.append({'path':hit['path'],'sha256':hit['sha256'],'chars':len(read.data['content'])})
        report={'transport':'real stdio','tools':[t.name for t in tools],'search':result.data,'reads':notes,'passed':True}
        (ROOT/'reports/obsidian-retrieval/acceptance/stdio-smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'passed':True,'tools':[t.name for t in tools],'read_notes':notes},ensure_ascii=False))
if __name__=='__main__':asyncio.run(verify())
