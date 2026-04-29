# Delta for OAuth Authentication

## ADDED Requirements

### Requirement: OAuth sign in

The system MUST allow sign in through a GitHub OAuth callback.

#### Scenario: OAuth callback completes

- GIVEN a valid GitHub OAuth callback
- WHEN the callback is processed
- THEN the system creates an authenticated session.
