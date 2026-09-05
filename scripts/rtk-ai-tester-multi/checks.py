"""Local contract checks against actual TS, PHP and Python source.

No application services, network requests or original worktrees are used.
The same test basename appears under each repository label.
"""
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

import httpx


def observe(root: Path):
    root = root.resolve()
    module = (root / "repo-01/utils/status.ts").as_uri()
    script = (
        "const m=await import(" + json.dumps(module) + ");"
        "console.log(JSON.stringify(Object.fromEntries("
        "['success','failed','running','cancelled','queued','unknown'].map(x=>"
        "[x,{variant:m.deploymentStatusVariant(x),label:m.deploymentStatusLabel(x)}]))));"
    )
    client = json.loads(subprocess.check_output(
        [os.environ["BENCH_NODE"], "--input-type=module", "-e", script],
        encoding="utf-8", stderr=subprocess.DEVNULL,
    ))
    enum = root / "repo-02/app/Enums/DeploymentStatus.php"
    php = (
        "require $argv[1]; echo json_encode(array_column("
        "App\\Enums\\DeploymentStatus::cases(), 'value', 'name'));"
    )
    api = json.loads(subprocess.check_output(
        [os.environ["BENCH_PHP"], "-r", php, str(enum)], encoding="utf-8",
    ))
    sys.path.insert(0, str(root / "repo-05/src"))
    proxy = importlib.import_module("mcp_server.proxy")
    spec = importlib.import_module("mcp_server.spec")
    descriptor = spec.ToolDescriptor(
        operation_id="readDeployment", method="GET", path="/deployments/{deployment}",
        summary="fixture", description="fixture", required_ability="deployments:read",
        path_params=["deployment"],
    )
    original_request = proxy.httpx.request

    def call(status, body):
        proxy.httpx.request = lambda **_: httpx.Response(status, json=body)
        try:
            return proxy.ApiProxy("https://fixture.invalid").call(
                descriptor, "Bearer synthetic", deployment="fixture-id")
        finally:
            proxy.httpx.request = original_request

    rows = []
    for i, (status, expected) in enumerate([
        ("success", "success"), ("failed", "error"), ("running", "info"), ("cancelled", "warning"),
    ], 1):
        rows.append(dict(repo="repo-01", case=f"{i:02}", actual=client[status]["variant"], expected=expected))
    for i, name in enumerate(["PENDING", "RUNNING", "SUCCESS", "FAILED"], 1):
        rows.append(dict(repo="repo-02", case=f"{i:02}", actual=api[name], expected=name.lower()))
    for i, status in enumerate([401, 403, 404, 500], 1):
        result = call(status, {"message": "synthetic-private-detail"})
        rows.append(dict(repo="repo-05", case=f"{i:02}", actual="leaked" if "synthetic-private-detail" in result.content else "sanitized", expected="sanitized"))
    success = call(200, {"status": "success", "id": "fixture-id"})
    conflict = call(409, {"message": "revision conflict", "current_revision": 7})
    checks = {
        "allContractCases": all(x["actual"] == x["expected"] for x in rows),
        "queuedBadge": client["queued"]["variant"] == "info",
        "unknownBadge": client["unknown"]["variant"] == "default",
        "successLabel": client["success"]["label"] == "Успешно",
        "successfulPayloadPreserved": not success.is_error and json.loads(success.content) == {"status": "success", "id": "fixture-id"},
        "conflictPayloadPreserved": conflict.is_error and conflict.status == 409 and json.loads(conflict.content)["current_revision"] == 7,
        "errorStatusesPreserved": all(call(code, {}).is_error and call(code, {}).status == code for code in [401, 403, 404, 500]),
    }
    return rows, checks


if __name__ == "__main__":
    rows, checks = observe(Path(sys.argv[1]))
    print(json.dumps({"pass": all(checks.values()), "checks": checks, **({"observations": rows} if "--observations" in sys.argv else {})}))
    sys.exit(0 if all(checks.values()) else 1)
