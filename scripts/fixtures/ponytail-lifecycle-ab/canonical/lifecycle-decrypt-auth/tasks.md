## 1. Implementation
- [ ] 1.1 Propagate the AES-GCM authentication failure as the canonical `invalid ciphertext` error; never discard the error result
- [ ] 1.2 Keep length checks for salt, nonce, and tag so truncated inputs fail before decryption
- [ ] 1.3 Preserve the valid round trip for correctly encrypted payloads

## 2. Verification
- [ ] 2.1 `go test ./...` rejects malformed, truncated, unauthenticated, wrong-key, and tampered ciphertexts uniformly
