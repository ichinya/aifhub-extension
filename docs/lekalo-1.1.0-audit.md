# Аудит адаптера Lekalo v1.1.0 (#255)

## Контракт и custody

Нормативный scope: бриф `D:/Projects/aifhub/brief-255d.md` и зафиксированные решения задачи #255. Источник — [tag v1.1.0](https://github.com/ichinya/lekalo/tree/v1.1.0). Локальный Git object tag разрешён в commit `87b6bc2fcc66660de0f7b3a9c7c50c3d8d3a19b4`; это source custody, без утверждения о скачанном release binary.

Локальное сравнение `v1.0.0..v1.1.0` для `docs/provider-contract.md` и `tests/fixtures/provider/describe.v0.8.0.golden.json` не содержит изменений. [Workflow contract](https://github.com/ichinya/lekalo/blob/v1.1.0/docs/provider-contract.md) — exact `dev.lekalo.workflow-provider@0.8.0`, discriminator `lekalo/workflow-provider/v0.8.0`. Manifest productVersion 0.8.0 — implementation generation; CLI pin 1.1.0 проверяется через --version.

Reviewed manifest digest: `sha256:a674f1dd6f5608a28b8f1727bcddae4ad67adceace33e871ebb4334f091315d0`. Проверяется canonical sorted-key JSON без manifestDigest: это identity metadata, не подпись. Изменение неизвестных полей, операций, effects, bounds или schema pins отклоняется. [Локальная копия golden](../test/fixtures/validation-providers/lekalo-describe-v0.8.0.json) получена из tag (BOM удалён при записи). Содержимое JSON сохраняется; bytes переведены в локальные line endings.

Release assets и SHA256SUMS: **UNKNOWN / не проверены**. GitHub API недоступен из текущей среды (proxy connection refused); executable не скачивался. Следовательно, проверка binary checksum/provenance и соответствия установленного бинарника release tag не заявляется.

## Источники уточнений

Versioned schemas tag уточняют сокращённый перечень брифа: doctor v0.3.2 допускает также `adapters.trust`; validation-report v0.6.4 требует profileVersion и registryVersion 0.6.4. Адаптер сохраняет эти exact pins. Продукт, Model, diagnostic schema, registry и provider identity — отдельные версии.

`schemas/provider-config.schema.json` проверена: policy/phases/timeoutMs/maxOutputBytes/executable уже разрешены для Lekalo; новые config keys не нужны. Semantic evidence расширено `complete`, nullable context для impact без capsule и bounded fits/minimumRequired/excluded metadata. При неполноте PASS запрещён; дополнительные private поля capsule игнорируются при projection.

## Граница evidence

Адаптер реализует только prescribed read-only detect/status/doctor/validate/readiness/trace/impact/context. Init --adopt — отдельный явно включённый initialization entrypoint, без install prompt. Validate всегда --no-cache. Report verdict нормализуется до gates; success-envelope с classification error findings default-профиля остаётся warn с исходной severity. Partial trace/context не выдаются за полное покрытие.

Trace custody: `.ai-factory/traces/<change-id>/lekalo-trace-manifest.json`; адаптер экспортирует существующий manifest, не вызывает trace collect. Публичные provider envelopes содержат только bounded metadata, LEK-коды и sha256 references; raw streams и private capsule не сохраняются.

Native gates, LPAC/Job sandbox, generated-artifact execution и orchestration component receipts — upstream-owned. Наличие Lekalo не подтверждает выполнение native gates AIFHub. Drift/generate/sync/install prompt/trace collect остаются fail-closed.

## Проверки и ограничения

Hermetic fixture воспроизводит version/describe, report verdicts, три формы success validate, exits 1/3/4/5, malformed JSON, overflow и privacy strings. In-process injection проверяет adapter projection; отдельные process regression cases используют тот же fake CLI через Node. Это не runtime acceptance реального продукта.

Дополнительно сохранены report/impact/context golden JSON из того же tag (`tests/fixtures/doctor/doctor.degraded.golden.json`, `tests/fixtures/impact/golden/planner.impact.json`, `tests/fixtures/context/golden/planner.context.envelope.json`). Они проверяют совместимость нормализации с реальными upstream wire shapes. Их fixture productVersion и source mode не являются наблюдением установленного CLI.

Реальный бинарник Lekalo: **NOTRUN** по условию задачи. Node 18/20 compatibility сохраняется по использованным API; фактическая локальная среда — Node 24.13.0. Полный npm test и npm run validate требуют среды с разрешённым child process spawn; текущий sandbox возвращает EPERM. Фактические QA результаты хранятся вне canonical change.
