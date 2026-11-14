<?php
declare(strict_types=1);

final class FinderBuilderTest
{
    private string $root;

    public function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/finder-test-' . bin2hex(random_bytes(4));
        $this->write('channels/alpha/meta.json', ['number' => 2, 'name' => 'Alpha']);
        $this->write('channels/alpha/catalog.json', ['series' => [
            ['ref' => '../../series/one/series.json'],
            ['ref' => '../../series/none-approved/series.json'],
            ['ref' => '../../series/missing/series.json'],
            ['ref' => '../../../../etc/passwd'],
        ]]);
        $this->write('channels/beta/meta.json', ['number' => 1, 'name' => 'Beta']);
        $this->write('channels/beta/catalog.json', ['series' => [['ref' => '../../series/one/series.json']]]);
        $this->write('channels/hidden/meta.json', ['number' => 9, 'hidden' => true]);
        $this->write('channels/hidden/catalog.json', ['series' => [['ref' => '../../series/secret/series.json']]]);
        $this->write('series/one/series.json', [
            'id' => 'one', 'title' => 'Show  One', 'thumbnail_url' => 'javascript:alert(1)',
            'description' => "Great show about things.\n\nSubscribe on Patreon https://x.test",
            'episodes' => [
                ['id' => 'e2', 'episode_number' => 2, 'title' => 'Second', 'status' => 'approved', 'duration' => 600,
                 'description' => "Watch https://spam.test now\n\nThe real summary of this second episode is here.", 'rights' => ['status' => 'licensed', 'notes' => 'private']],
                ['id' => 'e1', 'episode_number' => 1, 'title' => 'First', 'status' => 'approved', 'thumbnail_url' => 'https://img.test/1.jpg'],
                ['id' => 'e3', 'episode_number' => 3, 'title' => 'Candidate', 'status' => 'candidate'],
                ['id' => 'e4', 'episode_number' => 4, 'title' => 'Restricted', 'status' => 'approved', 'rights' => ['status' => 'restricted']],
            ],
        ]);
        $this->write('series/none-approved/series.json', ['id' => 'none-approved', 'title' => 'Nope', 'episodes' => [['id' => 'x', 'status' => 'candidate']]]);
        $this->write('series/secret/series.json', ['id' => 'secret', 'title' => 'Secret', 'episodes' => [['id' => 's', 'status' => 'approved']]]);
    }

    public function tearDown(): void
    {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($this->root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) {
            $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
        }
        rmdir($this->root);
    }

    public function testIndexListsOnlyCarriedShowsWithApprovedEpisodes(): void
    {
        $shows = (new FinderBuilder($this->root))->index()['shows'];
        Assert::same(['one'], array_column($shows, 'id'), 'no-approved, missing, traversal and hidden-channel series are excluded');
        Assert::same(2, $shows[0]['episode_count'], 'candidate and rights-restricted episodes are not counted');
    }

    public function testChannelsFollowChannelNumberOrder(): void
    {
        $shows = (new FinderBuilder($this->root))->index()['shows'];
        Assert::same(['beta', 'alpha'], $shows[0]['channels']);
    }

    public function testShowExposesNoEditorialOrRightsFields(): void
    {
        $show = (new FinderBuilder($this->root))->show('one');
        Assert::true($show !== null);
        $json = json_encode($show);
        Assert::true(!str_contains($json, 'private') && !str_contains($json, '"rights"') && !str_contains($json, '"status"'));
        Assert::same(['e1', 'e2'], array_column($show['episodes'], 'id'), 'approved only, by episode number');
    }

    public function testUnsafeThumbnailSchemesAreDropped(): void
    {
        $b = new FinderBuilder($this->root);
        Assert::null($b->show('one')['thumbnail_url']);
        Assert::same('https://img.test/1.jpg', $b->show('one')['episodes'][0]['thumbnail_url']);
    }

    public function testUnknownBadOrHiddenOnlyShowIdsReturnNull(): void
    {
        $b = new FinderBuilder($this->root);
        Assert::null($b->show('nope'));
        Assert::null($b->show('../series/one'));
        Assert::null($b->show('secret'), 'only carried by a hidden channel');
        Assert::null($b->show('none-approved'));
    }

    public function testCleanTextSkipsBoilerplateAndStripsUrls(): void
    {
        Assert::same('The real summary of this second episode is here.',
            FinderBuilder::cleanText("Watch https://spam.test now\n\nThe real summary of this second episode is here.", 240));
        Assert::same('Great show about things.', FinderBuilder::cleanText("Great show about things.\n\nSubscribe on Patreon https://x.test", 280));
        Assert::same('', FinderBuilder::cleanText("https://only.a/link\n\n#tag #tag2", 100));
    }

    public function testCleanTextClipsAtAWordBoundary(): void
    {
        $out = FinderBuilder::cleanText(str_repeat('word ', 80), 50);
        Assert::true(mb_strlen($out) <= 51 && str_ends_with($out, '…') && !str_contains($out, 'wor…'));
    }

    private function write(string $rel, array $data): void
    {
        $path = $this->root . '/' . $rel;
        @mkdir(dirname($path), 0775, true);
        file_put_contents($path, json_encode($data));
    }
}
