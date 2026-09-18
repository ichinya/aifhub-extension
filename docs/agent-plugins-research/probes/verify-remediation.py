"""Read-only verification of a trusted research bundle against recorded evidence.

Usage: python -X utf8 verify-remediation.py BUNDLE RESULTS_JSON
Requires jsonschema==4.25.1. Does not certify untrusted bundles or host loading.
"""
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import sys

from jsonschema import Draft202012Validator


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(bundle, results):
    schema_file = Path(__file__).resolve().parent.parent / "snapshots/plugin.schema.json"
    schema_bytes = schema_file.read_bytes()
    schema_hash = hashlib.sha256(schema_bytes).hexdigest()
    require(schema_hash == "0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883", "Schema snapshot changed")
    require(version("jsonschema") == "4.25.1", "Expected jsonschema==4.25.1")
    evidence = json.loads(results.read_text(encoding="utf-8-sig"))
    rows = evidence["inventory"]
    expected = {row["file"]: row for row in rows}
    require(len(expected) == len(rows), "Duplicate inventory paths")
    actual = {p.relative_to(bundle).as_posix(): p for p in bundle.rglob("*") if p.is_file()}
    require(set(actual) == set(expected), "Bundle file set differs from inventory")
    for name, file in actual.items():
        data = file.read_bytes()
        require(len(data) == expected[name]["bytes"], f"Size mismatch: {name}")
        require(hashlib.sha256(data).hexdigest() == expected[name]["sha256"], f"Hash mismatch: {name}")
    require(len(actual) == evidence["bundle_files"], "File count mismatch")
    require(sum(row["bytes"] for row in rows) == evidence["bundle_bytes"], "Total size mismatch")
    require(not (bundle / "skills/aif-mode").exists(), "Manual-only skill must be excluded")
    require(not (bundle / "mcp.json").exists(), "Portable MCP must be excluded")
    schema = json.loads(schema_bytes)
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(json.loads((bundle / "plugin.json").read_text(encoding="utf-8")))
    return {
        "plugin_schema": "PASS", "schema_sha256": schema_hash,
        "jsonschema": version("jsonschema"), "inventory_hashes": "PASS",
        "checked_files": len(actual), "manual_only_skill_excluded": True,
        "portable_mcp_excluded": True, "full_client_loads": "NOT_RUN",
        "workflow_semantics_verified": "NOT_RUN",
    }


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: verify-remediation.py BUNDLE RESULTS_JSON")
    try:
        print(json.dumps(verify(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()), indent=2))
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f"Verification failed: {error}")
