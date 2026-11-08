<?php
declare(strict_types=1);

require_once __DIR__ . '/TestFixtures.php';

final class AudioMetadataTest
{
    private string $root;

    public function setUp(): void
    {
        $this->root = sys_get_temp_dir() . '/crvideo-audio-test-' . bin2hex(random_bytes(6));
        mkdir($this->root, 0775, true);
    }

    public function tearDown(): void
    {
        TestFixtures::destroy($this->root);
    }

    public function testMockProviderWritesAValidWavWithPlausibleDuration(): void
    {
        $tts = new MockTtsProvider();
        $wavPath = "{$this->root}/out.wav";
        // ~10 words at the mock's internal 2.5 words/sec -> ~4s.
        $result = $tts->synthesize('one two three four five six seven eight nine ten', 'af_heart', 1.0, 'en-us', $wavPath);
        Assert::null($result['error']);
        Assert::true(is_file($wavPath));
        Assert::true(filesize($wavPath) > 44); // more than just a WAV header
        Assert::true($result['durationSeconds'] > 3.0 && $result['durationSeconds'] < 5.0);
    }

    public function testMockProviderCanSimulateFailure(): void
    {
        $tts = new MockTtsProvider(shouldFail: true);
        $result = $tts->synthesize('hello', 'af_heart', 1.0, 'en-us', "{$this->root}/out.wav");
        Assert::notNull($result['error']);
        Assert::null($result['wavPath']);
    }

    public function testFullWavToMp3PipelineProducesAValidFileWithRealDuration(): void
    {
        $tts = new MockTtsProvider();
        $wavPath = "{$this->root}/out.wav";
        $synth = $tts->synthesize('this is a test announcement for the audio pipeline', 'af_heart', 1.0, 'en-us', $wavPath);
        Assert::null($synth['error']);

        $processor = new AudioProcessor();
        $mp3Path = "{$this->root}/out.mp3";
        $encoded = $processor->convertToMp3($wavPath, $mp3Path, ['bitrateKbps' => 64, 'loudnorm' => true]);

        Assert::null($encoded['error']);
        Assert::notNull($encoded['mp3Path']);
        Assert::true(is_file($mp3Path));
        Assert::true(filesize($mp3Path) > 0);
        Assert::true($encoded['durationSeconds'] > 0);
        // Re-probing independently must agree with what convertToMp3 reported.
        $reprobed = $processor->probeDuration($mp3Path);
        Assert::true(abs($reprobed - $encoded['durationSeconds']) < 0.5);
    }

    public function testNeverPublishesAPartialFileOnFfmpegFailure(): void
    {
        $processor = new AudioProcessor();
        $bogusWav = "{$this->root}/not-really-a-wav.wav";
        file_put_contents($bogusWav, 'this is not audio data');
        $mp3Path = "{$this->root}/should-not-exist.mp3";

        $encoded = $processor->convertToMp3($bogusWav, $mp3Path, []);
        Assert::notNull($encoded['error']);
        Assert::null($encoded['mp3Path']);
        Assert::false(is_file($mp3Path), 'no partial/invalid MP3 must ever be left at the destination path');
        Assert::false(is_file($mp3Path . '.part'), 'the temp file must be cleaned up on failure');
    }

    public function testEmptySourceIsRejectedBeforeShellingOut(): void
    {
        $processor = new AudioProcessor();
        $emptyWav = "{$this->root}/empty.wav";
        file_put_contents($emptyWav, '');
        $encoded = $processor->convertToMp3($emptyWav, "{$this->root}/out.mp3", []);
        Assert::notNull($encoded['error']);
    }
}
