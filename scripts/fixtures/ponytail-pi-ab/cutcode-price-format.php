<?php

declare(strict_types=1);

$projectRoot = $argv[1] ?? null;
if (!is_string($projectRoot) || $projectRoot === '') {
    throw new RuntimeException('project root argument is required');
}

$projectRoot = realpath($projectRoot);
if ($projectRoot === false) {
    throw new RuntimeException('project root does not exist');
}

$makeablePath = $projectRoot . '/src/Support/Traits/Makeable.php';
$pricePath = $projectRoot . '/src/Support/ValueObjects/Price.php';
if (!is_file($makeablePath) || !is_file($pricePath)) {
    throw new RuntimeException('cutcode-shop Price sources are missing');
}

require_once $makeablePath;
require_once $pricePath;

if (PHP_INT_SIZE !== 8) {
    throw new RuntimeException('the pinned benchmark requires a 64-bit PHP runtime');
}

$cases = [
    [0, 100, '0,00'],
    [1, 100, '0,01'],
    [10000, 100, '100,00'],
    [9007199254740993, 100, '90 071 992 547 409,93'],
    [PHP_INT_MAX, 100, '92 233 720 368 547 758,07'],
    [12345, 1, '12 345'],
    [12345, 10, '1 234,5'],
    [12345, 1000, '12,345'],
];

foreach ($cases as [$raw, $precision, $numeric]) {
    $price = \Support\ValueObjects\Price::make($raw, 'RUB', $precision);
    $expected = $numeric . ' ' . $price->symbol();
    $actual = (string) $price;

    if ($actual !== $expected) {
        throw new RuntimeException(sprintf(
            'Price(%d, precision %d) rendered as %s; expected %s',
            $raw,
            $precision,
            var_export($actual, true),
            var_export($expected, true),
        ));
    }
    if ($price->raw() !== $raw || $price->currency() !== 'RUB') {
        throw new RuntimeException('formatting changed the stored price value or currency');
    }
}

if (\Support\ValueObjects\Price::make(10000)->value() != 100) {
    throw new RuntimeException('normal value() behavior changed');
}

foreach ([0, -1, 20] as $precision) {
    try {
        \Support\ValueObjects\Price::make(100, 'RUB', $precision);
        throw new RuntimeException("precision {$precision} was accepted");
    } catch (InvalidArgumentException $exception) {
        if ($exception->getMessage() !== 'Precision must be a positive power of ten') {
            throw new RuntimeException(sprintf(
                'precision %d returned %s; expected the canonical error',
                $precision,
                var_export($exception->getMessage(), true),
            ));
        }
    }
}

try {
    \Support\ValueObjects\Price::make(100, 'USD');
    throw new RuntimeException('unsupported currency was accepted');
} catch (InvalidArgumentException) {
    // Existing currency validation remains in force.
}

fwrite(STDOUT, "ponytail_pi_ab_hidden_grader=pass\n");
