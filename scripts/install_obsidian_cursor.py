"""Merge an isolated Cursor MCP server entry, preserving existing servers."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import copy
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from tool_library.obsidian_retrieval import DEFAULT_METHOD

def install(config_path,vault,name='obsidian-learning',method=DEFAULT_METHOD,audit=None,*,update_method=False):
    config_path=Path(config_path).expanduser().absolute()
    if config_path.is_symlink():raise ValueError('Refusing symlink config')
    existing=json.loads(config_path.read_text()) if config_path.exists() else {}
    entry={'type':'stdio','command':str(ROOT/'.venv-mcp/bin/python'),
        'args':[str(ROOT/'obsidian_mcp_server.py')],
        'env':{'MINIMAL_AGENT_OBSIDIAN_VAULT':str(Path(vault).expanduser().absolute()),'OBSIDIAN_RETRIEVAL_METHOD':method,
               'HF_HUB_OFFLINE':'1','TOKENIZERS_PARALLELISM':'false'}}
    if audit:entry['env']['OBSIDIAN_MCP_AUDIT_LOG']=str(Path(audit).absolute())
    servers=existing.setdefault('mcpServers',{})
    if name in servers and servers[name]!=entry:
        old=servers[name]
        if (not update_method or old.get('command')!=entry['command'] or old.get('args')!=entry['args']
            or old.get('env',{}).get('MINIMAL_AGENT_OBSIDIAN_VAULT')!=entry['env']['MINIMAL_AGENT_OBSIDIAN_VAULT']):
            raise ValueError(f'Existing different server {name}; not overwritten')
        # An explicit method migration changes this one field, preserving custom env/settings.
        entry=copy.deepcopy(old)
        entry['env']['OBSIDIAN_RETRIEVAL_METHOD']=method
    servers[name]=entry;config_path.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=config_path.parent,delete=False) as file:
        temporary=Path(file.name);json.dump(existing,file,ensure_ascii=False,indent=2);file.write('\n')
    try:os.replace(temporary,config_path)
    finally:temporary.unlink(missing_ok=True)
    assert json.loads(config_path.read_text())['mcpServers'][name]==entry
    return config_path

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config',type=Path,default=Path.home()/'.cursor/mcp.json')
    parser.add_argument('--vault',type=Path,default=Path.home()/'Documents/Obsidian/Agent 博客阅读')
    parser.add_argument('--name',default='obsidian-learning');parser.add_argument('--method',choices=['bm25','vector','hybrid'],default=DEFAULT_METHOD)
    parser.add_argument('--update-method',action='store_true',help='Only update the method of this project-owned server; keep the vault and other settings')
    parser.add_argument('--audit',type=Path)
    args=parser.parse_args();print(install(args.config,args.vault,args.name,args.method,args.audit,update_method=args.update_method))
