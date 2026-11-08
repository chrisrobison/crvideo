<?php
declare(strict_types=1);

// channels/announcer/tests/TestFixtures.php
//
// Shared fixture builder for the announcer test suite: a small, synthetic
// channel tree (meta.json/programming.json/schedule.json/announcer.json)
// plus a series/ tree, shaped exactly like the REAL compiled output
// (confirmed against channels/science/schedule.json -- see
// AnnouncementContextBuilder.php's header) but small enough to read at a
// glance. Never touches the real channels/ or series/ directories --
// every test builds its own temp root and deletes it in tearDown().
//
// Layout produced by build():
//   <root>/channels/test-channel/{meta,programming,schedule,announcer}.json
//   <root>/series/series-a/series.json
//   <root>/series/series-b/series.json
//
// Timeline (all seconds relative to the published window's own start,
// exactly like the real schedule.json's blocks[0].items[].start):
//   ep-1  [0,100)     block-a@0      series-a "Show A"
//   cont-1 [100,110)  -> ep-2 (block-b@110, series-b "Show B")
//   ep-2  [110,210)   block-b@110    series-b "Show B"
//   cont-2 [210,220)  -> ep-3 (block-a@220, series-a "Show A")
//   ep-3  [220,320)   block-a@220    series-a "Show A"
//   cont-3 [320,330)  -> ep-4 (block-a@330, series-a "Show A") -- SAME series as outgoing
//   ep-4  [330,430)   block-a@330    series-a "Show A"
//   cont-4 [430,440)  -> nothing known (no next_program_id, no program_id) -- dead air

final class TestFixtures
{
    public static function build(): string
    {
        $root = sys_get_temp_dir() . '/crvideo-announcer-test-' . bin2hex(random_bytes(6));
        $channelDir = "$root/channels/test-channel";
        $seriesRoot = "$root/series";
        mkdir($channelDir, 0775, true);
        mkdir("$seriesRoot/series-a", 0775, true);
        mkdir("$seriesRoot/series-b", 0775, true);

        file_put_contents("$channelDir/meta.json", json_encode([
            'name' => 'Test Channel',
            'description' => 'A channel for testing.',
        ]));

        file_put_contents("$channelDir/programming.json", json_encode([
            'blocks' => [
                ['id' => 'block-a', 'recurrence' => ['timezone' => 'UTC']],
                ['id' => 'block-b', 'recurrence' => ['timezone' => 'UTC']],
            ],
        ]));

        file_put_contents("$channelDir/announcer.json", json_encode([
            'enabled' => true,
            'voice' => 'af_heart',
            'speed' => 1.0,
            'language' => 'en-us',
            'targetDuration' => 10,
            'types' => ['coming_up_next', 'channel_id'],
            'writer' => ['provider' => 'mock'],
            'tts' => ['provider' => 'mock'],
            'lookaheadHours' => 24 * 365 * 10, // effectively unbounded for tests
        ]));

        $schedule = [
            '_publish' => ['window' => ['start' => '2026-01-01T00:00:00+00:00']],
            'blocks' => [[
                'items' => [
                    ['type' => 'video', 'id' => 'ep-1', 'start' => 0, 'duration' => 100, 'title' => 'Ep1 raw video title', 'program_id' => 'block-a@0'],
                    ['type' => 'continuity', 'id' => 'cont-1', 'start' => 100, 'duration' => 10, 'template' => 'x', 'next_program_id' => 'ep-2', 'program_id' => 'block-b@110'],
                    ['type' => 'video', 'id' => 'ep-2', 'start' => 110, 'duration' => 100, 'title' => 'Ep2 raw video title', 'program_id' => 'block-b@110'],
                    ['type' => 'continuity', 'id' => 'cont-2', 'start' => 210, 'duration' => 10, 'template' => 'x', 'next_program_id' => 'ep-3', 'program_id' => 'block-a@220'],
                    ['type' => 'video', 'id' => 'ep-3', 'start' => 220, 'duration' => 100, 'title' => 'Ep3 raw video title', 'program_id' => 'block-a@220'],
                    ['type' => 'continuity', 'id' => 'cont-3', 'start' => 320, 'duration' => 10, 'template' => 'x', 'next_program_id' => 'ep-4', 'program_id' => 'block-a@330'],
                    ['type' => 'video', 'id' => 'ep-4', 'start' => 330, 'duration' => 100, 'title' => 'Ep4 raw video title', 'program_id' => 'block-a@330'],
                    ['type' => 'continuity', 'id' => 'cont-4', 'start' => 430, 'duration' => 10, 'template' => 'x', 'next_program_id' => null],
                ],
            ]],
            'programs' => [
                ['occurrence_id' => 'block-a@0', 'block_id' => 'block-a', 'title' => 'Show A', 'description' => 'Desc A', 'series_id' => 'series-a', 'series_title' => 'Show A', 'start' => 0, 'end' => 100],
                ['occurrence_id' => 'block-b@110', 'block_id' => 'block-b', 'title' => 'Show B', 'description' => 'Desc B', 'series_id' => 'series-b', 'series_title' => 'Show B', 'start' => 110, 'end' => 210],
                ['occurrence_id' => 'block-a@220', 'block_id' => 'block-a', 'title' => 'Show A', 'description' => 'Desc A', 'series_id' => 'series-a', 'series_title' => 'Show A', 'start' => 220, 'end' => 320],
                ['occurrence_id' => 'block-a@330', 'block_id' => 'block-a', 'title' => 'Show A', 'description' => 'Desc A', 'series_id' => 'series-a', 'series_title' => 'Show A', 'start' => 330, 'end' => 430],
            ],
        ];
        file_put_contents("$channelDir/schedule.json", json_encode($schedule));

        file_put_contents("$seriesRoot/series-a/series.json", json_encode([
            'id' => 'series-a', 'title' => 'Show A', 'description' => 'A show about things.',
            'episodes' => [
                ['id' => 'ep-1', 'title' => 'Ep1 raw video title', 'description' => 'Episode one description.', 'episode_number' => 1],
                ['id' => 'ep-3', 'title' => 'Ep3 raw video title', 'description' => 'Episode three description.', 'episode_number' => 3],
                ['id' => 'ep-4', 'title' => 'Ep4 raw video title', 'description' => 'Episode four description.', 'episode_number' => 4],
            ],
        ]));
        file_put_contents("$seriesRoot/series-b/series.json", json_encode([
            'id' => 'series-b', 'title' => 'Show B', 'description' => 'A show about other things.',
            'episodes' => [
                ['id' => 'ep-2', 'title' => 'Ep2 raw video title', 'description' => 'Episode two description.', 'episode_number' => 2],
            ],
        ]));

        return $root;
    }

    public static function destroy(string $root): void
    {
        self::rmrf($root);
    }

    private static function rmrf(string $path): void
    {
        if (!file_exists($path)) {
            return;
        }
        if (is_dir($path) && !is_link($path)) {
            foreach (scandir($path) ?: [] as $entry) {
                if ($entry === '.' || $entry === '..') {
                    continue;
                }
                self::rmrf("$path/$entry");
            }
            rmdir($path);
        } else {
            unlink($path);
        }
    }
}
