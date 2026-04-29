# Authentication

## Requirements

### Requirement: Existing sign in

The system MUST preserve existing sign in behavior.

#### Scenario: Password sign in succeeds

- GIVEN a valid existing account
- WHEN the user signs in with password credentials
- THEN the system authenticates the user.
