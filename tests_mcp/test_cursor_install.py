import json
from pathlib import Path
import tempfile
import unittest
from scripts.install_obsidian_cursor import install
class CursorInstallTests(unittest.TestCase):
    def test_merge_is_idempotent_preserves_other_servers_and_refuses_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'mcp.json';other={'command':'existing-command','args':['existing.py']}
            config.write_text(json.dumps({'mcpServers':{'other':other},'custom':True}))
            install(config,Path(directory)/'vault')
            contents=config.read_bytes();data=json.loads(contents)
            self.assertEqual(data['mcpServers']['other'],other);self.assertTrue(data['custom'])
            self.assertNotIn('API_KEY',data['mcpServers']['obsidian-learning']['env'])
            self.assertEqual(data['mcpServers']['obsidian-learning']['env']['OBSIDIAN_RETRIEVAL_METHOD'],'vector')
            install(config,Path(directory)/'vault');self.assertEqual(config.read_bytes(),contents)
            with self.assertRaises(ValueError):install(config,Path(directory)/'different')
            self.assertEqual(config.read_bytes(),contents)
    def test_symlink_config_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);actual=root/'real.json';actual.write_text('{}')
            alias=root/'alias.json';alias.symlink_to(actual)
            with self.assertRaises(ValueError):install(alias,root/'vault')
            self.assertEqual(actual.read_text(),'{}')
    def test_explicit_method_migration_preserves_vault_other_servers_and_custom_env(self):
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'mcp.json';vault=Path(directory)/'vault'
            install(config,vault,method='bm25')
            data=json.loads(config.read_text());entry=data['mcpServers']['obsidian-learning']
            entry['env']['OBSIDIAN_RETRIEVAL_CACHE']='/custom/cache'
            data['mcpServers']['other']={'command':'unchanged'}
            config.write_text(json.dumps(data))
            install(config,vault,update_method=True)
            after=json.loads(config.read_text())
            self.assertEqual(after['mcpServers']['other'],data['mcpServers']['other'])
            expected=json.loads(json.dumps(entry));expected['env']['OBSIDIAN_RETRIEVAL_METHOD']='vector'
            self.assertEqual(after['mcpServers']['obsidian-learning'],expected)
            before=config.read_bytes()
            with self.assertRaises(ValueError):install(config,Path(directory)/'another-vault',update_method=True)
            self.assertEqual(config.read_bytes(),before)
