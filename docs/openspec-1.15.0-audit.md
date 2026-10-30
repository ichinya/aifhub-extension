# OpenSpec 1.15.0 compatibility audit

Кумулятивный review от 2026-10-30 для [issue #255](https://github.com/ichinya/aifhub-extension/issues/255), продолжение [1.13.0 audit](openspec-1.13.0-audit.md). Контракт реализации — предоставленный research devin, разделы 1–5. Reviewed baseline: 1.15.0; stable range `>=1.3.1 <2.0.0`, Node `>=20.19.0`, prerelease exclusion сохранены.

## Source and executable custody

Source checkpoints ниже перенесены из source-verified devin §3: все семь тегов напрямую указывают на commit (тип commit). [Compare v1.13.0...v1.15.0](https://github.com/Fission-AI/OpenSpec/compare/v1.13.0...v1.15.0): 165 commits, 300 files. [Official releases](https://github.com/Fission-AI/OpenSpec/releases) и npm executable custody независимы; source pins не доказывают исполнение каждого промежуточного npm-пакета.

| Релиз | Tag → commit | GitHub release | npm published | npm integrity (sha512) | sha1 | files |
|---|---|---|---|---|---|---|
| [1.13.1](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.13.1) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.13.1)) | `634c557bd0470eec37861b46172c3f503d283c1b` | 2026-09-17T01:11:07Z | 2026-09-17T01:14:12.411Z | `sha512-UHJSV2n6ohjfRaJLvi526avOohFS/orCjM+7JPgvDzuEJbCCkykKfP2fp3gcsvthDLeWolMRT5JAE08MSPnr8Q==` | `50fcb3d2fa8830a9fcdf036155fca4520d03dff1` | 401 |
| [1.13.2](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.13.2) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.13.2)) | `db2309783547a14e150dbcbfc19120e4028446c3` | 2026-09-23T21:44:30Z | 2026-09-23T21:47:05.420Z | `sha512-HzBaN9C1/ET+tgm/pxbWQYY4Kf+X9/1MSVEGQ8ZT3g4ZpdHn6v82CHkN+zmt9qv98Ghw0MDpmURasjJD2f90bg==` | `ae88d3667eff76495e517399b3e0385d9d6af009` | 403 |
| [1.14.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.0) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.0)) | `94ca9c1eb15d1b49c06c988419b75c3d95f8b2b5` | 2026-09-30T22:52:17Z | 2026-09-30T22:54:22.058Z | `sha512-V+zitRK918I6B3EIcYL3gVYoPoPgzknSxE1zL0zUQdbd4NsO5kbrxU5jVceuNNEznD94pbRPCvpCDIa6BeEaPA==` | `ac2758566048099c1b5626ede3ab568772f8f5f9` | 413 |
| [1.14.1](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.1) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.1)) | `87c3595ace6a2e22957f39ebe5b74c2f2316e0cb` | 2026-10-06T00:38:28Z | **2026-10-05T23:28:44.551Z** ⚠ | `sha512-IU9ggB7UYMDU47S0R59NH2ngJp+CK2X/r1B8+QU2Fm8LLBPFatQRO1Ia7B8nO3FHbTE7xRXAIs9NcuUF8Beeag==` | `cf4c18ecda23818ae176ae41ba5a3741b18b641d` | 429 |
| [1.14.2](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.2) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.2)) | `f80d860fc510ba4f51180c8ddde35b91b32de657` | 2026-10-15T00:15:19Z | 2026-10-15T00:17:25.212Z | `sha512-GgCphpZD5FHfk6IGjQPkUtz+pfeztWAz2yqODlSGqOzYHRPqfYQkSds1uY783AP0S5Kx0+HiyrISlJ5LqDcsrw==` | `a3eae80c3e75d048d9d5cede4f395fe5c23ca157` | 429 |
| [1.14.3](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.3) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.3)) | `c794978f4f8845ce59693373c9dd882ee776588c` | 2026-10-17T01:52:12Z | 2026-10-17T01:53:47.490Z | `sha512-ALFW1d5bSm6t27Kmcle93SDFuqUc8fLwy5ZdBfIiNffo0Yk9AEOJxw6xDqBv38eMM7l7TeOZBB/7C08luxYGfg==` | `bf083ea41e0d2c0dbbef00ca0e4f8ca1fdd84881` | 431 |
| [1.15.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.15.0) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.15.0)) | `8e0288df12d401b0e183e2f47254d22528c1dffb` | 2026-10-24T00:50:05Z | 2026-10-24T00:51:18.868Z | `sha512-lG/EPEiL22bB70yKJhWWSPk1UQGLnwO7Dp+hNc/jUmBwb0qxPLzHCUkXEfkny4iYDOsgnsNQmc39/g9QcvnBnA==` | `5f516375c1a340425677cb997dc8fc74954d2076` | 441 |


Для каждого checkpoint источники: официальный tag/release `https://github.com/Fission-AI/OpenSpec/releases/tag/v<VERSION>` и exact npm registry metadata `https://registry.npmjs.org/@fission-ai/openspec/<VERSION>`. Npm 1.14.1 опубликован раньше GitHub release примерно на час; обе временные метки и независимые пины сохранены.

Все пакеты: engines.node `>=20.19.0`, bin `bin/openspec.js`, lifecycle preinstall/install/postinstall отсутствуют. Для exact 1.15.0 driver проверяет эти поля, SHA-512/SHA-1 tarball и SHA-256 каждого из 441 installed files до запуска package code. Установка выполняется вне checkout с `--ignore-scripts`; cached tarball имеет те же пины. Runtime-deps delta: `@inquirer/core ^11.2.1 → ^12.0.0`, удалён `fast-glob ^3.3.3`, добавлены `picomatch ^4.0.4`, `tinyglobby ^0.2.17`, `brace-expansion ^5.0.12`.

Standalone assets 1.15.0: `openspec-{darwin,linux,windows}-{x64,arm64}[.exe]`, Linux musl variants и `SHA256SUMS`. Это отдельная upstream custody-цепочка; npm matrix не квалифицирует binaries. Context7 resolve был запрошен, но квота исчерпана; текущая документация не использована как exact-version evidence.

## Executed matrix

Reproduction targets: [driver](../scripts/openspec-compatibility-live-smoke.mjs), [1.15 cases](../scripts/openspec-1-15-live-cases.mjs) и inherited 1.12 cases. Локально на Windows / physical Node 24.13.0 выполнены **37 JSON rows прямыми shell-запусками exact CLI** (все PASS), отдельная strict-проверка native retirement (PASS), пять text archive rows (PASS), и strict validation текущего change (PASS, issues: []). До этой матрицы SHA-256 сверка всех 441 installed files прошла. Exact npm `.cmd --version` также вернул 1.15.0. Это частичная direct-CLI matrix; **полный driver через реальные runner functions не завершён**: `spawnSync tar EPERM` в sandbox. Direct shell execution не заменяет недоступные runner/child-process проверки. JSON-команды проверяют полный parseable документ, exit и stderr; text/adapter rows сохраняют диагностику. Telemetry отключена process-local, fixtures изолированы.

| Surface | Наблюдение direct CLI / граница полного driver |
|---|---|
| Detection, strict validate, status, spec/change show, apply/archive instructions | Прямые status/show/instructions argv: PASS, один JSON document. Detection freshness/capabilities: deterministic PASS; реальные runner subprocesses NOTRUN |
| Unknown metadata | skip_design + bogus_key: одна WARNING, non-strict exit 0 / strict exit 1 |
| Native metadata и x- | schema/created/skip_specs и retirement recognized; skip_specs без delta-файлов даёт один ожидаемый INFO zero deltas accepted; x-goal/x-jiraKey/x-owner/x-list/x-empty проходят strict; X-Tracker, x-, x- tracker отклоняются |
| Requirement length | ADDED body 501: WARNING; 499/500: pass; MODIFIED 501: pass; main-spec 501: WARNING; heading не входит в счётчик |
| Unapplied delta content | Notes, проза перед requirement и перед первым section: WARNING, strict failure; Purpose и fenced examples проходят |
| Repeated sections | Две реальные show delta, requirement/scenario name, archive обеих и fenced bytes; residual resolved upstream in 1.13.1 |
| Blocking archive | Pre/post inventory SHA-256 совпадает; non-zero не принимается за archive success |
| Inherited 1.12/1.13 | Direct PASS: totals non-strict 4/1 и strict 3/2, INFO preflight, show/archive repeated sections и native retirement. Полный inherited suite (apply states, CommonMark bullets, guarded retirement, schema rollback, EIO/tool fixtures через driver) NOTRUN из-за spawn EPERM |
| Windows | CRLF сохраняется; exclusive-file-lock failure и успешный retry после release |

## Adaptation and ownership

| Checkpoint | Material surface | Решение |
|---|---|---|
| [1.13.1](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.13.1) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.13.1)) | show completeness, orphan requirement/scenario validation, case/RENAMED and blocking-sync archive guards, bulk preflight, config instruction/.npmrc/update hardening | Adapter: resolution docs и complete-show regression. Остальные validation/archive guards retain upstream fail-closed; не копировать merge/security implementation |
| [1.13.2](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.13.2) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.13.2)) | Windows archive lock/CRLF, scenario-loss diagnostics, strict update preservation, task sourcePath/line | Retain с Windows probes; additive JSON envelopes сохранены |
| [1.14.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.0) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.0)) | Unknown metadata WARNING, requirement/scenario name, durable names/short requirements guidance, project.md migration, tool integrations | Adapter fixtures и короткий authoring hint; additive name retain; migration/generated integrations upstream-owned |
| [1.14.1](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.1) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.1)) | ADDED body >500 WARNING, retirement cleanup diagnostic, lazy CLI startup | Adapter boundary fixtures; full JSON/exit/stderr проверены; cleanup и startup upstream-owned |
| [1.14.2](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.2) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.2)) | Unapplied delta WARNING, x- exemption, in-project symlinks, brace limits (>16 depth / >1024 expansions) | Adapter fixtures и portability hint; containment/brace implementation retain upstream-owned |
| [1.14.3](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.14.3) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.14.3)) | tinyglobby/picomatch/brace-expansion replaces fast-glob/braces, GHSA-vfj7-8cjw-p6xm, CI/OPEN_SPEC_INTERACTIVE spinner, glob containment | Reviewed no-op: AIFHub не реализует glob; dependency/security provenance сохранена, direct JSON при process-local CI=1 не содержит spinner; hosted CI NOTRUN |
| [1.15.0](https://github.com/Fission-AI/OpenSpec/releases/tag/v1.15.0) ([npm](https://registry.npmjs.org/@fission-ai/openspec/1.15.0)) | Standalone install/version/update --dry-run, binary distribution и SHA256SUMS, JSON startup | Docs-only upstream-owned install channel; runner resolver explicit/project-local/PATH и Node checks сохранены |

AI Factory, Lekalo и HLV в этом change не адаптируются. Skills, /opsx commands, schemas, Stores, init/update, generated integrations, Nix и completions остаются upstream-owned. Никаких новых runtime dependencies и policy fallback из strict в non-strict. Все семь checkpoints добавлены в reviewedStableVersions; прежние historical fixtures сохранены.

## Reproduction and evidence limits

Подготовить exact npm package вне checkout, hash-verify tarball до установки, установить с disabled lifecycle, затем выполнить:

```text
node scripts/openspec-compatibility-live-smoke.mjs <installed-package-root> <openspec-1.15.0.tgz>
npm run validate
npm test
openspec validate adapt-openspec-1-15-0-issue-255 --type change --strict --json --no-interactive --no-color
```

PATH CLI при старте работы: 1.13.0. Обновление пользовательской установки до exact `@fission-ai/openspec@1.15.0` выполняет оркестратор отдельно. Direct CLI matrix использует checksum-bound `bin/openspec.js`; explicit npm shim отдельно проверен через `--version`. Physical Node 20 CLI, standalone binaries, symlink privilege cases, hosted Ubuntu CI и publication не следует выводить из локального Windows запуска. Локальный accepted-spec corpus существует; canonical OpenSpec paths ignored политикой этого extension-репозитория и не включены в package. Текущий canonical change проверен отдельно без archive. Изменений extension.json.version, tags, push и публикации нет.

Локальные repo checks (sandbox реализации): `npm test` и `npm run validate` — FAIL environment (child spawn EPERM); in-process focused run 100/100 tests PASS. Полные gates повторены оркестратором вне sandbox на merge-HEAD: `npm test` — 1937 pass / 0 fail / 3 skipped, `npm run validate` — exit 0, локальный CLI обновлён до exact 1.15.0 (`openspec --version` = 1.15.0). Codex agents, Claude agents и doc-links validators PASS. Artifact validator текущего change: warn (missing generated rules и trace), exit 0; это не final verification. Node 18/20 physical runs и hosted CI — NOTRUN (hosted CI выполнен на PR отдельно). Assertion/gate ослабления для получения зелёного результата не вносились.

Уточнение fixture к research: `skip_specs: true` нельзя совмещать с delta-файлами (upstream ERROR); no-spec fixture сохраняет ожидаемый INFO и изолирует ровно один WARNING в negative cases. Gates inherited 1.12 totals и missing-base INFO расширены только после наблюдения этих результатов на exact 1.15.0. Локальные raw JSON/text receipts и hashes сохранены в `.ai-factory/state/adapt-openspec-1-15-0-issue-255/evidence/`, отдельно от canonical change.
