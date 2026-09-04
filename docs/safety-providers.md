[Предыдущая страница](skill-providers.md) | [К документации](README.md) | [Следующая страница](memory-tool-recommendations.md)

# Safety Providers

Safety providers защищают окружение выполнения до того, как workflow перейдет к review или verification. Они являются optional user-owned infrastructure и не входят в runtime, dependencies или gates AIFHub Extension.

## Решение По dcg

[`Dicklesworthstone/destructive_command_guard`](https://github.com/Dicklesworthstone/destructive_command_guard) (`dcg`) принят только как optional safety provider с documentation-only integration. AIFHub не устанавливает, не настраивает и не регистрирует `dcg`; пользователь независимо владеет binary, hooks, configuration, updates и uninstall lifecycle.

`dcg` анализирует shell и git command text до исполнения и может блокировать destructive operations с объяснением и более безопасной альтернативой. Upstream предоставляет security packs для filesystem, git, databases, containers, Kubernetes, cloud и других infrastructure surfaces, а также integrations для Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, VS Code Copilot Chat, Cursor, Hermes Agent, Grok и других runtimes.

Это дополняет, но не заменяет AIFHub security review:

| Layer | Роль | Когда |
|---|---|---|
| user-installed `dcg` | command-level, syntax/pattern-based blocking | pre-execution, вне AIFHub workflow |
| `/aif-security-checklist` | semantic review findings по changed scope | optional review stage внутри AIFHub workflow |

`dcg` не доказывает безопасность diff, а `/aif-security-checklist` не является infrastructure hook. Наличие или результат одного layer не удовлетворяет и не отменяет другой.

## User-Owned Install

Следующие команды приведены только как upstream manual setup для явного запуска пользователем. Перед запуском пользователь должен самостоятельно review remote installer и принять изменения PATH, binary и agent hook configuration. AIFHub commands, sidecars, agents, installers и migration scripts не должны выполнять эти команды.

Linux, macOS и Windows через WSL:

```bash
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/main/install.sh?$(date +%s)" | bash -s -- --easy-mode
```

Native Windows PowerShell:

```powershell
& ([scriptblock]::Create((irm "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/main/install.ps1"))) -EasyMode -Verify
```

Upstream installers могут auto-detect supported agents, добавить binary в user `PATH` и создать или merge hook configuration. Эти effects остаются полностью user-owned даже когда installer называет их easy mode или automatic configuration.

## Разрешенные Runtime Probes

Если пользователь уже установил `dcg`, AIFHub automation может использовать только следующие read-only probes:

```text
dcg --version
dcg --help
dcg explain "<cmd>"
```

`dcg explain` классифицирует переданный command text и не должен исполнять `<cmd>`. Любая candidate command должна передаваться как data, без повторной shell evaluation. Все остальные `dcg` commands остаются manual и user-owned; AIFHub не запускает install, update, uninstall, init, test, scan, hook, allowlist или bypass lifecycle.

Probe разрешен только как optional supporting diagnostic. Ошибка запуска, unknown version, unsupported runtime, malformed output или отсутствие binary должны давать unavailable/degraded result и не должны менять outcome AIFHub command.

## Граница Владения AIFHub

AIFHub Extension не должен:

- устанавливать или обновлять `dcg` binary/package любым package manager, download script или bundled artifact;
- запускать `dcg install`, upstream install/update/uninstall scripts или любой agent hook setup command;
- автоматически регистрировать, repair, reorder, enable, disable или удалять hooks для Claude, Codex, Gemini, Copilot, VS Code, Cursor, Hermes, Grok или других runtimes;
- добавлять `dcg` в `package.json`, lockfiles, `extension.json`, `aifhub-extension.json` или другие package/manifest dependencies;
- менять `.mcp.json`, `.cursor/mcp.json`, `.opencode.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.gemini/config/hooks.json`, `~/.grok/hooks/`, `.copilot/hooks`, Cursor/Hermes/OpenCode settings, agent rules, agent skills, runtime hook settings, user `PATH` или dcg config;
- включать `dcg` в AIFHub config/recommendation metadata как required provider;
- считать availability, hook registration, explain result или denial результатом validation, verification, review, rules, security, done, archive или commit gate;
- ослаблять AIFHub behavior, автоматически обходить denial или предлагать bypass, когда `dcg` блокирует command.

Эта boundary распространяется на normal commands, sidecars, generated agents, MCP tools и extension installation. Будущая integration требует отдельного решения и не может выводиться из наличия `dcg` в `PATH`.

## Degraded Behavior

Отсутствие `dcg` является нормальным supported state. AIFHub workflows продолжаются с собственными approvals, artifact boundaries и optional review gates, когда:

- binary отсутствует или несовместим с local platform;
- supported agent hook не установлен, отключен или не покрывает конкретный execution path;
- probe возвращает error, timeout или неизвестный output;
- upstream pack/config не покрывает конкретную destructive operation.

Degraded status можно сообщить как concise warning, но он никогда не становится blocking finding. AIFHub не должен auto-install или auto-repair `dcg` как fallback.

## Output И Artifact Safety

Raw dcg denial output может содержать command text, absolute paths, infrastructure identifiers, environment details или другие sensitive diagnostics. Не сохраняйте raw denial output, hook transcripts, installer logs, probe dumps или generated hook configuration в AIFHub-owned durable artifacts, включая:

- `openspec/changes/<change-id>/`
- `openspec/specs/`
- `.ai-factory/rules/generated/`
- `.ai-factory/qa/<change-id>/`
- validation, verification, review, security, done или commit evidence

Если пользователь явно просит сохранить вывод вне этих protected paths, сначала удалите secrets, credentials, private paths и unrelated command content. Краткая human-reviewed note о внешнем блокировании остается supporting context и не становится canonical evidence или gate result.

## См. Также

- [Context Providers](context-providers.md)
- [Context Loading Policy](context-loading-policy.md)
- [Usage: `/aif-security-checklist`](usage.md#aif-security-checklist)
- [dcg upstream repository](https://github.com/Dicklesworthstone/destructive_command_guard)
