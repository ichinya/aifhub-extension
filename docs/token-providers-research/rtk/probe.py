#!/usr/bin/env python3
"""Manual Linux RTK 0.48.0 observation/privacy probe; no agent or model calls.

Runs only synthetic commands in a disposable project and child-only HOME/XDG
directories. Does not install RTK, configure the real user, or retain raw output.
stdout is an aggregate JSON report. Requires Python 3.11+ and pytest 8.4.2.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import secrets
import sqlite3
import subprocess
import sys
import tempfile


SOURCE_COMMIT = "fde0a8f185945556f51718de0f4c430bb62b3df6"
BINARY_SHA256 = "64c01578fec180a1b1f093e882bc8a673f0a3bf7ecf7094950fec6d897872e01"
SENSITIVE = ["curl", "mysql", "psql", "docker", "sshpass", "gh", "aws", "gcloud"]
EVIDENCE = ["cat", "head", "tail", "rg", "grep", "git diff", "git log",
            "git show", "git blame", "pytest", "cargo", "go", "npm", "pnpm",
            "yarn", "bun", "vitest", "jest", "mocha", "playwright"]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, label):
    if not condition:
        raise RuntimeError(label)


def config(excluded=(), tee="never", tracking=True, tee_enabled=False):
    # RTK 0.48.0 requires every non-optional field of present tee/tracking tables.
    return (f"[hooks]\nexclude_commands = {json.dumps(list(excluded))}\n"
            f"[tee]\nenabled = {str(tee_enabled).lower()}\n"
            f'mode = "{tee}"\nmax_files = 20\nmax_file_size = 1048576\n'
            f"[tracking]\nenabled = {str(tracking).lower()}\nhistory_days = 90\n"
            "[telemetry]\nenabled = false\n")


def run_probe(binary):
    require(platform.system() == "Linux", "linux_isolation_required")
    require(digest(binary.read_bytes()) == BINARY_SHA256, "binary_digest_mismatch")
    require(importlib.metadata.version("pytest") == "8.4.2", "pytest_version_mismatch")
    report = {
        "schema": "aifhub.rtk_observation_probe.v1",
        "provider_version": "0.48.0", "provider_source_commit": SOURCE_COMMIT,
        "binary_sha256": BINARY_SHA256,
        "harness_sha256": digest(Path(__file__).read_bytes()),
        "platform": platform.system(), "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "python_packages": {name: importlib.metadata.version(name) for name in
                            ["pytest", "pluggy", "packaging", "iniconfig", "pygments"]},
        "model": None, "lifecycle_ab": "NOT_RUN(observation_and_privacy_gates_failed)",
        "decision": "reject_defer", "observations": {},
    }
    obs = report["observations"]
    with tempfile.TemporaryDirectory(prefix="aifhub-rtk-probe-") as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        # Never inherit credentials, Git config, Python plugins or runtime homes.
        env = {
            "PATH": os.pathsep.join([str(Path(sys.executable).parent),
                                     str(binary.parent), "/usr/bin", "/bin"]),
            "HOME": str(root / "home"), "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"), "XDG_CACHE_HOME": str(root / "cache"),
            "HERMES_HOME": str(root / "hermes"), "CODEX_HOME": str(root / "codex"),
            "CLAUDE_CONFIG_DIR": str(root / "claude"),
            "RTK_DB_PATH": str(root / "tracking.db"), "RTK_TEE_DIR": str(root / "tee"),
            "RTK_TELEMETRY_DISABLED": "1", "NO_COLOR": "1", "TERM": "dumb",
            "LC_ALL": "C.UTF-8", "TZ": "UTC", "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0",
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1", "PYTHONDONTWRITEBYTECODE": "1",
        }
        for name in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
                     "HERMES_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]:
            Path(env[name]).mkdir(parents=True, exist_ok=True)
        settings = root / "config/rtk/config.toml"
        settings.parent.mkdir()

        def execute(args, data=None):
            return subprocess.run([str(a) for a in args], cwd=project, env=env,
                                  input=data, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, timeout=30, check=False)

        def rtk(*args, data=None):
            return execute([binary, *args], data)

        def ok(args):
            result = execute(args)
            require(result.returncode == 0, "fixture_command_failed")
            return result

        def configure(body):
            settings.write_text(body, encoding="utf-8")
            return rtk("config")

        require(configure(config()).returncode == 0, "isolated_config_invalid")
        require(str(settings).encode() in rtk("config").stdout, "config_isolation_failed")
        require(rtk("--version").stdout.strip() == b"rtk 0.48.0", "version_mismatch")
        report["git_version"] = ok(["git", "--version"]).stdout.decode().strip()

        # Paired file reads: full spec, gate block, coverage, readiness and trace.
        fixtures = {
            "openspec/changes/probe/specs/evidence/spec.md":
                '# Evidence\n\n<!-- exact comment -->\n\n```aif-gate-result\n'
                '{"gate":"verify","status":"PASS","detail":"  exact  "}\n```\n\n'
                + "\n".join(f"Requirement {i}: preserve exact evidence." for i in range(90)) + "\n",
            "openspec/specs/evidence/spec.md": "# Evidence\n\nExact canonical requirement.\n",
            ".ai-factory/qa/probe/coverage.json": '{\n  "coverage": [1, 2],\n  "exact": "  spaced  "\n}\n',
            ".ai-factory/qa/probe/done-readiness.json": '{"ready":false,"gates":["verify"]}\n',
            ".ai-factory/rules/generated/probe/trace.json": '{"trace":[{"line":91,"exact":"rule"}]}\n',
        }
        for name, body in fixtures.items():
            path = project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        reads = []
        for name, body in fixtures.items():
            raw = ok(["cat", name])
            compact = rtk("read", name)
            cat = rtk("cat", name)
            proxy = rtk("proxy", "cat", name)
            reads.append({
                "raw_bytes": len(raw.stdout), "read_bytes": len(compact.stdout),
                "read_exact": compact.returncode == 0 and compact.stdout == raw.stdout,
                "cat_exact": cat.returncode == 0 and cat.stdout == raw.stdout,
                "proxy_exact": proxy.returncode == 0 and proxy.stdout == raw.stdout
                               and proxy.stderr == raw.stderr,
            })
        obs["protected_reads"] = reads
        spec = next(iter(fixtures))
        obs["bounded_read_exact"] = rtk("read", "--max-lines", "10", spec).stdout == fixtures[spec].encode()
        obs["cat_subcommand_supported"] = rtk("cat", spec).returncode == 0

        # Git overview versus exact patches/history on one deterministic repository.
        ok(["git", "init", "-q"])
        ok(["git", "config", "user.name", "Fixture Author"])
        ok(["git", "config", "user.email", "fixture@example.invalid"])
        ok(["git", "config", "core.autocrlf", "false"])
        module = project / "module.txt"
        module.write_text("".join(f"before-{i:03d}\n" for i in range(180)))
        ok(["git", "add", "."])
        env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = "2026-01-02T03:04:05+00:00"
        ok(["git", "commit", "-qm", "Fixture history title\n\nExact historical body for review."])
        module.write_text("".join(f"after-{i:03d}\n" for i in range(180)))
        obs["git"] = {}
        for label, command, args in [("diff", "diff", []), ("log", "log", ["-n", "50"]),
                                     ("log_stat", "log", ["--stat", "-n", "50"]), ("show", "show", ["HEAD"])]:
            raw = ok(["git", command, *args])
            compact = rtk("git", command, *args)
            proxy = rtk("proxy", "git", command, *args)
            obs["git"][label] = {
                "raw_bytes": len(raw.stdout), "compressed_bytes": len(compact.stdout),
                "compressed_exact": compact.returncode == 0 and compact.stdout == raw.stdout,
                "proxy_exact": proxy.returncode == 0 and proxy.stdout == raw.stdout
                               and proxy.stderr == raw.stderr,
            }

        # Real pytest: 12 distinct failures, long assertion and source context.
        marker = secrets.token_hex(16)
        test_file = project / "test_failure.py"
        test_file.write_text(
            "import pytest\n\n@pytest.mark.parametrize('case', range(12))\n"
            "def test_failure(case):\n"
            "    observed = 'actual-' + str(case)\n"
            f"    expected = '{'x' * 180}' + str(case)\n"
            f"    print('{marker}')\n"
            "    assert observed == expected\n", encoding="utf-8")
        args = ["--tb=long", "-q", "--color=no", "-p", "no:cacheprovider", "test_failure.py"]
        raw = execute(["pytest", *args])
        compact = rtk("pytest", *args)
        proxy = rtk("proxy", "pytest", *args)

        def diagnostics(result):
            match = re.search(rb"=+ FAILURES =+\n(.*?)=+ short test summary info =+", result.stdout, re.S)
            return match.group(1) if match else b""

        raw_diagnostics = diagnostics(raw)
        require(raw.returncode == 1 and raw_diagnostics, "pytest_fixture_failed")
        obs["pytest"] = {
            "raw_exit": raw.returncode, "compressed_exit": compact.returncode, "proxy_exit": proxy.returncode,
            "raw_bytes": len(raw.stdout), "compressed_bytes": len(compact.stdout),
            "compressed_diagnostics_exact": raw_diagnostics in compact.stdout,
            "proxy_diagnostics_exact": diagnostics(proxy) == raw_diagnostics,
            "compressed_case_names_present": sum(f"test_failure[{i}]".encode() in compact.stdout for i in range(12)),
            "total_cases": 12, "tee_disabled_files": len(list((root / "tee").glob("*"))),
        }
        require(configure(config(tee_enabled=True)).returncode == 0, "tee_config_invalid")
        rtk("pytest", *args)
        obs["tee_mode_never_files"] = len(list((root / "tee").glob("*")))
        require(configure(config(tee="failures", tee_enabled=True)).returncode == 0, "tee_config_invalid")
        rtk("pytest", *args)
        tee_files = list((root / "tee").glob("*"))
        obs["tee_failures"] = {"files": len(tee_files),
                               "synthetic_sensitive_output_persisted": any(marker.encode() in p.read_bytes() for p in tee_files)}
        env["RTK_TEE"] = "0"
        env["RTK_TEE_DIR"] = str(root / "tee-env-disabled")
        rtk("pytest", *args)
        obs["tee_env_disabled_files"] = len(list((root / "tee-env-disabled").glob("*")))
        del env["RTK_TEE"]
        require(configure(config(SENSITIVE + EVIDENCE)).returncode == 0, "exclusions_config_invalid")

        # Only rewrite decisions: secret-shaped command strings are never executed.
        commands = [f"curl -u user:{marker} https://example.invalid", f"mysql -p{marker}",
                    f"psql postgresql://user:{marker}@localhost/db", f"docker login -p {marker}",
                    f"sshpass -p {marker} ssh example.invalid", f"gh api x -H Authorization:{marker}",
                    f"aws sts get-caller-identity --token-code {marker}", f"gcloud auth print-access-token {marker}"]
        obs["sensitive_exclusions"] = [rtk("rewrite", command).returncode == 1 for command in commands]
        evidence_commands = [f"cat {spec}", "git diff", "git log --stat -n 50", "git show HEAD",
                             "pytest --tb=long", "cargo test", "go test ./...", "npm test"]
        obs["evidence_exclusions"] = [rtk("rewrite", command).returncode == 1 for command in evidence_commands]
        obs["overview_still_rewrites"] = rtk("rewrite", "git status").stdout == b"rtk git status"
        obs["raw_prefix_not_rewritten"] = rtk("rewrite", "RTK_DISABLED=1 git status").returncode == 1
        proxy_rewrite = rtk("rewrite", "rtk proxy git diff")
        obs["explicit_proxy_not_rewritten"] = (proxy_rewrite.returncode in (0, 1, 3)
            and proxy_rewrite.stdout.strip() in (b"", b"rtk proxy git diff"))

        # The short TOML proposed in the issue is not valid for this release.
        bad = configure(f"[hooks]\nexclude_commands = {json.dumps(SENSITIVE)}\n[tee]\nmode = \"never\"\n")
        obs["partial_config"] = {"rejected": bad.returncode != 0,
                                 "excluded_curl_rewritten": rtk("rewrite", "curl https://example.invalid").returncode in (0, 3)}
        require(configure(config(SENSITIVE + EVIDENCE, tracking=False)).returncode == 0, "tracking_config_invalid")

        # RTK observes argv even on proxy, and excluded hook calls may still log.
        rtk("proxy", "echo", marker)
        payload = {"tool_name": "Bash", "session_id": "fixture-session", "tool_use_id": "fixture-call",
                   "cwd": str(project), "tool_input": {"command": commands[0]}}
        hook = rtk("hook", "claude", data=json.dumps(payload).encode())
        require(hook.returncode == 0, "claude_hook_probe_failed")
        with sqlite3.connect(root / "tracking.db") as database:
            obs["tracking_disabled"] = {
                "proxy_arguments_persisted": database.execute(
                    "SELECT count(*) FROM commands WHERE original_cmd LIKE ? AND rtk_cmd LIKE 'rtk proxy%'",
                    (f"%{marker}%",)).fetchone()[0] > 0,
                "excluded_hook_arguments_persisted": any(marker in str(row) for row in database.execute("SELECT * FROM hook_decisions")),
                "hook_exit": hook.returncode, "hook_left_command_raw": hook.stdout == b"",
            }
        gain = rtk("gain", "--history")
        obs["gain_history"] = {"exit": gain.returncode,
                               "synthetic_argument_fragment_exposed": marker[:6].encode() in gain.stdout,
                               "private_project_path_exposed": str(project).encode() in gain.stdout}

        # Raw streaming preserves both byte streams beyond the tracking capture cap.
        stream = "import sys;sys.stdout.buffer.write(b'A'*1100000+b'\\xff');sys.stderr.buffer.write(b'B'*1100000+b'\\xfe');sys.exit(7)"
        direct = execute([sys.executable, "-c", stream])
        proxied = rtk("proxy", sys.executable, "-c", stream)
        obs["proxy_streams"] = {"stdout_exact": direct.stdout == proxied.stdout,
                                "stderr_exact": direct.stderr == proxied.stderr,
                                "exit_exact": direct.returncode == proxied.returncode == 7}

        # Installer lifecycle runs only with explicit disposable runtime homes.
        hermes = Path(env["HERMES_HOME"])
        initial = "plugins:\n  enabled:\n    - fixture-plugin\nmodel: fixture-model\n"
        (hermes / "config.yaml").write_text(initial)
        install = rtk("init", "-g", "--agent", "hermes")
        installed_files = sorted(str(p.relative_to(hermes)) for p in hermes.rglob("*") if p.is_file())
        patched = (hermes / "config.yaml").read_bytes()
        reinstall = rtk("init", "-g", "--agent", "hermes")
        idempotent = patched == (hermes / "config.yaml").read_bytes()
        uninstall = rtk("init", "-g", "--agent", "hermes", "--uninstall")
        obs["hermes_install"] = {
            "exit_codes": [install.returncode, reinstall.returncode, uninstall.returncode],
            "installed_files": installed_files, "config_idempotent": idempotent,
            "uninstall_restored_fixture_config": (hermes / "config.yaml").read_text() == initial,
            "plugin_removed": not (hermes / "plugins/rtk-rewrite/__init__.py").exists(),
            "live_host_and_subagents": "NOT_RUN",
        }
        codex = Path(env["CODEX_HOME"])
        (codex / "AGENTS.md").write_text("# Fixture guidance\n")
        (codex / "config.toml").write_text('model = "fixture-model"\n')
        install = rtk("init", "-g", "--codex")
        installed_files = sorted(str(p.relative_to(codex)) for p in codex.rglob("*") if p.is_file())
        injected = b"RTK" in (codex / "AGENTS.md").read_bytes()
        uninstall = rtk("init", "-g", "--codex", "--uninstall")
        obs["codex_install"] = {
            "exit_codes": [install.returncode, uninstall.returncode], "installed_files": installed_files,
            "instructions_injected": injected,
            "original_guidance_preserved": "# Fixture guidance" in (codex / "AGENTS.md").read_text(),
            "config_unchanged": (codex / "config.toml").read_text() == 'model = "fixture-model"\n',
            "live_host_and_subagents": "NOT_RUN",
        }
        obs["protected_files_unchanged"] = all((project / name).read_bytes() == body.encode() for name, body in fixtures.items())
        serialized = json.dumps(report)
        require(marker not in serialized and str(root) not in serialized, "aggregate_privacy_failed")
    report["temporary_state_removed"] = not root.exists()
    require(report["temporary_state_removed"], "temporary_cleanup_failed")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rtk", type=Path, required=True)
    options = parser.parse_args()
    try:
        result = run_probe(options.rtk.resolve(strict=True))
    except Exception:
        # Raw subprocess diagnostics, private paths and canaries never reach output.
        print('{"status":"ERROR","reason":"probe_incomplete_no_evidence_claim"}', file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, indent=2))
