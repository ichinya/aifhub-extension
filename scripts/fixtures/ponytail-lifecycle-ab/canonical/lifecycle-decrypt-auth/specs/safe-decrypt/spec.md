## ADDED Requirements
### Requirement: Uniform authenticated rejection
Safe-mode decryption SHALL reject malformed, truncated, unauthenticated, wrong-key, and tampered ciphertexts uniformly with the canonical error `invalid ciphertext`, and SHALL NOT silently accept a failed authentication tag.

#### Scenario: Tampered authentication tag
- **WHEN** a valid safe-mode ciphertext has its final byte flipped and is decrypted with the correct key
- **THEN** decryption fails with error `invalid ciphertext`

#### Scenario: Wrong key
- **WHEN** a valid safe-mode ciphertext is decrypted with a different key
- **THEN** decryption fails with error `invalid ciphertext`

#### Scenario: Truncated ciphertext
- **WHEN** the encrypted payload loses its authentication tag
- **THEN** decryption fails with error `invalid ciphertext`

### Requirement: Valid round trip preserved
Safe-mode encryption and decryption SHALL round trip the original plaintext when the correct key is used.

#### Scenario: Round trip
- **WHEN** a payload is encrypted and decrypted with the same key in safe mode
- **THEN** the decrypted plaintext equals the original payload
