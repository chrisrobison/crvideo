#!/usr/bin/env php
<?php
declare(strict_types=1);

// channels/finder/tests/run-tests.php
//
// Same tiny plain-PHP runner as channels/publish/tests (no PHPUnit, no
// Composer): runs every public test* method of every *Test.php class here.
//
// Usage: php channels/finder/tests/run-tests.php [optional-filter-substring]

require __DIR__ . '/../src/FinderBuilder.php';

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
            throw new AssertionFailed(($message !== '' ? $message : 'Values differ')
                . ': expected ' . var_export($expected, true) . ' got ' . var_export($actual, true));
        }
    }

    public static function null(mixed $v, string $message = 'Expected null'): void
    {
        if ($v !== null) {
            throw new AssertionFailed($message . ' got ' . var_export($v, true));
        }
    }
}

function run_tests(string $dir, ?string $filter = null): int
{
    $files = glob($dir . '/*Test.php') ?: [];
    sort($files);
    $pass = $fail = 0;
    foreach ($files as $file) {
        require_once $file;
        $class = basename($file, '.php');
        $instance = new $class();
        foreach (get_class_methods($instance) as $method) {
            $label = "$class::$method";
            if (!str_starts_with($method, 'test') || ($filter !== null && !str_contains($label, $filter))) {
                continue;
            }
            try {
                method_exists($instance, 'setUp') && $instance->setUp();
                $instance->$method();
                echo "PASS  $label\n";
                $pass++;
            } catch (Throwable $e) {
                echo "FAIL  $label\n      " . get_class($e) . ': ' . $e->getMessage() . "\n";
                $fail++;
            } finally {
                method_exists($instance, 'tearDown') && $instance->tearDown();
            }
        }
    }
    echo "\n" . ($pass + $fail) . " tests, $pass passed, $fail failed.\n";
    return $fail === 0 ? 0 : 1;
}

if (PHP_SAPI === 'cli' && realpath($argv[0] ?? '') === __FILE__) {
    exit(run_tests(__DIR__, $argv[1] ?? null));
}
