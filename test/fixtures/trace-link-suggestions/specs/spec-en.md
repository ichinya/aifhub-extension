# Delta for auth

## ADDED Requirements

### Requirement: AuthOptIn

The system MUST gate the auth adapter behind an explicit opt-in switch.

#### Scenario: AuthLoginHappy

- GIVEN a valid user
- WHEN the adapter is called
- THEN a token is returned

#### Scenario: AuthLoginDenied

- GIVEN a denied user
- WHEN the adapter is called
- THEN an error is returned

### Requirement: Partial Coverage Rule

Requirements without trace links stay outside the graph; a partial scan never reports none.

### Requirement: TopicOnly

The topic-only rule MUST stay at related level without behavioral anchors.
