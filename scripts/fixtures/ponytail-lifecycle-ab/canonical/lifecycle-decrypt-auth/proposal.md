## Original Request
Safe-mode decryption must reject every unauthenticated or malformed ciphertext uniformly and never silently accept a failed authentication tag.

## Why
`Decrypt(…, "safe")` uses AES-GCM, but any swallowed authentication error would accept tampered or wrong-key ciphertexts as empty plaintext, which breaks the trust boundary of stored passkeys.

## What Changes
- Reject malformed, truncated, unauthenticated, wrong-key, and tampered ciphertexts uniformly with the canonical error `invalid ciphertext`.
- Never ignore the AES-GCM authentication result.
- Preserve the valid round trip for correctly encrypted payloads.

## Capabilities
### New Capabilities
- safe-decrypt: uniform authenticated-decryption failure handling.

## Impact
- `go/encrypt.go`
