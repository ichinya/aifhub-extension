## ADDED Requirements

### Requirement: Provider composition
The workflow MUST include configured validation evidence before finalization.

#### Scenario: HLV and OpenSpec are enabled
- WHEN native project gates and required HLV validation pass
- THEN provider readiness permits finalization of the OpenSpec change.
