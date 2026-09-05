## ADDED Requirements
### Requirement: Exact scale-aware rendering
Price SHALL render its integer-backed value exactly at the decimal scale implied by the configured precision (precision 1 maps to 0 decimals, 10 to 1, 100 to 2, 1000 to 3), using integer arithmetic only, with space as the thousands separator and comma as the decimal separator.

#### Scenario: Value beyond IEEE-754 precision
- **WHEN** a price is created with value 9007199254740993 and precision 100
- **THEN** the rendered numeric part is `90 071 992 547 409,93`

#### Scenario: Maximum integer value
- **WHEN** a price is created with value PHP_INT_MAX and precision 100
- **THEN** the rendered numeric part is `92 233 720 368 547 758,07`

#### Scenario: Integer scale rendering
- **WHEN** a price is created with value 12345 and precision 1
- **THEN** the rendered numeric part is `12 345`

#### Scenario: Sub-unit scale rendering
- **WHEN** a price is created with value 12345 and precision 1000
- **THEN** the rendered numeric part is `12,345`

### Requirement: Precision validation
Price SHALL reject precision values that are not positive powers of ten.

#### Scenario: Invalid precision rejected
- **WHEN** a price is created with precision 0, -1, or 20
- **THEN** construction fails with `Precision must be a positive power of ten`
