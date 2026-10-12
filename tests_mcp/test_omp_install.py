import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.install_obsidian_omp import install


class OmpInstallTests(unittest.TestCase):
    def test_native_install_preserves_config_and_other_servers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            settings = root / 'config.yml'
            settings.write_text('modelRoles:\n  default: router/balanced\n')
            other = {'command': 'existing'}
            (root / 'mcp.json').write_text(json.dumps({'mcpServers': {'other': other}}))
            config, skill = install(root, root / 'vault')
            data = json.loads(config.read_text())
            self.assertEqual(data['mcpServers']['other'], other)
            self.assertEqual(data['mcpServers']['obsidian-learning']['env']['OBSIDIAN_RETRIEVAL_METHOD'], 'vector')
            self.assertEqual(settings.read_text(), 'modelRoles:\n  default: router/balanced\n')
            before = (config.read_bytes(), skill.read_bytes())
            install(root, root / 'vault')
            self.assertEqual(before, (config.read_bytes(), skill.read_bytes()))

    def test_skill_update_requires_reviewed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / 'skills/obsidian-study/SKILL.md'
            skill.parent.mkdir(parents=True)
            skill.write_text('custom user skill')
            with self.assertRaises(ValueError):
                install(root, root / 'vault')
            self.assertFalse((root / 'mcp.json').exists())
            digest = hashlib.sha256(skill.read_bytes()).hexdigest()
            skill.write_text('changed after review')
            with self.assertRaises(ValueError):
                install(root, root / 'vault', previous_skill_sha256=digest)
            self.assertEqual(skill.read_text(), 'changed after review')
            install(root, root / 'vault', previous_skill_sha256=hashlib.sha256(skill.read_bytes()).hexdigest())

    def test_mcp_conflict_does_not_overwrite_skill(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'mcp.json'
            config.write_text(json.dumps({'mcpServers': {'obsidian-learning': {'command': 'someone-else'}}}))
            before = config.read_bytes()
            with self.assertRaises(ValueError):
                install(root, root / 'vault')
            self.assertEqual(config.read_bytes(), before)
            self.assertFalse((root / 'skills/obsidian-study/SKILL.md').exists())
