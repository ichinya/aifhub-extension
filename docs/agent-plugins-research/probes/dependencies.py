"""Read-only dependency research on a trusted, immutable git archive.

Usage: python -X utf8 dependencies.py BASELINE
Uses CommonMark inline/reference links and images; records repository path tokens
in prose/code separately. Does not copy a bundle or claim runtime completeness.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
from markdown_it import MarkdownIt

root = Path(sys.argv[1]).resolve()
parser = MarkdownIt("commonmark")
seeds = sorted(p.relative_to(root).as_posix() for name in ("aif-analyze", "aif-done", "aif-mode", "shared")
               for p in (root / "skills" / name).rglob("*") if p.is_file())
seen, pending, edges, missing, path_tokens = set(), list(seeds), [], [], []
repo_prefixes = "scripts|commands|docs|skills|schemas|agent-files|injections|adapters"
pattern = re.compile(r"(?<![\w/-])(?:" + repo_prefixes + r")/[A-Za-z0-9_./-]+")
while pending:
    name = pending.pop(0)
    if name in seen:
        continue
    seen.add(name)
    file = root / name
    if file.suffix.lower() != ".md":
        continue
    text = file.read_text(encoding="utf-8-sig")
    for token in parser.parse(text):
        for child in token.children or []:
            raw = child.attrGet("href") if child.type == "link_open" else child.attrGet("src") if child.type == "image" else None
            if not raw or raw.startswith("#") or urlsplit(raw).scheme or raw.startswith("//"):
                continue
            clean = unquote(raw.split("#")[0].split("?")[0])
            target = (file.parent / clean).resolve()
            try:
                relative = target.relative_to(root).as_posix()
            except ValueError:
                missing.append({"from": name, "target": raw, "reason": "outside-snapshot"})
                continue
            edge = {"from": name, "target": relative, "kind": "markdown-link"}
            if target.is_file():
                edges.append(edge)
                pending.append(relative)
            elif target.is_dir():
                edges.append({**edge, "kind": "directory-link-not-expanded"})
            else:
                missing.append({"from": name, "target": raw, "reason": "not-found"})
    for match in sorted(set(pattern.findall(text))):
        candidate = match.rstrip(".")
        target = root / candidate
        kind = "repository-file" if target.is_file() else "repository-directory" if target.is_dir() else "unresolved-or-example"
        path_tokens.append({"from": name, "target": candidate, "kind": kind})

inventory = [{"file": name, "bytes": (root / name).stat().st_size,
              "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()} for name in sorted(seen)]
external_tokens = sorted({item["target"] for item in path_tokens if item["kind"] == "repository-file" and item["target"] not in seen})
print(json.dumps({"algorithm": "commonmark-link-closure-v1", "seed_files": len(seeds), "closure_files": len(inventory),
                  "closure_bytes": sum(item["bytes"] for item in inventory), "inventory": inventory,
                  "edges": edges, "missing": missing, "path_tokens": path_tokens,
                  "additional_repository_files_in_instructions": external_tokens,
                  "limits": ["anchors not validated", "directory links not recursively copied", "prose/code path tokens are candidates, not proven dependencies", "dynamic runtime paths and code imports not resolved"]}, indent=2))
