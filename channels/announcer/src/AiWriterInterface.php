<?php
declare(strict_types=1);

// channels/announcer/src/AiWriterInterface.php
//
// Provider-independent interface for the announcement writing step
// (spec section 3). AnnouncerPipeline never talks to a specific AI
// service directly -- only to this interface -- so a different provider
// adapter can be swapped in without touching the pipeline, caching, or
// CLI code at all.

interface AiWriterInterface
{
    /**
     * @param array<string,mixed> $context     an AnnouncementContextBuilder record
     * @param array<string,mixed> $styleConfig the resolved announcer config (style/tone/targetDuration/...)
     * @return array{text:string, provider:string, model:?string, usedFallback:bool, error:?string}
     */
    public function write(array $context, array $styleConfig): array;
}
