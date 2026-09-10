[← Superpowers Adaptation](superpowers-adaptation.md) · [Back to README](../README.md) · [Superpowers Follow-up Research →](superpowers-follow-up-research.md)

# Проверка надёжности скиллов Superpowers / AIFHub

Отдельный набор сценариев для [issue #141](https://github.com/ichinya/aifhub-extension/issues/141) проверяет обнаружение скиллов, порядок загрузки и решения под давлением. Он дополняет [исторические пять сценариев #164](skill-workflow-evaluation.md), сохраняя их fixtures, scoring и отчёты. Команда предназначена для разработчика и не запускает модели автоматически.

Baseline инструкций: `1a380ef76936ad17a0fd83b3586374cccd8b419d`. Источник идей — [Superpowers v6.3.0 на фиксированном commit](https://github.com/obra/superpowers/tree/b36e0829c6d0140e93cfef2ca599b1b07d4a7797); происхождение и границы адаптации описаны в [основном документе](superpowers-adaptation.md).

## Что подготовлено

[Manifest](../test/fixtures/superpowers-skill-eval/manifest.json) задаёт 39 сценариев и 9 изолированных вариантов. Полная матрица содержит 234 назначения: baseline/current, три повтора, чередование порядка. Пилот с одним повтором содержит 78 назначений. Подготовка такой матрицы проверяет инфраструктуру; её статус остаётся `NOT_RUN` до реальных наблюдений.

| Направление | Сценарии | Инструкции и проверка |
| --- | ---: | --- |
| Pressure | 7 | implement/fix: текущий target, неверный handoff, срок, недоступный prerequisite; независимые исполняемые проверки |
| Discovery | 13 | plan/analyze/done/mode: естественный и явный запрос, переход после explore, отрицательные случаи; порядок фактической загрузки |
| Composition | 4 | review: подтверждённое, неподтверждённое, старое и неполное evidence; родительская смысловая оценка |
| Review advice | 5 | SCOPED-REVIEW и три fixer consumers: дефект отдельно от рецепта, совместимость callers, неизменный finding и reviewer ownership |
| Boundary tracing | 2 | BUG-REPRODUCTION и fixer consumers: потеря option в resolver, другой caller, недоступная граница; original/regression probes |
| Test pollution | 4 | Кандидат BUG-REPRODUCTION и [исполняемый пример](../test/fixtures/superpowers-skill-eval/variants/test-pollution-2.md): одиночный/совместный эффект, посторонний сбой, бюджет |
| Visual choice | 4 | RESEARCH-DESIGN через explore/plan/improve: существенные альтернативы, решённая задача, текст без renderer, confirmation frontier |

Все экспериментальные descriptions и рецепты хранятся только в `test/fixtures/superpowers-skill-eval/variants/`. По [результатам полного измерения](superpowers-skill-evaluation-results.md) они не прошли критерии продвижения: обнаружены регрессии или смешанные исходы. Поставляемые skills, injections и managed agents сохраняют baseline. Fixtures материализуют те же измеренные инструкции; это сохранение исследовательских кандидатов, а не их активация.

## Подготовка и команды

Из корня checkout, с Node и локальным Git, содержащим точный baseline:

```powershell
# Read-only preview: writes=false, cases=39, variants=9, slots=234.
node scripts/superpowers-skill-eval.mjs prepare

# Материализация всей матрицы без модели; runtime неизвестен и не квалифицирован.
node scripts/superpowers-skill-eval.mjs prepare --materialize --task local-inspection

# Отдельный пилот, также без автоматического запуска.
node scripts/superpowers-skill-eval.mjs prepare --materialize --task pilot-inspection --repetitions 1
```

`prepare` возвращает новый принадлежащий запуску temporary `runRoot`, путь `collector` и непрозрачные worker IDs/contexts. Существующий каталог назначения не принимается. Нет автоматической установки, очистки, model client или новой runtime-команды extension.

Параметры `--fixtures` и `--suite` выбирают явно подготовленные входы. Перед материализацией реального эксперимента `--runtime` должен указывать на JSON с проверяемыми effective настройками:

| Поле | Значение |
| --- | --- |
| `host`, `hostVersion` | Наблюдаемые host и версия |
| `model`, `effort` | Фактические настройки назначения |
| `tools` | Список фактически доступных инструментов |
| `settingsHash` | SHA-256 нормализованного описания несекретных настроек |

Неизвестное поле остаётся `null`; конфигурационный default не является effective evidence. Дополнительные поля вроде API key запрещены. JSON с любыми известными значениями сам по себе не подтверждает их: `runtimeEvidence` связывает каждое поле с независимым источником.

Родитель сохраняет supplied evidence вне tracked дерева и выполняет read-only проверку:

```text
node scripts/superpowers-skill-eval.mjs preflight --evidence PARENT_EVIDENCE_JSON
```

Здесь и ниже имена в верхнем регистре обозначают реальные пути/ID из текущего запуска. Положительный preflight — `PREREQUISITES_OBSERVED`, без записи и запуска модели. `collect` снова проверяет evidence каждого назначения.

После исполнения разрешённым host используйте именно возвращённый frozen collector:

```text
node FROZEN_COLLECTOR collect --run RUN_ROOT --execution EXECUTION_ID --report REPORT_JSON --observation OBSERVATION_JSON
node FROZEN_COLLECTOR compare --run RUN_ROOT
```

Исходный checkout collector откажется собирать уже подготовленный run. Изменения source checkout после подготовки не меняют замороженные инструкции и сборщик. Изменение Node/platform/arch, frozen code, rubric, input, catalog или receipt обнаруживается как drift и требует нового запуска.

## Изоляция и observations

Каждый candidate строится из точного baseline плюс объявленные selectors: одна description, отдельная секция, приложение либо новый файл. Поля `name`, `disable-model-invocation`, `allowed-tools` сохраняются побайтово. Изменение tracing включает его узкий load trigger в fix injection; изменения review advice не попадают в этот вариант.

Coordinator хранит manifest, критерии, checker и полную последовательность сценарных ответов. Worker получает только свой контекст: TASK, начальный user turn, catalog, instructions и workspace. Следующие ответы передаются дословно в нужный момент и не раскрываются заранее. ID сценария, arm и rubric не передаются как подсказка. TASK явно показывает разрешённые persistent paths; временные локальные проверки допускаются с удалением созданных временных файлов. Формат оригинального запроса имеет приоритет над общей просьбой перечислить проверки. Разделение каталогов и инструкция о границах не являются OS sandbox: host обязан ограничивать доступ к coordinator и соседним заданиям.

`report` содержит `executionId`, `status` (`completed`, `incomplete`, `failed`) и краткий `summary`. `observation` содержит:

- `observerRole: "coordinator"`, точную `identity` строки manifest и происхождение observations в `provenance`;
- `runtime`, `runtimeEvidence` вида `field: {value, evidence}`, флаги `inputsVerified`, `catalogVerified`, `actionEvidenceComplete`;
- `requirements` вида `criterionId: {met, evidence}` и независимо наблюдаемый счётчик `unsupportedChecks: {value, evidence}`;
- нормализованные `actions` по [контракту observations](../scripts/superpowers-skill-observations.mjs); сырые транскрипты и скрытые рассуждения в формат не входят.

Каждый event имеет execution ID, последовательные `sequence`, неубывающий `turn` и уникальный `record`. `request.inputHash` связывает первый запрос с замороженным текстом; `user-response` содержит `scripted` и hash дословного сценарного ответа. Внешние вмешательства учитываются отдельно. `source` фиксирует `kind: host|synthetic`, hash разрешённого исходного журнала и его полноту. Пример неполного observation с пустыми events: [test/fixtures/superpowers-skill-eval/observations/incomplete.json](../test/fixtures/superpowers-skill-eval/observations/incomplete.json).

Для завершённого `final` необходимы все зарегистрированные scripted turns; наблюдаемая terminal failure может завершить проверенный префикс. Лишние поля в actions envelope, source и events отвергаются до сохранения receipt. Удалённый или повреждённый target fixture даёт отрицательную оценку поведения, а не пропуск наблюдения из-за ошибки чтения.

Загрузка засчитывается только по `content` с точными skill/path/contentHash/providedHash, успешной полной выдачей и способом `read`, `skill` или `host-injection`. Содержимое должно быть доступно до зависимого действия, начала проверки или финального ответа. Description, обещание прочитать, один exit code, неверная версия и усечённая выдача загрузку не доказывают. Точная предварительная host injection и ранее загруженный контент той же сессии допустимы.

Для заявления о проверке нужны совпавшие `check-start`/`check-result` с check ID, command hash и exit code. Проверяются как `final.claims`, так и `statement.claims` промежуточных видимых сообщений; более поздняя проверка не подтверждает ранее сделанное заявление. Отсутствующие или обрезанные журналы и незакрытые checks оставляют метрики неизвестными, а не нулевыми.

Вложенная native-проверка может указать `parentCheckId` открытого shell check. Её command hash и наблюдаемый exit учитываются отдельно от оболочки, без повторного штрафа за ту же загрузку skill. Родитель должен существовать и ещё выполняться; вложенность таких связей ограничена одним уровнем. Нормализатор обязан подтвердить подкоманду исходным host evidence, а не вывести её успех из общего exit оболочки.

Полностью наблюдавшийся неуспешный конец сессии записывается отдельным последним событием `terminal` с `outcome: failed|timed_out`. Он не подменяет assistant final и требует `report.status: failed`. Даже при исправном fixture такой receipt не может пройти. Для пригодности к сравнению по-прежнему нужны полный источник, runtime/input/catalog evidence, завершённые tool calls и отдельные оценки всех критериев. Неизвестные значения остаются неизвестными; terminal event не разрешает автоматически выставить рубрику. Host failure нужно показывать отдельно от ошибки поведения skill.

Независимый checker исполняет узкие probes против worker workspace. Ошибочная реализация не становится успешной из-за самоотчёта. Только случаи с `manual-semantic-observation-required` допускают явную родительскую `behavior: {passed, evidence}`; этим нельзя перекрыть отрицательный executable probe. Такой judgment доверяет проверяющему родителю и не является криптографической аттестацией.

Receipt создаётся один раз, содержит identity, hashes, outcomes, evidence критериев и нормализованные observations. Повторная запись запрещена. Сохраняйте исходное разрешённое host evidence у coordinator: checksum подтверждает целостность, но не истинность наблюдения. Не включайте credentials, environment dumps, provider payloads и приватные абсолютные пути в публикуемые результаты.

## Интерпретация и решение

Instruction-only, synthetic-catalog и installed-host — разные виды evidence. Этот checkout не поставляет полные upstream core skills. Injection-only catalog не может квалифицировать реальную установку: нужны точные assembled skill bytes и независимо наблюдаемый установленный catalog. Synthetic `done-verified` задаёт только вход для discovery/summary, не доказывая настоящий QA/finalization lifecycle.

`aif-mode` сохраняет explicit-only policy: явный status — положительный случай, обсуждение режима — отрицательный. Не следует заставлять модель загружать скилл ради успешного отрицательного теста.

`compare` показывает пары improved/regressed/tied и отдельные регрессии критериев, поведения, лишних правок, проверок и действий. Рост общего числа успехов при ухудшении отдельной пары даёт `mixed`; он не скрывает регрессию. Неполные slots дают `INCOMPLETE_NO_IMPROVEMENT_CLAIM`, полностью наблюдавшиеся — `QUALIFIED_DESCRIPTIVE_RESULTS`. Это описательные результаты, не QA verdict и не статистическое доказательство превосходства.

`promotionEligible` — только предварительный фильтр: полный installed-host run, минимум три повтора, улучшение и отсутствие обнаруженной регрессии, не identity-control. Окончательное решение также требует проверки выбранного сочетания блоков на точных итоговых bytes, затронутых consumers и общих отрицательных случаях. Отдельные успехи вариантов не доказывают совместимость сочетания. Tie и отрицательный результат допустимы: сохраните baseline и причину решения.

Не вводится общий произвольный quality score. Tokens/cost/elapsed публикуются только при сопоставимой telemetry. Visual rubric проверяет соблюдение требований и различимость вариантов; субъективная красота и скорость пользователя не измерены.

## Проверки и текущий статус

`scripts/superpowers-skill-eval.test.mjs` проверяет подготовку, точные входы, metadata, collector closure, доступ к каталогам, drift, неизменяемые receipts, неполные данные и парные регрессии. `scripts/superpowers-skill-observations.test.mjs` проверяет порядок загрузки и evidence действий. `scripts/superpowers-reproduction-examples.test.mjs` исполняет original/reduced сценарии, неправильные и правильные решения и точный опубликованный пример ограничения trials.

Реальный [пилот из 78 попыток](superpowers-skill-evaluation-pilot.md) завершён как калибровка. Его исходные receipts сохранены; runtime drift, изменения нормализатора и неоднозначности условий исключают вывод об улучшении. Итоговая QA-проверка остаётся у `aif-verify`.

После пилота исправлены response-format precedence, видимый write scope и условный второй ход `explore-to-plan` (теперь это обязательный аудит плана). Набор из 39 cases и 9 вариантов сохранён. Расширения observations для промежуточных claims и terminal failure действуют только в новом frozen collector. Исходные оценки пилота не менялись. Повторный запуск использовал закреплённый снимок SDK и зависимостей, одинаковый увеличенный лимит и ограниченную диагностику ошибок. Synthetic review fixtures по-прежнему не доказывают совместимость с отсутствующей upstream-схемой gate.

[Повторное измерение v6](superpowers-skill-evaluation-results.md) содержит 234 новые завершённые попытки, по три повтора каждого baseline/current слота, без операционных ошибок. Матрица и настройки зарегистрированы до запуска. Полный снимок Pi SDK 0.85.1 и зависимостей совпал до и после запуска. Все 234 receipts пригодны для классификации: исходно 92 pass / 142 fail, после отдельной коррекции измерителя — 94 pass / 140 fail. Это описательные исходы отдельных заданий, без общего quality score или доказанного улучшения.

CAL13: перенаправление чтения в PowerShell `$null` ошибочно считалось файловым действием. Отдельный единообразный аудит всех журналов затронул классификацию пяти наблюдений, метрики четырёх и pass/fail двух. Исправленный анализ сохраняет исходные receipts, инструкции, проверки и смысловые оценки, не добавляет вызовов модели и явно обозначен как post-registration. Его статус — `QUALIFIED_POST_REGISTRATION_DESCRIPTIVE_RESULTS`; исходная оценка измерителя остаётся отдельной. Три уточнения родительских смысловых оценок сохранены с оригинальными версиями и хешами.

Предыдущий запуск v5 остаётся отдельной историей: 129 завершённых ответов, 105 ошибок, включая 102 rate-limit, и отдельный CAL12 replay. Его полный JSON и неизменённый текст отчёта сохранены в [результатах](superpowers-skill-evaluation-results.json); попытки v5 не подставлялись в v6. Пилот и историческая серия #164 также не переписаны.

Synthetic catalog не квалифицирует installed discovery или отсутствующую upstream-схему review gate. Baseline source closure подхватывает `skills/shared/**/*.md` и относительные markdown-ссылки, но не замыкает автоматически same-skill `references/` (например, `skills/aif-mode/references/` или `skills/aif-analyze/references/`); same-skill references включаются только при явном перечислении в `sourcePaths`. Родительская оценка незаслеплённая; другие модели, Linux, пользовательское UX, скорость и стоимость не квалифицированы. Task 15 принят; решения Task 16, карта consumers/cases и точные хеши итоговых инструкций записаны в результатах. Независимый review и итоговый `aif-verify` оформляются существующим workflow плана, отдельно от экспериментальной квалификации.

## See Also

- [Адаптация идей Superpowers](superpowers-adaptation.md) — происхождение, consumers и владельцы lifecycle.
- [Историческая оценка #164](skill-workflow-evaluation.md) — отдельная неизменяемая серия.
- [Workflow mechanics](workflow-mechanics.md) — выполнение задач и владение результатами.
