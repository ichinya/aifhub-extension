# squeez

Репозиторий: [claudioemmanuel/squeez](https://github.com/claudioemmanuel/squeez)

Проверенная версия: `squeez 1.43.0` (Apache-2.0, Rust, Linux x86_64 release binary).

Результаты замеров: [squeez-benchmark-results.md](squeez-benchmark-results.md).

Этот документ — variant B в трёхстороннем сравнении для issue #133: baseline без dedup, вариант A ([Session Context Dedup](../context-dedup.md)) и вариант B (`squeez`).

## Что Это

`squeez` — hook-based token compressor для AI CLI. Он ставит hooks в host runtime и на `PostToolUse` переписывает output инструментов Read/Grep/Glob/Bash, если содержимое избыточно или слишком велико. Кроме дедупликации есть filter-DSL для bash, log-template compression, relevance truncation, summarize, reversible retrieve и MCP-сервер с 17 инструментами.

Для issue #133 значима только часть возможностей: cross-call dedup повторных чтений в рамках сессии.

## Установка И Границы

Проверенный путь установки без прав на глобальный `npm prefix`:

```bash
curl -fsSL -o ./bin/squeez \
  https://github.com/claudioemmanuel/squeez/releases/download/v1.43.0/squeez-linux-x86_64
chmod +x ./bin/squeez
./bin/squeez --version
```

`npm i -g squeez` — тонкий wrapper: `bin.js` при первом запуске скачивает release-бинарь. В окружении без `curl` fallback-загрузчик на Node в проверке не сработал, поэтому прямая загрузка release-asset надёжнее.

`squeez setup` регистрирует hooks в user-level конфиге host CLI (`~/.claude/settings.json`, `~/.copilot/settings.json`, `~/.config/opencode/plugins/squeez.js`, `AGENTS.md` для Codex/Gemini) и пишет state в `~/.claude/squeez/`. `squeez uninstall` снимает hooks, сохраняя session data и `config.ini`. В проверке `setup` не запускался: все прогоны шли через прямой вызов `squeez compress-output` с изолированным `HOME`, чтобы не менять user-owned agent config.

## Проверенное Поведение Dedup

Контракт hook: на stdin JSON PostToolUse payload, на stdout либо пусто (output проходит как есть), либо

```json
{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"[squeez: identical to unknown #1 — output omitted]"}}
```

Проверено на изолированном `HOME`:

- первое чтение файла проходит без изменений;
- повторное чтение того же содержимого заменяется маркером `[squeez: identical to ... — output omitted]`;
- изменённое содержимое отдаётся полностью;
- дедуплицируются и protected validation artifacts (`openspec/specs/**`, `.ai-factory/qa/**/coverage.json`) — у инструмента нет понятия protected artifact.

Последний пункт — ключевое расхождение с [Context Loading Policy](../context-loading-policy.md).

## Privacy И Telemetry

- Сетевых вызовов в рантайме не наблюдалось; сеть нужна только при установке и `squeez update`.
- Telemetry/analytics в README и в поведении не заявлены и не наблюдались.
- Session state пишется в `~/.claude/squeez/sessions/context.json`: счётчики вызовов, хеши, shingles, длины. Cross-session memory (`memory/summaries.jsonl`) хранит список файлов, ошибок и git-активности прошлых сессий — это шире, чем session-scoped ledger варианта A, и требует явного согласия пользователя.
- Scope hooks — user-level, а не project-level: после `squeez setup` дедупликация применяется ко всем проектам этого пользователя.

## Ограничения Для AIFHub

- Нет protected-artifact списка: dedup применяется к canonical OpenSpec specs и QA evidence.
- Нет project-scoped конфигурации: включение через `setup` затрагивает user-level agent config.
- Read/Grep rewrite полноценно поддержан только в Claude Code v2.1.119+; для Codex CLI и Gemini CLI budget-поверхности мягкие (`AGENTS.md`), OpenCode пропускает hooks на MCP tool calls, Hermes budget surface отсутствует.
- Установка — скачивание prebuilt binary, что нарушает dependency-free и no-auto-install политику extension, если делать это автоматически.

## Политика Использования

`squeez` — user-owned optional tool. AIFHub не должен его устанавливать, регистрировать hooks или включать автоматически.

Если пользователь уже использует `squeez`, рекомендуется:

- либо исключить protected validation artifacts из dedup на стороне host-конфигурации, если такая опция появится;
- либо перечитывать protected artifacts с `--force`-эквивалентом перед verify/done, чтобы gate evidence оценивалось по полному содержимому.

Recommendation-metadata не меняется этим документом: paired `ai-tester` evidence по `squeez` пока `NOT_RUN`.
