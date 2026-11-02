<?php
declare(strict_types=1);

// youtube-import/src/YouTubeVideoClassifier.php
//
// Classifies one raw videos.list item (part=snippet,contentDetails,status,
// liveStreamingDetails) into the distinctions the spec calls for: an
// uploaded recording vs. an upcoming live stream vs. a currently-active
// live stream vs. a finished live stream's VOD, plus a best-effort Shorts
// guess. Also resolves its duration -- the one place this matters most:
// YouTube reports contentDetails.duration as "P0D" (0 seconds) for a live
// broadcast that hasn't ended, which is not a real zero-length video. This
// class is the single place that distinguishes "zero" from "unknown", so
// nothing downstream has to re-derive it.
//
// Pure function of the raw item; no network, no state.

final class YouTubeVideoClassifier
{
    public const KIND_UPLOAD = 'upload';
    public const KIND_SHORT = 'short';
    public const KIND_LIVE_UPCOMING = 'live_upcoming';
    public const KIND_LIVE_ACTIVE = 'live_active';
    public const KIND_LIVE_VOD = 'live_vod';

    /** A video this short (and not a live broadcast) is heuristically
     *  treated as a Short. The Data API exposes no authoritative "is a
     *  Short" field as of this writing; this is a documented heuristic,
     *  not a guarantee -- same spirit as ia-import's documented multi-part
     *  naming heuristic in MediaResolver. */
    private const SHORT_MAX_SECONDS = 60.0;

    /**
     * @param array<string,mixed> $item one videos.list item
     * @return array{
     *   kind: string,
     *   duration: ?float,
     *   duration_is_provisional: bool,
     *   published_at: ?string,
     *   privacy_status: ?string,
     *   embeddable: ?bool,
     *   made_for_kids: ?bool,
     *   availability_signal: string,
     *   availability_detail: ?string,
     * }
     */
    public static function classify(array $item): array
    {
        $snippet = $item['snippet'] ?? [];
        $status = $item['status'] ?? [];
        $contentDetails = $item['contentDetails'] ?? [];
        $live = $item['liveStreamingDetails'] ?? null;

        $broadcastContent = is_string($snippet['liveBroadcastContent'] ?? null) ? $snippet['liveBroadcastContent'] : 'none';
        $hasScheduledStart = is_array($live) && isset($live['scheduledStartTime']);
        $hasActualStart = is_array($live) && isset($live['actualStartTime']);
        $hasActualEnd = is_array($live) && isset($live['actualEndTime']);

        $parsedDuration = YouTubeIso8601Duration::parse($contentDetails['duration'] ?? null);
        $duration = $parsedDuration;
        $durationIsProvisional = false;
        $kind = self::KIND_UPLOAD;

        if ($broadcastContent === 'upcoming' || ($hasScheduledStart && !$hasActualStart)) {
            $kind = self::KIND_LIVE_UPCOMING;
            // Duration is meaningless before the stream starts; YouTube
            // typically reports "P0D" here -- never surface that as 0.
            $duration = null;
            $durationIsProvisional = true;
        } elseif ($broadcastContent === 'live' || ($hasActualStart && !$hasActualEnd)) {
            $kind = self::KIND_LIVE_ACTIVE;
            // Same reasoning while the stream is still running: whatever
            // contentDetails.duration says right now is not the final
            // length. Unknown, not zero.
            $duration = null;
            $durationIsProvisional = true;
        } elseif ($hasActualStart && $hasActualEnd) {
            $kind = self::KIND_LIVE_VOD;
            if ($duration === null || $duration <= 0.0) {
                // contentDetails.duration should be backfilled once a
                // stream ends, but as a documented fallback -- not a
                // fabrication -- derive it from the two real recorded
                // timestamps YouTube already gave us, rather than report
                // "unknown" when we can compute it exactly.
                $start = strtotime((string) $live['actualStartTime']);
                $end = strtotime((string) $live['actualEndTime']);
                if ($start !== false && $end !== false && $end > $start) {
                    $duration = (float) ($end - $start);
                    $durationIsProvisional = true; // derived, not API-reported
                }
            }
        } else {
            if ($duration !== null && $duration > 0.0 && $duration <= self::SHORT_MAX_SECONDS) {
                $kind = self::KIND_SHORT;
            }
        }

        [$availabilitySignal, $availabilityDetail] = self::availabilitySignal($status, $contentDetails);

        return [
            'kind' => $kind,
            'duration' => $duration,
            'duration_is_provisional' => $durationIsProvisional,
            'published_at' => is_string($snippet['publishedAt'] ?? null) ? $snippet['publishedAt'] : null,
            'privacy_status' => is_string($status['privacyStatus'] ?? null) ? $status['privacyStatus'] : null,
            'embeddable' => isset($status['embeddable']) ? (bool) $status['embeddable'] : null,
            'made_for_kids' => isset($status['madeForKids']) ? (bool) $status['madeForKids']
                : (isset($status['selfDeclaredMadeForKids']) ? (bool) $status['selfDeclaredMadeForKids'] : null),
            'availability_signal' => $availabilitySignal,
            'availability_detail' => $availabilityDetail,
        ];
    }

    /** @return array{0: string, 1: ?string} [available|restricted, detail] */
    private static function availabilitySignal(array $status, array $contentDetails): array
    {
        $uploadStatus = $status['uploadStatus'] ?? null;
        if ($uploadStatus === 'rejected') {
            return ['restricted', 'rejected' . (isset($status['rejectionReason']) ? ": {$status['rejectionReason']}" : '')];
        }
        if ($uploadStatus === 'failed') {
            return ['restricted', 'failed' . (isset($status['failureReason']) ? ": {$status['failureReason']}" : '')];
        }
        $region = $contentDetails['regionRestriction'] ?? null;
        if (is_array($region) && (!empty($region['blocked']) || !empty($region['allowed']))) {
            $kind = !empty($region['blocked']) ? 'blocked' : 'allowed-only';
            return ['restricted', "region restricted ($kind list present)"];
        }
        return ['available', null];
    }
}
