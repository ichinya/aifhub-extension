"""Run one bounded T-Search candidate row without persisting snippets or transcripts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SCHEMA = "aifhub.t_search.ab_candidate.v1"
EXPECTED_HARNESS_REVISION = "997a0ba1685d24ad840e3e2542b59952ff3fb362"
EXPECTED_HARNESS_FILES = {
    "pyproject.toml": "c174f59b6209dad48ae8cc3e52bc7642380d8e097835b5c1e36ccaf813ef8346",
    "src/retriever_agent/agent.py": "8a6a7d656413e466d5441eaad5dfa07d17c1800ef2da10ddb562026abfc85085",
    "src/retriever_agent/config.py": "759de42d9481a1e9e614baffabb66c060073d4410d7b5780605e25aeb753dff4",
    "src/retriever_agent/prompts.py": "1820b060227c5ee04cb30d4dc8699420289f1e5054002533d49a03ad90eb0c74",
    "src/retriever_agent/tools/schemas.yaml": "bf256cacea9b11d76dd9d6339613b94471dce6565c110b0fd79d5ad78d387701",
}
EXPECTED_HARNESS_TREE_FILE_COUNT = 22
EXPECTED_HARNESS_TREE_DIGEST = (
    "d45facc5a9d2ee1e0166fa2e92fc9fc472d2a1a9e6d1ff11f608d0a4891f265c"
)
ALLOWED_EXTENSIONS = {
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".py",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
}
EXCLUDED_SEGMENTS = {".git", "node_modules", "vendor", "dist", "build", "coverage"}
STOP_WORDS = {
    "about",
    "after",
    "against",
    "application",
    "before",
    "does",
    "from",
    "into",
    "may",
    "system",
    "that",
    "the",
    "their",
    "them",
    "these",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "где",
    "для",
    "его",
    "или",
    "как",
    "какие",
    "когда",
    "после",
    "перед",
    "система",
    "что",
    "эта",
    "это",
}
MARKER = re.compile(
    r"^\s*(?://\s*chunk:\s*([a-z0-9-]+)|<!--\s*chunk:\s*([a-z0-9-]+)\s*-->)\s*$"
)
TOKEN = re.compile(r"[^\W_][\w.-]*", re.UNICODE)


@dataclass(frozen=True)
class Chunk:
    chunk_id: str
    relative_path: str
    start_line: int
    end_line: int
    content: str


class BoundaryError(RuntimeError):
    """Raised when the bounded source or privacy contract is violated."""


class ProvenanceError(RuntimeError):
    """Raised when the exact harness identity cannot be proven."""


class EndpointUnavailable(RuntimeError):
    """Raised when the loopback OpenAI-compatible endpoint is unavailable."""


class ModelIdentityError(RuntimeError):
    """Raised when the endpoint does not expose the pinned model alias."""


class RgSearchClient:
    """Use one bounded rg invocation per model search and return in-memory snippets."""

    def __init__(self, root: Path, chunks: list[Chunk]) -> None:
        self.root = root
        self.chunks = chunks
        self.persistent_state_created = False
        self.files = sorted({chunk.relative_path for chunk in chunks})
        self.by_path: dict[str, list[Chunk]] = {}
        for chunk in chunks:
            self.by_path.setdefault(chunk.relative_path, []).append(chunk)
        self.search_calls = 0
        self.query_hashes: list[str] = []
        self.snippet_bytes = 0

    def search(self, query: str, top_k: int) -> str:
        terms = tokenize_query(query)
        self.search_calls += 1
        self.query_hashes.append(hashlib.sha256(query.encode("utf-8")).hexdigest())
        if not terms:
            return "[]"

        args = ["rg", "--json", "--ignore-case", "--fixed-strings", "--no-messages"]
        for term in terms:
            args.extend(["-e", term])
        args.extend(["--", *self.files])
        completed = subprocess.run(
            args,
            cwd=self.root,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            shell=False,
            env=bounded_subprocess_env(),
        )
        if completed.returncode not in (0, 1):
            raise RuntimeError("rg_search_failed")

        scores: dict[str, dict[str, Any]] = {}
        for line in completed.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") != "match":
                continue
            data = event.get("data") or {}
            relative_path = normalize_relative(
                (data.get("path") or {}).get("text") or ""
            )
            line_number = int(data.get("line_number") or 0)
            chunk = next(
                (
                    item
                    for item in self.by_path.get(relative_path, [])
                    if item.start_line <= line_number <= item.end_line
                ),
                None,
            )
            if chunk is None:
                continue
            entry = scores.setdefault(
                chunk.chunk_id, {"chunk": chunk, "terms": set(), "matches": 0}
            )
            line_text = str((data.get("lines") or {}).get("text") or "").casefold()
            entry["terms"].update(term for term in terms if term in line_text)
            entry["matches"] += max(1, len(data.get("submatches") or []))

        ranking = sorted(
            scores.values(),
            key=lambda item: (
                -len(item["terms"]),
                -item["matches"],
                item["chunk"].chunk_id,
            ),
        )[: max(1, min(int(top_k), 50))]
        hits = []
        for index, item in enumerate(ranking):
            chunk: Chunk = item["chunk"]
            snippet = f"Source: {chunk.relative_path}\n{chunk.content[:1600]}"
            self.snippet_bytes += len(snippet.encode("utf-8"))
            hits.append(
                {
                    "docid": chunk.chunk_id,
                    "snippet": snippet,
                    "score": float(
                        len(item["terms"]) * 1000 + item["matches"] - index / 1000
                    ),
                }
            )
        return json.dumps(hits, ensure_ascii=False)


class MeteredLLMClient:
    """Collect aggregate token usage while delegating to the pinned client."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.total_tokens = 0
        self.calls = 0

    def call(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> tuple[Any | None, Any | None]:
        message, usage = self.inner.call(messages, tools)
        self.calls += 1
        if usage is not None:
            self.prompt_tokens += int(getattr(usage, "prompt_tokens", 0) or 0)
            self.completion_tokens += int(getattr(usage, "completion_tokens", 0) or 0)
            self.total_tokens += int(getattr(usage, "total_tokens", 0) or 0)
        return message, usage


def tokenize_query(query: str) -> list[str]:
    values = [value.casefold() for value in TOKEN.findall(str(query))]
    output: list[str] = []
    for value in values:
        if len(value) < 3 or value in STOP_WORDS or value in output:
            continue
        output.append(value)
        if len(output) >= 24:
            break
    return output


def normalize_relative(value: str) -> str:
    return value.replace("\\", "/").removeprefix("./")


def is_excluded(relative_path: str) -> bool:
    normalized = normalize_relative(relative_path)
    parts = normalized.split("/")
    if any(part in EXCLUDED_SEGMENTS for part in parts):
        return True
    if any(part == ".env" or part.startswith(".env.") for part in parts):
        return True
    return any(
        normalized == prefix or normalized.startswith(f"{prefix}/")
        for prefix in (
            ".ai-factory/qa",
            ".ai-factory/state",
            ".ai-factory/rules/generated",
        )
    )


def load_corpus(root_value: str) -> tuple[Path, list[Chunk]]:
    root = Path(root_value).resolve(strict=True)
    if not root.is_dir():
        raise BoundaryError("fixture_root_not_directory")
    chunks: list[Chunk] = []
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        kept_directories = []
        for name in sorted(directories):
            candidate = current_path / name
            relative = normalize_relative(str(candidate.relative_to(root)))
            if candidate.is_symlink():
                raise BoundaryError("corpus_symlink_forbidden")
            if not is_excluded(relative):
                kept_directories.append(name)
        directories[:] = kept_directories
        for name in sorted(files):
            candidate = current_path / name
            relative = normalize_relative(str(candidate.relative_to(root)))
            if candidate.is_symlink():
                raise BoundaryError("corpus_symlink_forbidden")
            if (
                is_excluded(relative)
                or candidate.suffix.lower() not in ALLOWED_EXTENSIONS
            ):
                continue
            canonical = candidate.resolve(strict=True)
            if not canonical.is_relative_to(root):
                raise BoundaryError("corpus_path_escape")
            raw = canonical.read_text(encoding="utf-8")
            chunks.extend(parse_chunks(relative, raw))
    if not chunks:
        raise BoundaryError("empty_corpus")
    if len({chunk.chunk_id for chunk in chunks}) != len(chunks):
        raise BoundaryError("duplicate_chunk_id")
    return root, chunks


def parse_chunks(relative_path: str, raw: str) -> list[Chunk]:
    lines = raw.replace("\r\n", "\n").split("\n")
    markers: list[tuple[str, int]] = []
    for index, line in enumerate(lines, start=1):
        match = MARKER.match(line)
        if match:
            markers.append((match.group(1) or match.group(2), index))
    if not markers:
        raise BoundaryError("missing_chunk_marker")
    output = []
    for index, (marker_id, marker_line) in enumerate(markers):
        start_line = marker_line + 1
        end_line = markers[index + 1][1] - 1 if index + 1 < len(markers) else len(lines)
        content = "\n".join(lines[start_line - 1 : end_line]).strip()
        if not content:
            raise BoundaryError("empty_chunk")
        output.append(
            Chunk(
                f"{relative_path}#{marker_id}",
                relative_path,
                start_line,
                end_line,
                content,
            )
        )
    return output


def corpus_snapshot_fingerprint(chunks: list[Chunk]) -> str:
    """Fingerprint the bounded in-memory corpus without exposing its contents."""
    digest = hashlib.sha256()
    for chunk in sorted(chunks, key=lambda item: item.chunk_id):
        for value in (
            chunk.chunk_id,
            chunk.relative_path,
            str(chunk.start_line),
            str(chunk.end_line),
            chunk.content,
        ):
            digest.update(value.encode("utf-8"))
            digest.update(b"\0")
    return digest.hexdigest()


def verify_harness(root_value: str, revision: str) -> bool:
    if revision != EXPECTED_HARNESS_REVISION:
        raise ProvenanceError("harness_revision_mismatch")
    root = Path(root_value).resolve(strict=True)
    for relative, expected in EXPECTED_HARNESS_FILES.items():
        candidate = (root / relative).resolve(strict=True)
        if not candidate.is_relative_to(root) or not candidate.is_file():
            raise ProvenanceError("harness_file_missing_or_escaped")
        actual = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual != expected:
            raise ProvenanceError("harness_file_digest_mismatch")
    manifest_paths = [
        root / "pyproject.toml",
        root / "poetry.lock",
        root / "uv.lock",
        *(
            candidate
            for candidate in (root / "src").rglob("*")
            if candidate.is_file() and candidate.suffix in {".py", ".yaml"}
        ),
    ]
    rows = []
    for candidate in sorted(
        manifest_paths, key=lambda item: item.relative_to(root).as_posix()
    ):
        canonical = candidate.resolve(strict=True)
        if not canonical.is_relative_to(root):
            raise ProvenanceError("harness_tree_file_escaped")
        relative = canonical.relative_to(root).as_posix()
        file_digest = hashlib.sha256(canonical.read_bytes()).hexdigest()
        rows.append(f"{relative}\0{file_digest}")
    if len(rows) != EXPECTED_HARNESS_TREE_FILE_COUNT:
        raise ProvenanceError("harness_tree_file_count_mismatch")
    tree_digest = hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()
    if tree_digest != EXPECTED_HARNESS_TREE_DIGEST:
        raise ProvenanceError("harness_tree_digest_mismatch")
    return True


def validate_loopback_endpoint(endpoint: str) -> str:
    parsed = urlparse(endpoint)
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise BoundaryError("endpoint_not_loopback_http")
    if not parsed.path.rstrip("/").endswith("/v1"):
        raise BoundaryError("endpoint_not_openai_v1")
    return endpoint.rstrip("/")


def preflight_endpoint(endpoint: str, expected_model: str) -> None:
    request = urllib.request.Request(f"{endpoint}/models", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise EndpointUnavailable("endpoint_non_200")
            body = json.loads(response.read(262_144).decode("utf-8"))
            if not isinstance(body, dict) or not isinstance(body.get("data"), list):
                raise EndpointUnavailable("endpoint_models_shape_invalid")
            model_ids = {
                str(item.get("id"))
                for item in body["data"]
                if isinstance(item, dict) and item.get("id")
            }
            if expected_model not in model_ids:
                raise ModelIdentityError("endpoint_model_identity_mismatch")
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise EndpointUnavailable("endpoint_unavailable") from exc


def bounded_subprocess_env() -> dict[str, str]:
    allowed = ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA")
    env = {key: os.environ[key] for key in allowed if os.environ.get(key)}
    env["PYTHONUTF8"] = "1"
    return env


def contains_private_material(value: Any, canaries: list[str]) -> bool:
    serialized = json.dumps(value, ensure_ascii=False, default=str)
    return any(canary in serialized for canary in canaries)


def emit_result(
    *,
    scenario_id: str,
    status: str,
    ranked_chunk_ids: list[str] | None = None,
    privacy_passed: bool | None = None,
    source_boundary_passed: bool | None = None,
    freshness_passed: bool | None = None,
    purge_passed: bool | None = None,
    persistent_state_created: bool | None = None,
    harness_provenance_passed: bool | None = None,
    model_identity_passed: bool | None = None,
    metrics: dict[str, Any] | None = None,
    error_code: str | None = None,
) -> None:
    body = {
        "schema": SCHEMA,
        "scenario_id": scenario_id,
        "status": status,
        "ranked_chunk_ids": ranked_chunk_ids or [],
        "privacy_passed": privacy_passed,
        "source_boundary_passed": source_boundary_passed,
        "freshness_passed": freshness_passed,
        "purge_passed": purge_passed,
        "persistent_state_created": persistent_state_created,
        "harness_provenance_passed": harness_provenance_passed,
        "model_identity_passed": model_identity_passed,
        "metrics": metrics or {},
        "error_code": error_code,
    }
    sys.stdout.write(json.dumps(body, ensure_ascii=False, separators=(",", ":")) + "\n")


def run(args: argparse.Namespace) -> int:
    started = time.perf_counter()
    provenance_passed = False
    model_identity_passed = None
    try:
        provenance_passed = verify_harness(args.harness_root, args.harness_revision)
        endpoint = validate_loopback_endpoint(args.endpoint)
        catalog = json.loads(
            Path(args.catalog).resolve(strict=True).read_text(encoding="utf-8")
        )
        scenarios = {
            item.get("id"): item
            for item in catalog.get("scenarios", [])
            if isinstance(item, dict)
        }
        scenario = scenarios.get(args.scenario_id)
        if not scenario or not isinstance(scenario.get("query"), str):
            raise BoundaryError("scenario_not_found")
        canaries = [
            str(value)
            for value in (catalog.get("defaults") or {}).get("privacy_canaries", [])
        ]
        root, chunks = load_corpus(args.fixture_root)
        initial_corpus_fingerprint = corpus_snapshot_fingerprint(chunks)
        chunk_ids = {chunk.chunk_id for chunk in chunks}
        preflight_endpoint(endpoint, args.model)
        model_identity_passed = True

        from retriever_agent import AgentConfig, OpenAILLMClient, RetrieverAgent

        config = AgentConfig(
            model=args.model,
            temperature=args.temperature,
            top_p=args.top_p,
            max_rounds=args.max_rounds,
            budget_tokens=args.budget_tokens,
            max_results=args.top_k,
            max_tokens_per_turn=args.max_tokens_per_turn,
            max_turns_per_round=args.max_turns_per_round,
            llm_timeout_s=float(args.timeout_seconds),
        )
        search = RgSearchClient(root, chunks)
        metered = MeteredLLMClient(OpenAILLMClient([endpoint], config))
        agent = RetrieverAgent(config, metered, search)
        result = agent.retrieve(scenario["query"])

        ranked_chunk_ids = [
            document.chunk_id for document in result.documents[: args.top_k]
        ]
        source_boundary_passed = all(
            chunk_id in chunk_ids for chunk_id in ranked_chunk_ids
        )
        private_view = {
            "documents": [document.to_dict() for document in result.documents],
            "messages": result.messages,
            "all_round_messages": result.all_round_messages,
            "persistent_saved_final": result.persistent_saved_final,
            "round_summaries": result.round_summaries,
        }
        privacy_passed = not contains_private_material(private_view, canaries)
        _, current_chunks = load_corpus(args.fixture_root)
        freshness_passed = (
            corpus_snapshot_fingerprint(current_chunks) == initial_corpus_fingerprint
        )
        persistent_state_created = search.persistent_state_created
        purge_passed = not persistent_state_created
        status = (
            "PASS"
            if (
                result.termination_reason == "finalized"
                and bool(ranked_chunk_ids)
                and privacy_passed
                and source_boundary_passed
                and freshness_passed
                and purge_passed
                and not persistent_state_created
                and model_identity_passed
            )
            else "FAIL"
        )
        error_code = None
        if not privacy_passed:
            error_code = "privacy_canary_exposed"
        elif not source_boundary_passed:
            error_code = "source_boundary_failed"
        elif not freshness_passed:
            error_code = "corpus_changed_during_run"
        elif not purge_passed or persistent_state_created:
            error_code = "persistent_search_state_created"
        elif result.termination_reason != "finalized":
            error_code = f"termination_{result.termination_reason}"
        elif not ranked_chunk_ids:
            error_code = "empty_ranking"
        emit_result(
            scenario_id=args.scenario_id,
            status=status,
            ranked_chunk_ids=ranked_chunk_ids,
            privacy_passed=privacy_passed,
            source_boundary_passed=source_boundary_passed,
            freshness_passed=freshness_passed,
            purge_passed=purge_passed,
            persistent_state_created=persistent_state_created,
            harness_provenance_passed=provenance_passed,
            model_identity_passed=model_identity_passed,
            metrics={
                "elapsed_ms": round((time.perf_counter() - started) * 1000),
                "search_calls": result.total_search_calls,
                "search_turns": result.total_search_turns,
                "rounds_completed": result.rounds_completed,
                "returned_count": len(ranked_chunk_ids),
                "prompt_tokens": metered.prompt_tokens,
                "completion_tokens": metered.completion_tokens,
                "total_tokens": metered.total_tokens,
                "finalize_calls": result.total_finalize_calls,
                "termination_reason": result.termination_reason,
            },
            error_code=error_code,
        )
        return 0 if status == "PASS" else 1
    except ModelIdentityError as exc:
        emit_result(
            scenario_id=args.scenario_id,
            status="FAIL",
            harness_provenance_passed=provenance_passed,
            model_identity_passed=False,
            metrics={"elapsed_ms": round((time.perf_counter() - started) * 1000)},
            error_code=str(exc),
        )
        return 1
    except EndpointUnavailable:
        emit_result(
            scenario_id=args.scenario_id,
            status="NOT_RUN",
            harness_provenance_passed=provenance_passed,
            model_identity_passed=model_identity_passed,
            metrics={"elapsed_ms": round((time.perf_counter() - started) * 1000)},
            error_code="endpoint_unavailable",
        )
        return 0
    except ProvenanceError as exc:
        emit_result(
            scenario_id=args.scenario_id,
            status="FAIL",
            harness_provenance_passed=False,
            model_identity_passed=model_identity_passed,
            metrics={"elapsed_ms": round((time.perf_counter() - started) * 1000)},
            error_code=str(exc),
        )
        return 1
    except BoundaryError as exc:
        emit_result(
            scenario_id=args.scenario_id,
            status="FAIL",
            source_boundary_passed=False,
            harness_provenance_passed=provenance_passed,
            model_identity_passed=model_identity_passed,
            metrics={"elapsed_ms": round((time.perf_counter() - started) * 1000)},
            error_code=str(exc),
        )
        return 1
    except Exception:  # noqa: BLE001 - public output must normalize every unexpected provider failure.
        emit_result(
            scenario_id=args.scenario_id,
            status="FAIL",
            harness_provenance_passed=provenance_passed,
            model_identity_passed=model_identity_passed,
            metrics={"elapsed_ms": round((time.perf_counter() - started) * 1000)},
            error_code="unexpected_candidate_failure",
        )
        return 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--scenario-id", required=True)
    parser.add_argument("--fixture-root", required=True)
    parser.add_argument("--harness-root", required=True)
    parser.add_argument("--harness-revision", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--top-k", type=int, required=True)
    parser.add_argument("--max-rounds", type=int, required=True)
    parser.add_argument("--budget-tokens", type=int, required=True)
    parser.add_argument("--max-tokens-per-turn", type=int, required=True)
    parser.add_argument("--max-turns-per-round", type=int, required=True)
    parser.add_argument("--timeout-seconds", type=int, required=True)
    parser.add_argument("--temperature", type=float, required=True)
    parser.add_argument("--top-p", type=float, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
