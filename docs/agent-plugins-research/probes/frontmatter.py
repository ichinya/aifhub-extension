"""Diagnostic only: trusted AIFHub snapshot + pinned skills-ref environment.

Usage: python -X utf8 frontmatter.py BASELINE OUTPUT_SCRATCH
Prints JSON; writes candidate SKILL.md files only under a new scratch directory.
Does not change source skills or install/register anything.
"""
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

import strictyaml
from skills_ref.parser import parse_frontmatter
from skills_ref.validator import ALLOWED_FIELDS, validate

root, scratch = map(Path, sys.argv[1:3])
scratch.mkdir(parents=True, exist_ok=False)
rows = []
for name in ("aif-analyze", "aif-done", "aif-mode"):
    source = root / "skills" / name / "SKILL.md"
    text = source.read_text(encoding="utf-8")
    metadata, _ = parse_frontmatter(text)
    # Preserve body bytes after the frontmatter separator, including whitespace.
    body = text.split("---", 2)[2]
    normalized = {k: v for k, v in metadata.items() if k in ALLOWED_FIELDS}
    normalized["metadata"] = dict(normalized.get("metadata", {}))
    moved = sorted(set(metadata) - ALLOWED_FIELDS)
    for key in moved:
        target = "aifhub.source." + key
        if target in normalized["metadata"]:
            raise ValueError("metadata collision: " + target)
        normalized["metadata"][target] = str(metadata[key])
    variants = {"original": text, "normalized": "---\n" + strictyaml.as_document(normalized).as_yaml() + "---" + body}
    if "disable-model-invocation" in metadata:
        preserved = dict(normalized)
        preserved["disable-model-invocation"] = metadata["disable-model-invocation"]
        variants["preserve_invocation"] = "---\n" + strictyaml.as_document(preserved).as_yaml() + "---" + body
    for variant, content in variants.items():
        folder = scratch / variant / name
        folder.mkdir(parents=True)
        target = folder / "SKILL.md"
        target.write_text(content, encoding="utf-8", newline="\n")
        cli = subprocess.run([sys.executable, "-X", "utf8", "-m", "skills_ref.cli", "validate", str(folder)], capture_output=True, text=True, encoding="utf-8")
        rows.append({"skill": name, "variant": variant, "moved_fields": moved if variant != "original" else [],
                     "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "errors": validate(folder),
                     "cli_exit": cli.returncode, "stdout": cli.stdout.strip().replace(str(folder), "<skill>"),
                     "stderr": cli.stderr.strip().replace(str(folder), "<skill>")})
print(json.dumps({"python": sys.version.split()[0], "skills_ref": importlib.metadata.version("skills-ref"),
                  "strictyaml": importlib.metadata.version("strictyaml"), "rows": rows}, indent=2, ensure_ascii=False))
