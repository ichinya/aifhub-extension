# Delta for honest outcomes

## ADDED Requirements

### Requirement: HonestNotRun

Система ОБЯЗАНА сообщать честный исход при отсутствии assessor, а не пустой успех.

#### Scenario: Честный исход

- GIVEN assessor отсутствует
- WHEN запускается движок
- THEN исход not_run
