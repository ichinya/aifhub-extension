## 1. Implementation
- [ ] 1.1 Render the numeric part exactly at scale 0/1/2/3 for precision 1/10/100/1000 with integer arithmetic (no float conversion of the full value)
- [ ] 1.2 Reject precision values that are not positive powers of ten with the canonical error message
- [ ] 1.3 Keep `raw()`, `value()`, currency validation, and the Makeable constructor behavior unchanged

## 2. Verification
- [ ] 2.1 Check exact rendering for value 9007199254740993 at precision 100 and PHP_INT_MAX at precision 100
- [ ] 2.2 Check 12345 renders as `12 345`, `1 234,5`, and `12,345` for precision 1/10/1000
