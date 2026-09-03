## Original Request
Make price rendering exact for every supported precision, including values that do not fit IEEE-754 double precision.

## Why
Money rendering currently hard-codes two decimals and silently loses precision for large integer-backed values, which is unacceptable for a shop.

## What Changes
- Render `Support\ValueObjects\Price` exactly for precision 1, 10, 100, and 1000 using integer arithmetic only.
- Validate that precision is a positive power of ten.
- Preserve raw integer storage, currency validation, and `value()` behavior.

## Capabilities
### New Capabilities
- price-formatting: exact scale-aware price rendering.

## Impact
- `src/Support/ValueObjects/Price.php`
