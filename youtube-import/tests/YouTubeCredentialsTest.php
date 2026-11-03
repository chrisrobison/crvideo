<?php
declare(strict_types=1);

final class YouTubeCredentialsTest
{
    private string $dir;

    public function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/yt-import-creds-test-' . bin2hex(random_bytes(4));
        mkdir($this->dir, 0775, true);
        putenv('YOUTUBE_API_KEY'); // ensure a clean slate between tests
    }

    private function cleanup(): void
    {
        foreach (glob($this->dir . '/*') as $f) {
            unlink($f);
        }
        rmdir($this->dir);
        putenv('YOUTUBE_API_KEY');
    }

    public function testEnvironmentVariableTakesPrecedence(): void
    {
        putenv('YOUTUBE_API_KEY=from-env');
        $result = YouTubeCredentials::resolve($this->dir . '/does-not-exist.php');
        Assert::same('from-env', $result['apiKey']);
        Assert::null($result['error']);
        $this->cleanup();
    }

    public function testFallsBackToConfigFileWhenNoEnvVar(): void
    {
        $path = $this->dir . '/config.local.php';
        file_put_contents($path, "<?php\nreturn ['api_key' => 'from-config-file'];\n");
        $result = YouTubeCredentials::resolve($path);
        Assert::same('from-config-file', $result['apiKey']);
        $this->cleanup();
    }

    public function testMissingBothProducesActionableError(): void
    {
        $result = YouTubeCredentials::resolve($this->dir . '/does-not-exist.php');
        Assert::null($result['apiKey']);
        Assert::notNull($result['error']);
        Assert::true(str_contains($result['error'], 'YOUTUBE_API_KEY'));
        $this->cleanup();
    }

    public function testConfigFileWithoutApiKeyKeyIsRejected(): void
    {
        $path = $this->dir . '/config.local.php';
        file_put_contents($path, "<?php\nreturn ['not_the_right_key' => 'x'];\n");
        $result = YouTubeCredentials::resolve($path);
        Assert::null($result['apiKey']);
        Assert::notNull($result['error']);
        $this->cleanup();
    }
}
