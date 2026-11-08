<?php
declare(strict_types=1);

// channels/announcer/src/ContentHash.php
//
// Stable content hashing for the two independent caches (spec section 6):
// a SCRIPT hash (does the writing need to happen again?) and an AUDIO
// hash (does the synthesis need to happen again?). Both are plain
// sha256 of a canonical (sorted-key) JSON encoding of exactly the inputs
// that should invalidate that cache -- nothing more, nothing less, so
// e.g. changing a channel's voice touches the audio hash only, never the
// script hash, and vice versa.

final class ContentHash
{
    public static function scriptHash(array $inputs): string
    {
        return self::hash($inputs);
    }

    public static function audioHash(array $inputs): string
    {
        return self::hash($inputs);
    }

    private static function hash(array $inputs): string
    {
        return hash('sha256', self::canonicalJson($inputs));
    }

    /** Deterministic regardless of key insertion order, at any nesting depth. */
    public static function canonicalJson(mixed $value): string
    {
        if (is_array($value)) {
            if (array_is_list($value)) {
                $parts = array_map(self::canonicalJson(...), $value);
                return '[' . implode(',', $parts) . ']';
            }
            ksort($value);
            $parts = [];
            foreach ($value as $k => $v) {
                $parts[] = json_encode((string) $k) . ':' . self::canonicalJson($v);
            }
            return '{' . implode(',', $parts) . '}';
        }
        return (string) json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }
}
