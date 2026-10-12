"""Install the read-only MCP and study skill in OMP's native user directory."""
import argparse
import hashlib
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.install_obsidian_cursor import install as install_mcp


def install(agent_dir, vault, *, previous_skill_sha256=None):
    agent_dir = Path(agent_dir).expanduser().absolute()
    vault = Path(vault).expanduser().absolute()
    skill_dir = agent_dir / 'skills/obsidian-study'
    skill_path = skill_dir / 'SKILL.md'
    if skill_path.is_symlink() or skill_dir.is_symlink():
        raise ValueError('Refusing symlink skill')
    content = (ROOT / 'vercel_agent/omp-skills/obsidian-study/SKILL.md').read_text().replace('__VAULT_PATH__', str(vault))
    existing = skill_path.read_bytes() if skill_path.exists() else None
    if existing is not None and existing != content.encode():
        if not previous_skill_sha256 or hashlib.sha256(existing).hexdigest() != previous_skill_sha256:
            raise ValueError(f'Existing different skill; provide its reviewed SHA-256 to update: {skill_path}')
    # Reuse the same stdio definition and merge guard as Cursor. No model config or credentials.
    config = install_mcp(agent_dir / 'mcp.json', vault, update_method=True)
    skill_dir.mkdir(parents=True, exist_ok=True)
    if existing != content.encode():
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=skill_dir, delete=False) as file:
            temporary = Path(file.name)
            file.write(content)
        try:
            os.replace(temporary, skill_path)
        finally:
            temporary.unlink(missing_ok=True)
    return config, skill_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent-dir', type=Path, default=Path(os.environ.get('PI_CODING_AGENT_DIR', Path.home() / '.omp/agent')))
    parser.add_argument('--vault', type=Path, default=Path(os.environ.get('MINIMAL_AGENT_OBSIDIAN_VAULT', Path.home() / 'Documents/Obsidian/Agent 博客阅读')))
    parser.add_argument('--previous-skill-sha256', help='Approve replacing only the reviewed installed skill bytes')
    args = parser.parse_args()
    for path in install(args.agent_dir, args.vault, previous_skill_sha256=args.previous_skill_sha256):
        print(path)
