# Delta for OAuth Authentication

## ADDED Requirements

### Requirement: OAuth sign in

The system MUST allow a user with a valid GitHub OAuth callback to sign in.

#### Scenario: GitHub OAuth callback succeeds

- GIVEN a user completes GitHub OAuth authorization
- WHEN GitHub redirects back with a valid callback
- THEN the system signs in the user.
