# Verify Checklist: {{plan_id}}

> Used by aif-verify+ to check implementation

## Task Completeness

- [ ] Все пункты из task.md → Scope → In Scope выполнены
- [ ] Все Acceptance Criteria удовлетворены
- [ ] Нет незавершённых TODO в коде
- [ ] Нет пропущенных требований

## Rules Compliance

### Implementation Rules (из rules.md)
- [ ] Rule #1:
- [ ] Rule #2:

### Code Style
- [ ] Код следует проектным конвенциям
- [ ] Нет линтерных ошибок
- [ ] Нет явных code smells

### Testing Requirements
- [ ] Unit tests написаны
- [ ] Unit tests проходят
- [ ] Integration tests (если применимо)
- [ ] Edge cases покрыты

### Documentation
- [ ] Документация обновлена
- [ ] Комментарии в коде актуальны
- [ ] CHANGELOG обновлён (если применимо)

## Constraints Compliance

<!-- Для каждого constraints-*.md файла -->

### constraints-security.md (если есть)
- [ ] Security constraint #1:
- [ ] Security constraint #2:

### constraints-api.md (если есть)
- [ ] API compatibility maintained
- [ ] Breaking changes documented

## Code Quality

- [ ] Build проходит
- [ ] Tests проходят
- [ ] Lint проходит (0 errors)
- [ ] Нет unused imports
- [ ] Нет unused dependencies

## Architecture Consistency

- [ ] Файлы в правильных locations (per ARCHITECTURE.md)
- [ ] Dependency rules соблюдены
- [ ] Layer boundaries не нарушены

## Regressions

- [ ] Существующие тесты не сломаны
- [ ] Нет неожиданных побочных эффектов
- [ ] Производительность не ухудшена

## Integration

- [ ] Изменения совместимы с существующим API
- [ ] Зависимости корректно обновлены
- [ ] Конфигурационные файлы обновлены
- [ ] Новые env переменные задокументированы

---

## Findings (заполняется aif-verify+)

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| B001 | blocking | - | - |
| I001 | important | - | - |
| O001 | optional | - | - |

## Verdict

- [ ] **PASS** — Ready for aif-done
- [ ] **PASS with notes** — Can proceed, notes above
- [ ] **FAIL** — Requires aif-fix

### Notes

<!-- Дополнительные заметки по верификации -->
