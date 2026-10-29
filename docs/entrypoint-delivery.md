# Entrypoints: references, update и замер

PR3 issue #233 сокращает только extension-owned implement injection, done skill, Claude/Codex implement workers и QUESTION-TOOL. TASK-COORDINATION и upstream skill bodies сохраняются. Установленные upstream skills содержат inline injections; их размеры нельзя складывать с injection source как независимый runtime context.

## Обязательные references

Все пути инструкций разрешаются от extension root: в consumer это `.ai-factory/extensions/aifhub-extension/`. Путь не отсчитывается от установленного upstream SKILL.md. Kernel выбирает mode и требует прочитать соответствующий reference до каждого регулируемого действия; отсутствующий обязательный reference останавливает действие.

Явный `aifhub.tools` mapping имеет precedence. Только `openspec: true` включает OpenSpec; false, пустой mapping и пропущенный switch выбирают classic. `artifactProtocol` используется только при отсутствии всего mapping. Ultra classifier остаётся первым перед companion discovery/state writes; valid ultra возвращает точную upstream-команду.

## Отдельный prompt preservation guard

Перед global/extension update `commands/post-update-init.mjs` инвентаризирует extension `skills/`, `injections/`, `agent-files/` со всеми references и опубликованные skills/agents в поддерживаемых runtime directories. Это отдельный контракт от пяти helper modules и `provenance.json`.

Baseline хранится в `.ai-factory/state/prompt-assets-baseline.json`. Изменённые и неизвестные prompt assets сохраняются до replacement в `.ai-factory/state/extension-prompt-updates/<id>/preserve/` с исходными путями. `prompt-diff-manifest.json` содержит полный inventory и исходный/incoming sha256 каждого сохранённого файла. У старой установки без baseline первый update консервативно сохраняет все найденные prompt assets. Ошибка чтения или сохранения останавливает update до replacement.

Штатный updater сначала обновляет upstream base, затем re-applies extension injections. Guard проверяет единственную start/end pair и актуальный source внутри неё, разрешимость обязательных references от installed extension и routes в опубликованных prompt copies. После успешной инициализации записывается новая baseline. Пользовательские edits остаются для явной миграции, автоматически поверх incoming файлов не накладываются. `AIFHUB_UPDATE_STRICT=1` сохраняет существующий nonzero handoff при наличии сохранённых изменений.

## Измеритель

```bash
node scripts/measure-entrypoints.mjs --surface source-surfaces --runtime claude
node scripts/measure-entrypoints.mjs --surface source-surfaces --runtime codex
node scripts/measure-entrypoints.mjs --root <consumer-root> --surface installed-flow --runtime codex
node scripts/measure-entrypoints.mjs --surface source-surfaces --runtime claude --reference injections/references/aif-implement/classic-sdd.md
```

Read-only JSON идёт в stdout; ошибка, включая missing file, идёт в stderr с ненулевым exit. `--reference` допускает повторение и считает каждый выбранный reference один раз. Manifests имеют фиксированные позиции; installed layout берётся из runtime ledger при наличии, иначе из стандартных `.codex/` или `.claude/` directories.

Source manifest содержит девять позиций брифа; `aif-done` берётся из актуального source skill, worker выбирается по runtime. Installed manifest содержит восемь физических entrypoints: отдельный injection source исключён, поскольку уже inline-merged. LANGUAGE-POLICY и TOOLS вынесены в supporting totals. References имеют отдельные totals.

Метод `aifhub.entrypoints.v1`: bytes — фактический Buffer length, строки — CRLF/LF/CR без дополнительной пустой строки после финального newline, sha256 — от исходных bytes. JSON содержит commit, extension/Node versions, установленную upstream version при известном ledger и отдельно reviewed upstream version. Timestamp отсутствует. Dirty candidate определяется per-file hashes, commit обозначает базу checkout.

`tokens: null`, `api_read_bytes: null`, `agent_consumption: not_observed_offline`: physical bytes не измеряют tokenizer, повторные API reads или фактическое потребление агентом. Внешний исторический audit не считается воспроизведённым baseline.

Baseline/after implementation receipts и отчёт сохраняются в gitignored `.ai-factory/state/session-brief-entrypoints/`. Offline consumer smoke проверяет fresh install, base refresh → reapply, one-copy, repeated reapply, outside-marker bytes, missing references и независимое сохранение prompt edits. Live downloads и production validation этими проверками не заявляются.
