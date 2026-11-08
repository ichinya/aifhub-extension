# Delta for byte pins

## ADDED Requirements

### Requirement: CrlfProbe

Смешанный CRLF-требование с кириллицей и многобайтовыми смещениями.

#### Scenario: Кириллический CRLF

- GIVEN CRLF-файл
- WHEN считываются байты
- THEN смещения точны
