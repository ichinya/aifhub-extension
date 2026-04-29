# Add OAuth Authentication

## Summary

Add OAuth sign-in for GitHub accounts so users can authenticate without a password.

## Scope

- Add a GitHub OAuth callback flow.
- Store the linked provider account on the existing user record.
- Keep password sign-in unchanged.

## Approach

Use the existing authentication middleware and add a provider callback handler.

## Requirements

- The system MUST allow a user with a valid GitHub OAuth callback to sign in.
- The system MUST reject an OAuth callback when the provider state does not match the session.
