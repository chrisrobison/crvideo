#!/usr/bin/env php
<?php
declare(strict_types=1);

// server/tests/run-tests.php
//
// Same tiny, self-contained plain-PHP test runner as ia-import's,
// youtube-import's, and channels/publish's (no PHPUnit, no Composer).
// Discovers every *Test.php file in this directory, instantiates its
// class, and calls every public method starting with "test".
//
// Usage: php server/tests/run-tests.php [optional-filter-substring]
//
// Requires the admin endpoint files directly (PHP_SAPI is "cli" here, so
// their HTTP-dispatch blocks never run -- only the testable functions
// they define get loaded).

require __DIR__ . '/../series-admin.php';
require __DIR__ . '/../channel-admin.php';

final class AssertionFailed extends Exception
{
}

final class Assert
{
    public static function true(bool $cond, string $message = 'Expected true'): void
    {
        if (!$cond) {
            throw new AssertionFailed($message);
        }
    }

    public static function same(mixed $expected, mixed $actual, string $message = ''): void
    {
        if ($expected !== $actual) {
            $msg = $message !== '' ? $message : 'Values differ';
            throw new AssertionFailed(
                $msg . ': expected ' . var_export($expected, true) . ' got ' . var_export($actual, true)
            );
        }
    }

    public static function null(mixed $v, string $message = 'Expected null'): void
    {
        if ($v !== null) {
            throw new AssertionFailed($message . ' got ' . var_export($v, true));
        }
    }

    public static function notNull(mixed $v, string $message = 'Expected non-null'): void
    {
        if ($v === null) {
            throw new AssertionFailed($message);
        }
    }

    public static function count(int $expected, array $arr, string $message = ''): void
    {
        if (count($arr) !== $expected) {
            throw new AssertionFailed(
                ($message !== '' ? $message . ': ' : '') . "expected count $expected got " . count($arr)
            );
        }
    }

    public static function contains(mixed $needle, array $haystack, string $message = ''): void
    {
        if (!in_array($needle, $haystack, true)) {
            throw new AssertionFailed(($message !== '' ? $message . ': ' : '') . 'value not found in array');
        }
    }

    public static function throws(string $expectedClass, callable $fn, string $message = ''): void
    {
        try {
            $fn();
        } catch (Throwable $e) {
            if ($e instanceof $expectedClass) {
                return;
            }
            throw new AssertionFailed(
                ($message !== '' ? $message . ': ' : '') . "expected $expectedClass, got " . get_class($e) . ': ' . $e->getMessage()
            );
        }
        throw new AssertionFailed(($message !== '' ? $message . ': ' : '') . "expected $expectedClass to be thrown, nothing was");
    }
}

function run_tests(string $dir, ?string $filter = null): int
{
    $files = glob($dir . '/*Test.php');
    sort($files);

    $pass = 0;
    $fail = 0;
    $failures = [];

    foreach ($files as $file) {
        require_once $file;
        $class = basename($file, '.php');
        if (!class_exists($class)) {
            continue;
        }
        $instance = new $class();
        $methods = get_class_methods($instance);
        foreach ($methods as $method) {
            if (!str_starts_with($method, 'test')) {
                continue;
            }
            $label = "$class::$method";
            if ($filter !== null && !str_contains($label, $filter)) {
                continue;
            }
            try {
                if (method_exists($instance, 'setUp')) {
                    $instance->setUp();
                }
                $instance->$method();
                echo "PASS  $label\n";
                $pass++;
            } catch (Throwable $e) {
                echo "FAIL  $label\n";
                echo '      ' . get_class($e) . ': ' . $e->getMessage() . "\n";
                $fail++;
                $failures[] = $label;
            } finally {
                if (method_exists($instance, 'tearDown')) {
                    $instance->tearDown();
                }
            }
        }
    }

    echo "\n" . ($pass + $fail) . " tests, $pass passed, $fail failed.\n";
    if ($failures) {
        echo "Failed:\n";
        foreach ($failures as $f) {
            echo "  - $f\n";
        }
    }

    return $fail === 0 ? 0 : 1;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    $filter = $argv[1] ?? null;
    exit(run_tests(__DIR__, $filter));
}
