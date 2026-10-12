"""Download only pinned model weights/tokenizers, without any paid inference API."""
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
from huggingface_hub import snapshot_download
from tool_library.obsidian_retrieval import EMBED_MODEL, EMBED_REVISION, RERANK_MODEL, RERANK_REVISION

if __name__ == '__main__':
    for model, revision in [(EMBED_MODEL, EMBED_REVISION), (RERANK_MODEL, RERANK_REVISION)]:
        print(f'Preparing {model}@{revision}', flush=True)
        snapshot_download(model, revision=revision, token=False,
                          allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model'])
    print('Pinned local models ready.')
