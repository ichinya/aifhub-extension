"""Python 3.11+: kernel/bridge probe; no provider, daemon or external dependencies.

Usage: python3 kernel-probe.py <clean Prime Agent v0.9.1 source checkout>
All writes and subprocess marker files stay in one temporary fixture directory.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading

REVISION = "81ae3cb34d27d38ee37f9e205a1e73694993b344"
checkout = Path(sys.argv[1]).resolve()
runtime = "prime-agent-runtime/src/rlm"


def git(*args):
    return subprocess.check_output(["git", "-C", str(checkout), *args])


assert git("rev-parse", "HEAD").decode().strip() == REVISION, "Use the pinned checkout"
assert not git("status", "--porcelain", "--untracked-files=all", "--", runtime).strip(), "Runtime must be clean"
source_hashes = {
    name: hashlib.sha256(git("show", f"{REVISION}:{runtime}/{name}")).hexdigest()
    for name in ("__init__.py", "harness.py", "repl.py", "bash.py")
}
checks = []

with tempfile.TemporaryDirectory(prefix="aifhub-prime-kernel-") as temp:
    root = Path(temp).resolve()
    assert root.parent == Path(tempfile.gettempdir()).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    env = {
        "PATH": os.defpath,
        "PYTHONPATH": str(checkout / "prime-agent-runtime" / "src"),
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOME": str(root / "home"),
        "USERPROFILE": str(root / "home"),
        "PRIME_AGENT_CODING_AGENT_DIR": str(root / "agent"),
        "RLM_SESSION_DIR": str(root / "session"),
        "RLM_HARNESS_STATE_DIR": str(root / "session" / "harness"),
        "RLM_GLOBAL_HARNESS_STATE_DIR": str(root / "global-harness"),
    }
    if "SystemRoot" in os.environ:
        env["SystemRoot"] = os.environ["SystemRoot"]
    process = subprocess.Popen(
        [sys.executable, "-m", "rlm.repl"], cwd=workspace, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8",
    )
    frames = queue.Queue()

    def read_frames():
        for line in process.stdout:
            try:
                frames.put(json.loads(line))
            except ValueError:
                frames.put({"event": "invalid_json"})
        frames.put({"event": "eof"})

    reader = threading.Thread(target=read_frames, daemon=True)
    reader.start()

    def send(payload):
        process.stdin.write(json.dumps(payload) + "\n")
        process.stdin.flush()

    def finish(rid):
        events = []
        while True:
            event = frames.get(timeout=15)
            assert event["event"] not in ("invalid_json", "eof", "error"), event["event"]
            events.append(event)
            if event["event"] == "done" and event.get("id") == rid:
                assert event["status"] == "ok"
                return events

    def cell(rid, code):
        send({"type": "execute", "id": rid, "code": code})
        return finish(rid)

    def record(name):
        checks.append({"id": name, "observation_verified": True})

    try:
        assert frames.get(timeout=15)["event"] == "ready"
        cell("hello", "probe_value = 40 + 2")
        cell("persistent", "assert probe_value == 42")
        record("persistent_kernel_state")

        cell("python-write", "from pathlib import Path\nPath('../python-marker').write_text('fixture')")
        assert (root / "python-marker").read_text() == "fixture"
        record("direct_python_writes_outside_cwd_inside_fixture")
        cell("subprocess-write", "import subprocess, sys\nsubprocess.run([sys.executable, '-c', \"from pathlib import Path; Path('../subprocess-marker').write_text('fixture')\"], check=True)")
        assert (root / "subprocess-marker").read_text() == "fixture"
        record("direct_subprocess_writes_outside_cwd_inside_fixture")

        cell("harness", """import rlm
rlm.harness.create_subagent('Verifier', 'Read-only.', id='aifhub-verifier', metadata={'immutable': True})
rlm.harness.update_subagent('aifhub-verifier', 'Verifier', 'Changed policy.')
""")
        harness_file = root / "session" / "harness" / "harness_state.json"
        assert json.loads(harness_file.read_text())["entries"]["subagent"]["aifhub-verifier"]["content"] == "Changed policy."
        record("python_harness_metadata_does_not_prevent_update")
        cell("harness-delete", "assert rlm.harness.delete_subagent('aifhub-verifier')")
        assert "aifhub-verifier" not in json.loads(harness_file.read_text())["entries"]["subagent"]
        record("python_harness_metadata_does_not_prevent_delete")

        # Real Python bridge, synthetic host reply: no child agent is started.
        send({"type": "execute", "id": "spawn", "code": "handle = await rlm('Synthetic task', name='fixture-worker')"})
        while True:
            request = frames.get(timeout=15)
            assert request["event"] not in ("error", "eof", "invalid_json", "done")
            if request["event"] == "host_request":
                break
        assert request["data"]["type"] == "rlm.run"
        send({"type": "host_reply", "id": request["id"], "data": {"status": "ok", "result": {
            "rlm_child_id": "fixture-child", "name": "fixture-worker",
            "session_dir": str(root / "synthetic-child"), "model": "fixture/model",
        }}})
        finish("spawn")
        cell("handle", "assert set(handle.__dataclass_fields__) == {'rlm_child_id', 'name', 'session_dir', 'model'}\nassert not hasattr(handle, 'answer')")
        record("spawn_bridge_returns_admission_handle_with_mock_host")

        send({"type": "shutdown", "id": "shutdown"})
        finish("shutdown")
        assert process.wait(timeout=15) == 0
        record("kernel_shutdown_exit_zero")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=15)
        process.stdin.close()
        reader.join(timeout=2)
        process.stdout.close()
        process.stderr.close()

print(json.dumps({
    "upstream_revision": REVISION, "python": sys.version.split()[0],
    "level": "real_kernel_with_synthetic_host_reply", "source_sha256": source_hashes,
    "provider_calls": 0, "real_child_agents": 0, "adoption_pass": False, "checks": checks,
}, indent=2))
