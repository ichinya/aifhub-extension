# Адаптация HLV 1.1.0: audit (#255)

Проверка от 2026-10-30 по контракту `D:/Projects/aifhub/brief-255c.md` (SHA256 `2c256f69e48bbaf0a283eb196633a367939370c21462082dd8e3d30f6a4e9e3c`) и зафиксированным решениям пользователя. Сравнение 1.0.0 → 1.1.0, включая 1.0.1: additive изменения используемых CLI envelopes; новые execution-evidence функции остаются у upstream.

## Source and executable custody

Через GitHub MCP `get_tag` и `get_release_by_tag` прочитаны [annotated tag v1.1.0](https://github.com/lee-to/hlv/releases/tag/v1.1.0) и release API. Tag object SHA-1: `941f0c671a28a7e23eafae45267e27123bbcdb81`; target commit: [`f23d9622bc46124e6ea8462eceea01ee04edc4fd`](https://github.com/lee-to/hlv/commit/f23d9622bc46124e6ea8462eceea01ee04edc4fd). Tagger date: 2026-10-07T20:57:48Z; release published: 2026-10-07T21:04:34Z. Tag unsigned; release API `immutable: false`, поэтому tag name не заменяет сохранённые object/commit pins.

Git object identity здесь SHA-1, а не SHA-256. Отдельный SHA-256 точных сохранённых JSON bytes custody receipt: `tag.json` — `3349956a1369b7d6f17a5ded676ffbf4e87ee412cd9df890975958e48186195a`; `release.json` — `649dd9677c5e37dff9ef3425d71f027c4113492cc0bdd59db9b30c8d7d233686`. Receipts находятся в `.ai-factory/state/adapt-hlv-1-1-0-issue-255/custody/`; это хэши API snapshots, не source tarball или бинарника.

GitHub release API публикует следующие asset digests (они прочитаны из metadata, скачивание и локальная сверка архивов **NOTRUN**):

| Asset | Опубликованный digest |
| --- | --- |
| `hlv-aarch64-apple-darwin.tar.gz` | `sha256:8255075335a9dfeb83817e647654316908fc4b1dc901b2e17edc6d8fb44a8358` |
| `hlv-aarch64-unknown-linux-gnu.tar.gz` | `sha256:bd01bd6d6b4c18a4cc7e2321f237fbde4c4608425adb68fd8304070a62a0f1d5` |
| `hlv-x86_64-apple-darwin.tar.gz` | `sha256:2882f8bfc4c045cc6823238913a0fe9807e3ffd41df2e372b7513df10c410184` |
| `hlv-x86_64-pc-windows-msvc.zip` | `sha256:988dfa4903f8aa92c68b970a32ec784c2a732c0c88b1c65c350799b47caa565d` |
| `hlv-x86_64-unknown-linux-gnu.tar.gz` | `sha256:4d526483d0ae7f728cd29f389be25075a7e2e9719907ff322735cb9fe76e5007` |

HLV поставляется GitHub release binaries либо git-based сборкой `cargo install --path .` согласно [README exact tag](https://github.com/lee-to/hlv/blob/v1.1.0/README.md). npm contract в этой поставке отсутствует, поэтому `npm view` неприменим. Source tarball integrity не вычислялась; для git-based source custody зафиксирован exact tag object и commit. Опубликованные tar.gz digests выше относятся к платформенным архивам, а не к source tarball.

Через GitHub MCP прочитаны [check.rs](https://github.com/lee-to/hlv/blob/v1.1.0/src/cmd/check.rs), [status.rs](https://github.com/lee-to/hlv/blob/v1.1.0/src/cmd/status.rs), [execution_evidence.rs](https://github.com/lee-to/hlv/blob/v1.1.0/src/check/execution_evidence.rs) и README. Check содержит additive `structural_only/structural_status/execution_evidence`; status — `execution_evidence`; EVD-001/010/020/030/040 остаются в существующем формате кодов. Остальные delta/no-op выводы взяты из брифа, без заявления о повторном полном upstream diff.

## Executed matrix

| Проверка | Результат и граница |
| --- | --- |
| Strict OpenSpec change validation, CLI 1.15.0 | PASS, valid=true; только INFO о native skip_specs |
| Ledger/contract, additive check/status normalization, EVD-коды и schema/exit agreement | In-process focused: 4/4 PASS; это deterministic contract tests, не запуск HLV 1.1.0 |
| CLI 1.0.0 rejection, old saved contract, EVD process/error/warning, greenfield/adopt, doctor/readiness/trace | Регрессии в canonical `scripts/validation-providers.test.mjs` и fake-hlv; полный process run заблокирован `spawn EPERM` в sandbox реализации; оркестратор повторил полные gates вне sandbox — см. ниже |
| Init/adopt/dry-run и MCP | In-process suites: 23/23 PASS; init fixture использует 1.1.0, dry-run не запускает команды |
| Execution-task-source | In-process: 1 PASS (task grammar), 23 FAIL environment при git spawn EPERM |
| `npm test` | FAIL environment: Node test runner child spawn EPERM; зелёный полный suite не заявляется |
| `npm run validate` | FAIL environment: validate-extension завершился, validate-artifact-boundaries не смог запустить git (spawn EPERM) |
| Отдельные validators | validate-extension, doc-links, codex-agents, claude-agents: PASS; это не заменяет полный npm run validate |
| Native HLV 1.1.0 binary/fixtures | NOTRUN: доступный PATH binary сообщает 1.0.0 |
| CI, публикация | NOTRUN |

Исторический Windows HLV 1.0.0 binary SHA256 `76cdb4bd29ed60b284bc0f48e934cfbba988438618fd0096db1aa8e85dd97f70` и upstream fixtures commit `2a817996bee04a97061669cb37d5966a17980610` остаются [исторической native evidence](validation-providers.md#validation-evidence-2026-09-05). Локально подтверждён тот же binary/version; его успешные старые smoke не квалифицируют 1.1.0. Новый fake-hlv — hermetic process fixture AIFHub, не upstream fixture или реальное execution evidence.

## Adaptation and ownership

| Surface | Решение |
| --- | --- |
| Reviewed command contract | `aifhub.hlv-cli@1.1.0`, exact toolVersion 1.1.0, source tag v1.1.0; другие версии unsupported/tool_version |
| Saved evidence | Сравнение id+version+source остаётся fail-closed; старые hlv-evidence требуют re-validation перед done/archive даже на той же source revision |
| `check/status --json` | Extra fields игнорируются; diagnostics/counts/strictness/exit agreement остаются авторитетными, EVD error → fail и warning → warn |
| Doctor/readiness/trace | Прежние команды; DOC-080 → unsupported, workflow semantics и content-digest-only trace сохраняются |
| Native init | Прежний `init --adopt`; fixture version согласована с provider; dry-run без команд и writes |
| Ledger | `sources.hlv`: version/baselineVersion 1.1.0, lastSync 2026-10-30, URL exact tag. Schema `sources.additionalProperties → sourceMetadata` и validator loop по Object.entries допускают этот ключ |
| Новые upstream функции | AIFHub не вызывает `--structural-only`, `hlv evidence snapshot`, не пишет `project.yaml.execution_evidence` и не расширяет MCP |
| Spec capability | В accepted specs нет HLV provider capability; отдельное упоминание отложенной адаптации не создаёт такую capability. Change использует skip_specs с обоснованием в proposal |

Пользовательская optional execution-evidence секция может выдавать missing/stale EVD errors: они блокируют validate и вслед за ним done/archive readiness до исправления evidence. Structural pass не отменяет эту ошибку. AIFHub не подменяет EVD producer и не меняет warning policy. CLI устанавливает/обновляет пользователь отдельно.

## Reproduction and evidence limits

```text
gh api repos/lee-to/hlv/git/refs/tags/v1.1.0
gh api repos/lee-to/hlv/git/tags/941f0c671a28a7e23eafae45267e27123bbcdb81
gh release view v1.1.0 --repo lee-to/hlv --json tagName,publishedAt,url,assets
npm test
npm run validate
openspec validate adapt-hlv-1-1-0-issue-255 --type change --strict --json --no-interactive --no-color
```

В данной среде gh API недоступен из-за proxy connection refused; использован read-only GitHub MCP к тем же upstream данным. Context7 resolve запрошен, но исчерпана квота, поэтому docs брались из exact upstream tag. Полные repo gates и process-dependent регрессии необходимо повторить там, где разрешён child spawn; assertions не ослаблялись. QA receipts и итоговый verify report находятся в `.ai-factory/qa/adapt-hlv-1-1-0-issue-255/`. OpenSpec change и QA/runtime trees ignored согласно политике extension-репозитория; source audit и regression tests входят в обычный diff. Extension version, теги, push и глобальная установка HLV не менялись.

### Orchestrator verification (вне sandbox)

Полный suite на merge-HEAD: **1944 pass / 0 fail / 3 skipped** (1948 tests), `npm run validate` exit 0 — повторяет обе строки audit-таблицы, Environment failures были sandbox `EPERM`, не дефектами адаптации. CI PR #264: все матрицы PASS (ubuntu+windows, Node 18/20).
