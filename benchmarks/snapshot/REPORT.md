# Snapshot cost matrix (#237)

Это воспроизводимый offline harness без model calls, paid work и автоматического продвижения: `no_promote=true`. В этой sandbox реальные Git/Node child processes недоступны (`spawn EPERM`), поэтому latency и speedup **NOTRUN-sandbox**, а не нули. Числа из consumer audit не считаются результатом этой матрицы.

## Измеренные результаты (A0 = 81ccd86, A-first = candidate №1+3+4+5; Windows, 2026-10-26)

Все прогоны `PASS`, semantic equivalence между arms подтверждена, no_promote=true. Median wall по 10 paired repeats:

| Сценарий | Профиль | A0 | A-first | Ratio | Git counts (diagnostic) |
|---|---|---|---|---|---|
| W-m8-l981-directory | process-cold | 4955.7 ms | 3722.7 ms | **×1.33** | rev-parse 19→18, stage 18→18, names 9→9 (46→45) |
| W-m8-l981-directory | process-warm | 4883.1 ms | 3634.8 ms | **×1.34** | — |
| I-w2-preflight | process-cold | 4075.1 ms | 3544.4 ms | ×1.15 | rev-parse 36→18 (identity combined, №4) |
| I-w2-preflight | process-warm | 3810.1 ms | 2619.3 ms | **×1.45** | — |
| S-m8-l981-lifecycle | process-cold | 15959.1 ms | 16247.8 ms | ×0.98 (нейтрально в шуме) | rev-parse 76→72 |
| S-m8-l981-lifecycle | process-warm | 14671.0 ms | 16455.9 ms | ×0.89 (нейтрально в шуме) | — |
| S-m8-l981-result-replay | process-cold | 4044.2 ms | 4106.3 ms | ×0.98 (нейтрально) | rev-parse 19→18 |
| S-m8-l981-result-replay | process-warm | 4015.6 ms | 4964.2 ms | ×0.81 (нейтрально, IQR широк) | — |

Честные выводы: изолированный read-only worktree и isolation preflight ускоряются; полный lifecycle на текущем наборе оптимизаций нейтрален в пределах шума — доминирующий член (хеширование leaf-файлов всех репозиториев) остаётся и адресуется отложенными кандидатами (№2/№9 после отдельных дизайн-итераций). Результаты — одна Windows-машина; distributions не смешиваются с Linux.

## Запуск в Windows Git Bash

Нужны уже подготовленные checkout A0 (`81ccd8686f15cae729fbd652ef50b6ee57b9f689`) и candidate. Harness запускается из текущего репозитория, а helpers импортируются из каждого указанного arm. Ничего не устанавливается; remote/tags не меняются. Пути в примере заменить своими.

```bash
npm run benchmark:snapshot -- --pin D:/checkouts/snapshot-A0 --out C:/Users/User/AppData/Local/Temp/snapshot-A0.identity.json
npm run benchmark:snapshot -- --pin D:/Projects/aifhub/aifhub-extension --source working-tree --out C:/Users/User/AppData/Local/Temp/snapshot-first.identity.json
node --input-type=module - <<'NODE'
import fs from 'node:fs/promises';
const dir = 'C:/Users/User/AppData/Local/Temp/';
const arms = [
  { name: 'A0', root: 'D:/checkouts/snapshot-A0', identity: JSON.parse(await fs.readFile(dir+'snapshot-A0.identity.json')) },
  { name: 'A-first', root: 'D:/Projects/aifhub/aifhub-extension', identity: JSON.parse(await fs.readFile(dir+'snapshot-first.identity.json')) }
];
await fs.writeFile(dir+'snapshot-arms.json', JSON.stringify(arms, null, 2));
NODE
npm run benchmark:snapshot -- --arms C:/Users/User/AppData/Local/Temp/snapshot-arms.json --scenarios W-m8-l981-directory --out C:/Users/User/AppData/Local/Temp/snapshot-results.json
node benchmarks/snapshot/summarize.mjs C:/Users/User/AppData/Local/Temp/snapshot-results.json
```

После коммитов candidate пинится без `--source working-tree` (по умолчанию `committed`): каждый hash дополнительно сравнивается с `git show <full-commit>:<module>`. До коммитов source явно `working-tree`, commit обозначает базу, а recursive module hashes — реальные исполняемые bytes. Проверка выполняется до import и после operation. Нельзя приписывать working-tree bytes содержимому commit. Closure включает относительные static/dynamic imports трёх entrypoints, а не только пять release provenance helpers.

Без `--scenarios` выполняется весь каталог; `--profiles process-cold,process-warm,diagnostic` выбирает profiles. Полный H-large профиль дорогой: setup valid histories через реальные APIs исключён из timed window. Для отдельных №1/3/4/5 подготовить независимые arms поверх A0 и повторить ту же команду с двумя соответствующими identity records. Накопительный commit после №3 не обозначать «только A3». Future A2/A6/A9 и grouped prototype в эту итерацию не входят.

## Что измеряется

- W: 24 cells M=0/2/8/16 × L=100/981/4000 × exact/directory; отдельно IO-heavy, dirty/untracked/ignored input.
- S: lifecycle и fixed-state result/accept replay на трёх основных topology; отдельно creation/deletion. B: K=3, оба acceptance order, fixed-state replay. I: два linked workers, только read-only preflight, без worker admission.
- H: 1/20 changes, small/large sets настоящих validated journals. F: normal/linked/detached/old-form/gitfile/divergent и EOL/filter compatibility. N: byte/ignored/mode/scope/metadata drift, drift во время чтения, pathname replacement, links/junctions, 16 MiB/16 MiB+1/count bound и interrupted publication.
- L — фактическое число исходных физических snapshot leaves, включая `.gitmodules` и canonical history plans, без gitlinks/admin/runtime. Generator проверяет его; subsequent creation/deletion сохраняется в семантике операции. Scope directory `data` затрагивает root data leaves; все tracked module leaves всё равно сканируются.
- Reference arm один раз готовит starting state в disposable checkout. Cold/warm arms получают те же физические bytes/config/HEAD/index/modes/source/context/evidence/history. Before digest дополнительно включает bytes всего starting image, в том числе runtime/admin; отсутствие неожиданных writes проверяется для read-only операций. Служебные paths/contents не экспортируются.
- Cold: новый Node на каждый из 10 paired repeats. Warm: отдельный Node для arm, два untimed warmups, десять measured calls; starting image восстанавливается вне timed window. A/B порядок чередуется с seed; для warm балансируется порядок arm processes между scenarios. OS cache uncontrolled, **это не disk-cold**.
- **Ограничения протокола (Devin Review #241):** (1) в warm-профиле блок из 10 замеров одного arm идёт целиком до блока другого — дрейф хоста между блоками может подмешиваться в paired ratio; тепловой результат считать вторичным по отношению к process-cold (свежий Node на repeat), а согласованность cold/warm ratio — кросс-проверкой на дрейф; (2) `restore` возвращает fixture к эквивалентности по bytes и mode, но не по inode/timestamps листьев — армы, чувствительные к filesystem identity, обязаны перепинить fixture; N-family drift-сценарии прогоняются против реального custody-кода, а не против restore-состояния.
- `wall_ms` — только operation wall, без setup, restore, identity verification и manifest checks. Median/IQR и все raw repeats сохраняются, paired ratios сопровождаются IQR; statistical significance не заявляется. CLI startup отдельно не измеряется и не включается в speedup.
- Trace2 и fs observer включены только в diagnostic runs. Git считается по уникальному `start.sid`: `rev-parse`, `stage-list`, `names-list`, `other`. FS counters: opens, read calls, фактические bytes, lstat/fstat/realpath/readdir, peak observed fd. `readFile` — один наблюдаемый API read; внутренние syscalls libuv не выдаются за измеренные. Счётчики относятся только к Node helper, Git IO не наблюдается.
- `peak_rss_kib` — high-water mark всего arm process (включая imports/untimed restore), не phase-only RSS. Storage/filesystem/antivirus/indexer и недоступные метрики — `UNKNOWN`/`null`. Windows/Linux distributions не смешиваются.
- Catalog generator digest, catalog digest с привязкой двух pinned identities и harness digest фиксируются. Runtime `runner_metrics.v1` (#230) не меняется: counters принадлежат эксперименту.

## Gates и известный negative baseline

Закрытые schemas: `schemas/snapshot-benchmark-catalog.schema.json` и `schemas/snapshot-benchmark-results.schema.json`. Runtime проверяет тот же dependency-free subset, identity shape, topology, fixture equivalence, statuses и canaries. Статический catalog содержит пустой `arms` template; runner связывает его с двумя pins и вычисляет bound catalog digest.

FAIL/NOTRUN rows сохраняются; NOTRUN никогда не имеет числового времени. Успешные samples агрегируются отдельно, но любой FAIL/NOTRUN либо отсутствие arm запрещает paired speedup для этой группы. Safety/equivalence veto не зависит от latency. Timeout или unsupported POSIX executable-bit на Windows не превращается в PASS.

`N-identity-replacement` — documented A0 gap: pathname заменяется после open на обычный файл с прежними bytes. A0 не связывает fd с final pathname и может вернуть success; это **FAIL/unexpected-success baseline**, а не ожидаемый PASS. Candidate обязан вернуть `file-changed`. Такой negative arm блокирует aggregate promotion и не считается обычным performance regression; успешные W/S/B группы анализируются отдельно. В harness нет ослабляющего allowlist, который превращает известный gap в PASS.

## Ожидаемые счётчики (не измеренный speedup)

Worktree: A0 `1+5R`, после №3 `5R`: R=1 — 6→5, R=9 — 46→45, R=17 — 86→85. Diagnostic breakdown candidate: `rev-parse=2R`, `stage-list=2R`, `names-list=R`. Конечный 2-spawn/repo re-inspect сохранён.

Если S уникальных scoped leaves уже входят в L tracked/untracked leaves, A0 делает примерно L+S content acquisitions, candidate L. При S=L это 2L→L (×0.5); при exact scope S=1 общий read count не сокращается вдвое. Overlapping scopes могут давать более двух исходных reads. Source/context/journal reads lifecycle остаются отдельными затратами.

№4 экономит четыре Git invocations на каждый parent/worker за два identity passes: при W=2 это 12. Вместе с №3 isolation preflight без modules ожидает 54→36 Git calls. №5 сокращает normal start source resolutions 3→2, сохраняя final fresh source; не обещает ровно треть всех fs reads.

## Проверка на unrestricted runner

```bash
node --test scripts/snapshot-benchmark.test.mjs scripts/snapshot-leaf.test.mjs scripts/snapshot-root-identity.test.mjs scripts/isolation-identity.test.mjs scripts/execution-admission.test.mjs
node --test scripts/workflow-mechanics.test.mjs scripts/execution-task-source.test.mjs scripts/execution-submodules.test.mjs scripts/execution-batches.test.mjs scripts/execution-recovery.test.mjs scripts/isolated-execution.test.mjs
npm run validate
npm test
node scripts/generate-provenance.mjs --check
```

В Node 24 доступен in-process fallback `node --experimental-test-isolation=none --test <files>`; он не заменяет real Git/linked/separate-root/junction/recovery suites. OpenSpec `/aif-verify snapshot-cost-matrix` остаётся отдельным authoritative gate. Корневой `openspec/` в этом extension repository игнорируется и запрещён tracked artifact-boundary validator: canonical change остаётся локальным workflow context, его не следует force-stage вместе с распространяемым extension.
