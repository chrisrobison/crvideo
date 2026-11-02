<?php
declare(strict_types=1);

// youtube-import/src/YouTubeApiException.php
//
// Thrown for any non-recoverable YouTube Data API v3 problem. $kind lets
// callers (the CLI, tests) tell apart the cases the spec calls out
// explicitly -- invalid credentials and quota exhaustion -- from a generic
// network/API failure, without parsing the message text.

final class YouTubeApiException extends RuntimeException
{
    public const KIND_INVALID_KEY = 'invalid_key';
    public const KIND_QUOTA_EXCEEDED = 'quota_exceeded';
    public const KIND_NOT_FOUND = 'not_found';
    public const KIND_NETWORK = 'network';
    public const KIND_API = 'api';

    public function __construct(public readonly string $kind, string $message)
    {
        parent::__construct($message);
    }
}
