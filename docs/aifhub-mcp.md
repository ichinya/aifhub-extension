[Back to Documentation](README.md) | [Back to README](../README.md)

# AIFHub MCP

AIFHub Extension publishes one optional MCP server through `extension.json -> mcpServers`:

```json
{
  "key": "aifhub",
  "template": {
    "command": "ai-factory",
    "args": ["aifhub-mcp"]
  }
}
```

The server runs over stdio through the extension command `ai-factory aifhub-mcp`.

Start it from the project root, or set `AIFHUB_PROJECT_ROOT` to an absolute project path in the MCP server environment. The command resolves the environment override or startup `cwd` once, then threads that fixed root through every tool call.

## Tools

The MCP client normally shows these with the server namespace:

| Tool | Purpose |
|---|---|
| `aifhub.search_skills` | Search the skills catalog through the installed skills CLI. |
| `aifhub.install_skill` | Prepare a skills install command, or run it only when `confirm: true` is provided. |
| `aifhub.run_skill_tests` | Run tests for a local skill package or caller-provided test command. |
| `aifhub.propose_skill_improvement` | Return a structured improvement proposal without editing files. |
| `aifhub.read_file_deduplicated` | Read a project file once per session; identical repeat reads return a replay summary instead of the content. |
| `aifhub.context_dedup_status` | Report session totals: reads, dedup hits, observed/served bytes, net saved bytes, estimated saved tokens. |
| `aifhub.context_dedup_purge` | Preview deletion of this MCP connection ledger; delete it only with `confirm: true`. |

## Runtime Formats

The manifest stores one canonical stdio command template. AI Factory `2.16+` renders that template into the format required by each selected runtime. The Universal / Other target writes standard `mcpServers` configuration to `.mcp.json`; this version-gated rendering behavior is not promised for AI Factory `2.11`-`2.15`.

### Universal / Other (`.mcp.json`)

In AI Factory `2.16+`, Universal / Other and standard MCP clients such as Claude Code, Cursor, Roo Code, Kilo Code, and Qwen Code use `.mcp.json` with `mcpServers`:

```json
{
  "mcpServers": {
    "aifhub": {
      "command": "ai-factory",
      "args": ["aifhub-mcp"]
    }
  }
}
```

### OpenCode

OpenCode uses the `mcp` container, `type: "local"`, and a command array:

```json
{
  "mcp": {
    "aifhub": {
      "type": "local",
      "command": ["ai-factory", "aifhub-mcp"]
    }
  }
}
```

### GitHub Copilot

GitHub Copilot uses the VS Code MCP shape with `servers` and `type: "stdio"`:

```json
{
  "servers": {
    "aifhub": {
      "type": "stdio",
      "command": "ai-factory",
      "args": ["aifhub-mcp"]
    }
  }
}
```

## Safety Notes

`aifhub.install_skill` is dry-run by default. It returns the command it would run and requires `confirm: true` before executing the skills CLI.

`aifhub.propose_skill_improvement` returns proposal text only. It does not edit skill files, generated rules, runtime state, QA evidence, or canonical OpenSpec artifacts.

`aifhub.read_file_deduplicated` never rewrites files and never optimizes protected validation artifacts such as `openspec/specs/**`, `openspec/changes/**`, `coverage.json`, `done-readiness.json`, `aif-gate-result*`, and generated-rules traces. `aifhub.contextDedup.mode` selects `off`, built-in `aifhub`, or an installed user-owned `sqz`; legacy `enabled: true|false` remains read-compatible as `aifhub|off`. Reads are capped at 1 MiB, diagnostics are returned separately from file content, and each MCP server process owns a fresh session ledger.

MCP callers cannot select another `sessionId` or purge all ledgers. `aifhub.context_dedup_status` omits internal session/path values and reports net accounting with the invariant `observedBytes = servedBytes + savedBytes`. `aifhub.context_dedup_purge` is dry-run by default and deletes only the current MCP connection ledger after `confirm: true`. CLI retains explicit `--session` and `--all` operations for user-owned local lifecycle. See [Session Context Dedup](context-dedup.md).

`mode: sqz` requires a separately installed third-party executable and always emits a bounded readiness/ownership warning. AIFHub does not auto-download it or run `sqz init`; runtime execution uses fixed `compress --no-cache` args, `shell: false`, bounded timeout/output and an allowlisted child environment containing only executable lookup/platform temp/locale keys plus session-owned home directories. Unknown credentials, cloud, proxy and runtime variables are not inherited. Exact repeats use the connection-scoped AIFHub ledger. Missing/failing `sqz` or unexpected state-dependent provider output serves the original content and does not expose raw stderr. The third-party CLI may still write user-owned statistics under `~/.sqz`; MCP purge does not own that state.

## See Also

- [Usage](usage.md)
- [Session Context Dedup](context-dedup.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
