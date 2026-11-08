<?php
declare(strict_types=1);

// channels/announcer/src/ClaudeCliAiWriter.php
//
// Real AI writer adapter: shells out to the already-installed `claude`
// CLI (Claude Code), using the user's existing OAuth session -- no API
// key to provision or store. Confirmed by a real invocation against this
// exact flag combination (see channels/announcer/README.md for the
// captured example): `claude -p --output-format json --json-schema
// '<schema>' --restricted --model <model> "<prompt>"` prints ONE JSON
// object to stdout shaped like:
//
//   {"is_error": false, "subtype": "success", "result": "{\"announcement\":\"...\"}",
//    "structured_output": {"announcement": "..."}, ...lots of usage/cost metadata...}
//
// "structured_output" is already the parsed object matching our schema --
// preferred over re-decoding "result" (a JSON-encoded string duplicate of
// the same thing). "--restricted" strips the session down to no
// bash/file/edit tools at all (defense in depth: this call should never
// be able to touch the filesystem or run commands, only write text).
//
// On ANY problem -- binary missing, non-zero exit, timeout, malformed
// output, is_error true, or a response that blows well past the word
// budget -- this returns an $error and AnnouncerPipeline falls through
// to TemplateAiWriter (spec section 3: "Support a deterministic
// template-based fallback when the AI provider is unavailable."). This
// class never throws for an external-process failure; it only throws if
// handed invalid configuration (an empty binary name), a programmer error.

final class ClaudeCliAiWriter implements AiWriterInterface
{
    public function __construct(
        private string $bin = 'claude',
        private string $model = 'sonnet',
        private int $timeoutSeconds = 25,
    ) {
        if ($this->bin === '') {
            throw new InvalidArgumentException('ClaudeCliAiWriter: $bin must not be empty.');
        }
    }

    public function write(array $context, array $styleConfig): array
    {
        $built = WriterPromptBuilder::build($context, $styleConfig);
        $schemaJson = (string) json_encode($built['schema'], JSON_UNESCAPED_SLASHES);

        $argv = [
            $this->bin, '-p',
            '--output-format', 'json',
            '--json-schema', $schemaJson,
            '--restricted',
            '--model', $this->model,
            $built['prompt'],
        ];

        $run = $this->runWithTimeout($argv, $this->timeoutSeconds);
        if ($run['error'] !== null) {
            return $this->fail($run['error']);
        }

        $decoded = json_decode($run['stdout'], true);
        if (!is_array($decoded)) {
            return $this->fail('claude CLI did not print a single valid JSON object on stdout.');
        }
        if (($decoded['is_error'] ?? true) !== false) {
            $msg = is_string($decoded['result'] ?? null) ? $decoded['result'] : 'unknown error';
            return $this->fail("claude CLI reported an error: $msg");
        }

        $structured = $decoded['structured_output'] ?? null;
        if (!is_array($structured)) {
            $resultStr = $decoded['result'] ?? null;
            $structured = is_string($resultStr) ? json_decode($resultStr, true) : null;
        }
        $text = is_array($structured) && is_string($structured['announcement'] ?? null) ? trim($structured['announcement']) : null;
        if ($text === null || $text === '') {
            return $this->fail('claude CLI response did not contain a valid "announcement" string.');
        }

        $hardCeiling = $built['wordBudget'] + 10;
        $wordCount = count(array_filter(preg_split('/\s+/', $text) ?: []));
        if ($wordCount > $hardCeiling * 2) {
            // Wildly over budget -- something went wrong (e.g. the model
            // ignored the schema/budget entirely); prefer the deterministic
            // fallback over narration that will blow well past the target
            // announcement duration.
            return $this->fail("claude CLI response was $wordCount words, far over the $hardCeiling-word ceiling.");
        }

        return [
            'text' => $text,
            'provider' => 'claude-cli',
            'model' => $this->model,
            'usedFallback' => false,
            'error' => null,
        ];
    }

    /** @return array{text:string, provider:string, model:?string, usedFallback:bool, error:string} */
    private function fail(string $error): array
    {
        return ['text' => '', 'provider' => 'claude-cli', 'model' => $this->model, 'usedFallback' => true, 'error' => $error];
    }

    /**
     * proc_open with an argv array (never a shell string -- same safety
     * posture as AdminSupport::admin_run_subprocess()), with a wall-clock
     * timeout that terminates the process rather than hanging the caller
     * forever on a stuck/slow CLI invocation.
     *
     * @param list<string> $argv
     * @return array{stdout:string, stderr:string, exitCode:?int, error:?string}
     */
    private function runWithTimeout(array $argv, int $timeoutSeconds): array
    {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        $process = @proc_open($argv, $descriptors, $pipes);
        if (!is_resource($process)) {
            return ['stdout' => '', 'stderr' => '', 'exitCode' => null, 'error' => "Failed to start \"{$argv[0]}\" -- is it installed and on PATH?"];
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $deadline = microtime(true) + $timeoutSeconds;
        $timedOut = false;
        // PHP gotcha: once proc_get_status() has observed "running" go false,
        // its own internal process handle is already reaped, so a LATER
        // proc_close() call reliably returns -1 instead of the real exit code
        // -- the exit code must be taken from THIS proc_get_status() call, not
        // from proc_close()'s return value.
        $exitCode = null;

        while (true) {
            $status = proc_get_status($process);
            $stdout .= stream_get_contents($pipes[1]);
            $stderr .= stream_get_contents($pipes[2]);
            if (!$status['running']) {
                $exitCode = $status['exitcode'];
                break;
            }
            if (microtime(true) >= $deadline) {
                $timedOut = true;
                proc_terminate($process, 15);
                usleep(200_000);
                proc_terminate($process, 9);
                break;
            }
            usleep(50_000);
        }

        $stdout .= stream_get_contents($pipes[1]);
        $stderr .= stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $closeExitCode = proc_close($process);
        if ($exitCode === null) {
            $exitCode = $closeExitCode; // timed-out/terminated path: proc_close()'s value is the real one here
        }

        if ($timedOut) {
            return ['stdout' => $stdout, 'stderr' => $stderr, 'exitCode' => $exitCode, 'error' => "claude CLI timed out after {$timeoutSeconds}s."];
        }
        if ($exitCode !== 0) {
            return ['stdout' => $stdout, 'stderr' => $stderr, 'exitCode' => $exitCode, 'error' => "claude CLI exited $exitCode: " . trim($stderr)];
        }
        return ['stdout' => $stdout, 'stderr' => $stderr, 'exitCode' => $exitCode, 'error' => null];
    }
}
