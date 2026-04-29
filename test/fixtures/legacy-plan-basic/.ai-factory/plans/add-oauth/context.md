# Context

## Design

The OAuth callback should reuse the existing authentication middleware and session storage.
The callback should validate the provider state before exchanging the code.

## Implementation notes

Keep provider-specific code isolated behind a small adapter so another provider can be added later.
