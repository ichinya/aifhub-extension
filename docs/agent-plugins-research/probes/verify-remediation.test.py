"""Negative controls: python -X utf8 verify-remediation.test.py BUNDLE RESULTS_JSON."""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("verifier", Path(__file__).with_name("verify-remediation.py"))
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
if len(sys.argv) != 3:
    sys.exit("Usage: verify-remediation.test.py BUNDLE RESULTS_JSON")
source, results = map(lambda p: Path(p).resolve(), sys.argv[1:])


class EvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="aifhub-verifier-test-")
        self.addCleanup(self.scratch.cleanup)
        self.bundle = Path(self.scratch.name) / "bundle"
        shutil.copytree(source, self.bundle)

    def test_original_passes(self):
        self.assertEqual(verifier.verify(self.bundle, results)["inventory_hashes"], "PASS")

    def test_same_size_mutation_fails(self):
        file = self.bundle / "README.md"
        content = file.read_bytes()
        file.write_bytes(bytes([content[0] ^ 1]) + content[1:])
        with self.assertRaisesRegex(ValueError, "Hash mismatch"):
            verifier.verify(self.bundle, results)

    def test_extra_file_fails(self):
        (self.bundle / "unexpected.txt").write_text("extra", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "file set differs"):
            verifier.verify(self.bundle, results)

    def test_missing_file_fails(self):
        (self.bundle / "README.md").unlink()
        with self.assertRaisesRegex(ValueError, "file set differs"):
            verifier.verify(self.bundle, results)


unittest.main(argv=[sys.argv[0]])
