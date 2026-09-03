## Context
`Decrypt` in `go/encrypt.go` implements shell and safe modes. The safe mode uses AES-GCM with PBKDF2 key derivation; the authentication tag must gate every decryption result.

## Goals
- Uniform rejection error `invalid ciphertext` for every unauthenticated or malformed input shape.
- No silent fallbacks around `gcm.Open`.

## Non-Goals
- Changing encryption parameters, PBKDF2 cost, or the shell mode.
