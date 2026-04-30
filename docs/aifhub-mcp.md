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

## Tools

The MCP client normally shows these with the server namespace:

| Tool | Purpose |
|---|---|
| `aifhub.search_skills` | Search the skills catalog through the installed skills CLI. |
| `aifhub.install_skill` | Prepare a skills install command, or run it only when `confirm: true` is provided. |
| `aifhub.run_skill_tests` | Run tests for a local skill package or caller-provided test command. |
| `aifhub.propose_skill_improvement` | Return a structured improvement proposal without editing files. |

## Runtime Formats

The manifest stores one canonical stdio command template. AI Factory renders that template into the format required by each selected runtime.

### Standard MCP Clients

Claude Code, Cursor, Roo Code, Kilo Code, Qwen Code, and other standard MCP settings use `mcpServers`:

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

## See Also

- [Usage](usage.md)
- [OpenSpec Compatibility](openspec-compatibility.md)
- [Codex Agents](codex-agents.md)
- [Claude Agents](claude-agents.md)
