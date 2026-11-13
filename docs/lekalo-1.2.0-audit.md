# Аудит адаптера Lekalo v1.2.0 (#301)

## Контракт и custody

Нормативный scope: контракт реализации `D:/Projects/aifhub/implement-301-prompt.md` и план `D:/Projects/aifhub/plan-301.md` (решения владельца 1B/2A/3A от 2026-11-12). Источник — [tag v1.2.0](https://github.com/ichinya/lekalo/tree/v1.2.0). Annotated tag object `9e54453047d4dc4b3b8b5104fc7ba120bd6b5358` разрешён в commit `83d7c0e30eb7cb43b7ab95aaae1a33fcc4c27c05` (проверено `gh api repos/ichinya/lekalo/git/tags/9e544530…` — `object.type: commit`); предыдущий v1.1.0 (`87b6bc2f…`) совпадает с ledger-блоком 1.1.0.

Workflow contract не изменился: exact `dev.lekalo.workflow-provider@0.8.0`, discriminator `lekalo/workflow-provider/v0.8.0`, manifest productVersion 0.8.0. Пин reviewed manifest digest `sha256:a674f1dd6f5608a28b8f1727bcddae4ad67adceace33e871ebb4334f091315d0` — без изменений. Точная семантика digest: **пин = canonical sorted-key JSON манифеста без его собственного поля `manifestDigest`**; `sha256:eedef0e2f856f8ef71f163867c85d2f1b26d4101807aebec16531a53969a7100` — тот же манифест **с** этим self-digest-полем. Оба значения вычислены локально из живого `provider describe --json` и совпали с пином адаптера и корректировкой research.

### Custody-таблица release-ассетов (release 1.2.0, 11 файлов: 10 ассетов + SHA256SUMS.txt)

Скачивание в отдельный каталог вне репозитория; сверка `sha256sum -c` против `SHA256SUMS.txt`.

| Ассет | Статус | Примечание |
| --- | --- | --- |
| `SHA256SUMS.txt` | VERIFIED | получен из release; сам по себе не покрыт контрольной суммой — манифест; **не подписан attestation** (граница, см. ниже) |
| `lekalo-v1.2.0-x86_64-pc-windows-msvc.zip` | VERIFIED | hash ∈ SUMS; распакован; exe совпал с `binarySha256` |
| `lekalo-v1.2.0-x86_64-pc-windows-msvc.build.json` | VERIFIED | hash ∈ SUMS; `sourceCommit` == commit тега; `binarySha256` == распакованный exe |
| `lekalo-v1.2.0-aarch64-apple-darwin.build.json` | VERIFIED | hash ∈ SUMS |
| `lekalo-v1.2.0-aarch64-unknown-linux-gnu.build.json` | VERIFIED | hash ∈ SUMS |
| `lekalo-v1.2.0-x86_64-apple-darwin.build.json` | VERIFIED | hash ∈ SUMS |
| `lekalo-v1.2.0-x86_64-unknown-linux-gnu.build.json` | VERIFIED | hash ∈ SUMS |
| `lekalo-v1.2.0-aarch64-apple-darwin.tar.gz` | VERIFIED | hash ∈ SUMS (только checksum; исполнение — NOTRUN, нецелевая платформа) |
| `lekalo-v1.2.0-aarch64-unknown-linux-gnu.tar.gz` | VERIFIED | hash ∈ SUMS (только checksum; исполнение — NOTRUN, нецелевая платформа) |
| `lekalo-v1.2.0-x86_64-apple-darwin.tar.gz` | VERIFIED | hash ∈ SUMS (только checksum; исполнение — NOTRUN, нецелевая платформа) |
| `lekalo-v1.2.0-x86_64-unknown-linux-gnu.tar.gz` | VERIFIED | hash ∈ SUMS (только checksum; исполнение — NOTRUN, нецелевая платформа) |

Метаданные сборки windows-msvc: `sourceCommit 83d7c0e30eb7cb43b7ab95aaae1a33fcc4c27c05`, `workflowCommit a5888fda04ab8e8093584933cebcf1336528104d`, `binarySha256 5d3520f1c4dc3ace38abfc6559bf996c6161a306531a1312dbe5e9a7690b8084`, `rustc 1.99.1`, `cargoLockSha256 8bbaa729…`, build run — GitHub Actions (URL в `.build.json`).

Честная граница: `SHA256SUMS.txt` не имеет attestation-подписи — цепочка доказывает согласованность артефактов и source-commit, но не подписанное происхождение релиза. Проверка SHA-256 цепочки выполнена на x86_64-pc-windows-msvc (исполненный бинарник); остальные 4 tar.gz — checksum-only, их исполнение NOTRUN.

## Live-execution матрица (checksum-верифицированный бинарник 1.2.0, windows-msvc)

Прогоны из каталога распаковки и из sandbox-проекта (пустой adopted-проект с одним definition). Verdict'ы панелей отражают пустой sandbox, а не реальный потребитель; значимы формы envelope, состав панелей и коды возврата.

| Команда | Статус | Фактический результат |
| --- | --- | --- |
| `lekalo --version` | VERIFIED | ровно `lekalo 1.2.0` |
| `provider describe --json` | VERIFIED | `status: valid`; digest манифеста без self-digest == пин `a674f1dd…`; с self-digest == `eedef0e2…`; canonical JSON манифеста deep-equal локальному golden `lekalo-describe-v0.8.0.json` |
| `doctor --json` (без проекта) | VERIFIED | панель 13 чеков (условные `adapters.trust`, `classification.attachment` отсутствуют до adopt) |
| `doctor --json` (после adopt) | VERIFIED | **панель 15 чеков**, verbatim порядок (алфавитный): `adapters.inventory, adapters.trust, artifacts.drift, bindings.freshness, cache.health, capabilities.profiles, classification.attachment, fs.confinement, integrations.hlv, lock.freshness, model.references, model.version, platform.limits, project.root, tools.gates`; `productVersion 1.2.0`; verdict `blocked`; зафиксировано до внесения чека в адаптер; панель сохранена как [parity-фикстура](../test/fixtures/validation-providers/lekalo-doctor-live-v1.2.0.json) |
| `status --json` | VERIFIED | панель 4 чеков, verdict `degraded`, exit 0 |
| `readiness --phase done --json` | VERIFIED | `report: readiness`, `phase: release`, verdict `blocked`, exit 0 |
| `validate --no-cache --json` | VERIFIED | `modelVersion 0.2.16`, `profile default`, `profileVersion 0.6.4`, `registryVersion 0.6.4` |
| `init --adopt --project .` (relative) | VERIFIED | exit 0, создан `lekalo/project.yaml`; содержимое project.yaml (schema_version 0.2.16|8.0, kind: project) live-матрицей не сверялось — при невалидной форме `inspectLekaloLayout` бросает `invalid_existing_layout` (tool-initialization.mjs:88), при отсутствии файла — layout-missing ветка |
| `init --adopt --project <abs>` (absolute) | VERIFIED | exit 1, `LEK-STR-024 structure.selection-absolute` (security, «Project path policy refusal») — подтверждение: до фикса абсолютная форма давала всегда `process_failed` |
| `status --project <abs>` / `status --project .` | VERIFIED | обе формы exit 0, `valid` — LEK-STR-024 ограничен init, read-операции принимают абсолютный и относительный путь |
| `doctor --project <abs>` / `doctor --project .` | VERIFIED | обе формы exit 0, панель 15 чеков |
| `trace export probe-trace.json --json` | VERIFIED | минимальный valid-манифест с `_`-leading `logicalPath` (`_fixtures/custody/probe.json`) принят; `manifestDigest sha256:57b1aa53…` == `sha256(JSON.stringify(trace))` — математика digest совпадает с нормализацией адаптера |
| `trace export <missing>.json` | VERIFIED | exit 1, `LEK-LOAD-011 loader.io` (`file-missing`) — явный отказ на отсутствующем манифесте |

Отсутствующих пунктов матрицы нет; NOTRUN остаются только исполнения не-windows архивов (выше) и исторические live-прогоны 1.1.0 (зафиксированы NOTRUN в [1.1.0 audit](lekalo-1.1.0-audit.md), не перепроходились — история не переписывается).

### Схема trace-manifest v0.2.16

`contracts/trace-manifest.schema.v0.2.16.json` получен с тега v1.2.0. `$defs/logicalPath` pattern `^[a-z0-9_][a-z0-9._-]*(/[a-z0-9_][a-z0-9._-]*)*$` — `_` допустим первым символом (дельта 1.1.0→1.2.0). Examples в схеме **нет**; значение `_fixtures/custody/probe.json` для теста сконструировано по этому паттерну (источник указан в тесте) и дополнительно подтверждено живым `trace export` (матрица выше).

### Goldens

Фикстуры переименованы НЕ были (решение владельца 1B): `lekalo-doctor-v1.1.0.json`, `lekalo-impact-v1.1.0.json`, `lekalo-context-v1.1.0.json` и их потребители без изменений. Верификация content-equality против тега v1.2.0: impact (`tests/fixtures/impact/golden/planner.impact.json`) и context (`tests/fixtures/context/golden/planner.context.envelope.json`) — blob SHA-1 `git hash-object` совпали (`7c4f8ee3…`, `341b413a…`); doctor (`tests/fixtures/doctor/doctor.degraded.golden.json`) — canonical JSON deep-equal (blob отличается из-за локальной сериализации minified/без BOM). Формулировка: «fixture captured at 1.1.0, verified content-equal against 1.2.0».

## Источники уточнений

**Divergence 1 — doctor-панель 14/15.** Published enum `lekalo/doctor/v0.3.2` и upstream doctor golden перечисляют 14 чеков (golden: `productVersion 0.2.7`, без `classification.attachment`), тогда как живой бинарник (обе версии ≥1.1.0 по research; live 1.2.0 здесь) отдаёт 15 чеков с `classification.attachment` (в пустом до-adopt проекте — условно отсутствует). Disposition: `CHECKS` адаптера расширен до точной живой панели 15 id в verbatim порядке; отрицательный кейс неизвестного id остаётся fail-closed для id вне панели. Это upstream schema-gap — кандидат в upstream issue (только фиксация здесь, upstream не правился).

**Divergence 2 — init `--project`.** Живой бинарник отвергает абсолютный `--project` для `init --adopt` (`LEK-STR-024`); адаптер передавал абсолютный корень → `process_failed` на живом CLI. Disposition: argv переведён на относительную форму `--project .` при `cwd: rootDir`; тест ассертит и argv, и cwd (относительный селектор валиден только при корректном cwd). Read-операции сохраняют абсолютный корень: live-матрица фиксирует обе формы для `status`/`doctor`; для `validate`/`readiness` сохранение argv подтверждено кодом адаптера (lekalo-provider.mjs:277-278), для `impact`/`context` — runSemantic (:219/:226); live-прогон этих форм NOTRUN.

**Обновление поверхностей реестра.** Помимо исходного реестра контракта, по ревью снята та же «reserved/future»-устаревка на `docs/validation-providers.md` (вводный абзац, таблица слоёв, абзац после конфигурации, provider-config абзац) и на `skills/aif-analyze/references/config-keys.json` / `config-template.yaml` — docs-consistency расширение решения `README.md:32` (адаптер существует с #255). Прецедент формулировок — сам контракт (README-пункт).

**Осознанная граница hlv-ветки схемы evidence.** После расширения базового `version` до enum `1.1.0|1.2.0` комбинация `{id: aifhub.hlv-cli, version: 1.2.0, source: hlv/v1.1.0}` формально остаётся валидной (hlv-ветка allOf пиннит только `source`). Runtime этот путь не производит: `scripts/aifhub-providers.mjs` строит commandContract из констант контрактов (`1.1.0` для hlv). Пиннинг версии в hlv-ветке — отдельное решение владельца, вне этого change.

**Инвалидация сохранённого lekalo-evidence.** Смена source/version-конст lekalo-ветки схемы и пинов адаптера инвалидирует сохранённое lekalo-evidence предыдущего контракта — по прецеденту HLV (`docs/validation-providers.md`: «Updating the contract's version/source invalidates saved HLV evidence … rerun validation»). Runtime-эффект мягкий: evidence всегда строится заново при запуске, но schema — публичный контракт; перед done/archive readiness валидацию нужно перепрогнать.

**Mirror-lag (наблюдения, не чинились).** Зеркальная копия `.ai-factory/extensions/aifhub-extension/aifhub-extension.json` отстаёт по чужим трекам: ai-factory 2.20.0 против корневых 2.23.0 и openspec 1.15.0 против корневых 1.17.0 (кумулятивная дельта 2.22→2.23 уже слита в main через PR #302, задача #290). Зеркальный `openspec/changes/` содержит три несвежих «активных» change'а, отсутствующих в корне (`extend-openspec-mode-fixtures-ci`, `migrate-legacy-plan-artifacts`, `rewrite-v1-openspec-native-docs`). Новый change `301-adapt-lekalo-1-2-0` в зеркало не зеркалируется — зеркальные change'и вне parity-скоупа. Всё это — отставание чужих задач, зафиксировано наблюдением.

**OpenSpec-native замечание.** `extension.json.$schema` и поверхности AI Factory/OpenSpec-адаптации не тронуты (чужие задачи #290/#300); version bump запрещён контрактом и не выполнялся (extension 1.8.1, `package.json`, теги/релизы — без изменений).

## Граница evidence

Адаптер остаётся read-only: detect/status/doctor/validate/readiness/trace/impact/context; init --adopt — отдельный явно включённый entrypoint (argv см. divergence 2). Validate всегда `--no-cache`. Контракт 0.8.0 и digest-пин не изменились — negotiation поверхность 1.2.0 byte-совместима с 1.1.0 (подтверждено live: canonical manifest == golden 1.1.0-фиксации).

Публичные evidence содержат только bounded metadata, LEK-коды и sha256 references; raw сообщения/пути/capsule не сохраняются (тесты продолжают ассертить отсутствие приватного текста). Trace custody и запрет trace collect/generate/drift/sync/install prompt/native gates — без изменений, fail-closed.

Зеркальная копия `.ai-factory/extensions/aifhub-extension/` обновлена по списку изменённых lekalo-поверхностей; root↔installed parity проверена явным сравнением (SHA-256), не подменой `npm run validate` (artifact-boundaries зеркало не покрывает). Сама зеркальная копия не покрыта никаким автотестом — ручная процедура (граница).

## Проверки и ограничения

- `npm test` — полный hermetic suite: **2767 tests, 2760 pass, 0 fail, 7 skipped** (прогон после коммита адаптера).
- `npm run validate`, `npm run provenance:check` — выполнены в этом change (фактические результаты в OpenSpec-задачах change'а и отчёте задачи).
- Живая матрица — все пункты VERIFIED (таблица выше), единственная исполнявшаяся платформа — x86_64-pc-windows-msvc; исполнение остальных таргетов NOTRUN (checksum VERIFIED).
- Панели сняты на пустом adopted-проекте; verdict'ы (`blocked`/`degraded`) — свойства песочницы, а не реального проекта. Форма envelope и семантика verdict'ов от состава панели не зависят; сам состав панелей условен (13 до adopt / 15 после adopt — см. live-матрицу).
- Parity-фикстура 15 чеков — новая фиксация с подлинным v1.2.0-происхождением (live-вывод doctor), нормализация ассертит фактический verdict фикстуры (`fail`), а не фиксированный pass.
- Исторический [1.1.0 audit](lekalo-1.1.0-audit.md) и ledger-блок 1.1.0 сохранены без изменений.
