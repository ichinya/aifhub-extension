package main

import "testing"

func TestPonytailABSafeDecryptRejectsInvalidCiphertextUniformly(t *testing.T) {
	const key = "correct-key"
	valid, err := Encrypt("benchmark payload", key, "safe")
	if err != nil {
		t.Fatalf("Encrypt failed: %v", err)
	}
	raw, err := decodeShellSafe(valid)
	if err != nil {
		t.Fatalf("decode valid ciphertext: %v", err)
	}

	tampered := append([]byte(nil), raw...)
	tampered[len(tampered)-1] ^= 0x01
	missingTag := append([]byte(nil), raw[:8+12]...)

	tests := []struct {
		name       string
		ciphertext string
		key        string
	}{
		{name: "malformed encoding", ciphertext: "%", key: key},
		{name: "short salt", ciphertext: encodeShellSafe([]byte("short")), key: key},
		{name: "missing authentication tag", ciphertext: encodeShellSafe(missingTag), key: key},
		{name: "wrong key", ciphertext: valid, key: "wrong-key"},
		{name: "tampered tag", ciphertext: encodeShellSafe(tampered), key: key},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("Decrypt panicked: %v", recovered)
				}
			}()
			_, err := Decrypt(test.ciphertext, test.key, "safe")
			if err == nil {
				t.Fatal("Decrypt unexpectedly succeeded")
			}
			if err.Error() != "invalid ciphertext" {
				t.Fatalf("error = %q, want %q", err.Error(), "invalid ciphertext")
			}
		})
	}

	plaintext, err := Decrypt(valid, key, "safe")
	if err != nil {
		t.Fatalf("valid Decrypt failed: %v", err)
	}
	if plaintext != "benchmark payload" {
		t.Fatalf("plaintext = %q, want %q", plaintext, "benchmark payload")
	}
}
