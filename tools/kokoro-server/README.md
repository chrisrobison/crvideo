# kokoro-server

A small, self-contained Python HTTP microservice that wraps [Kokoro TTS](https://huggingface.co/hexgrad/Kokoro-82M)
via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (CPU-only, ONNX Runtime) for CRVideo's
"AI continuity announcer" feature. It is fully isolated from the rest of the PHP app: CRVideo's
`KokoroHttpTtsProvider` calls this service over plain HTTP, nothing more.

Everything here is stdlib Python plus `kokoro-onnx`/`onnxruntime` - no web framework.

## Contents

- `requirements.txt` - the two direct dependencies.
- `fetch-model.sh` - downloads the ONNX model + voices file into `models/`.
- `server.py` - the persistent HTTP service.
- `bench.py` - a CLI benchmark for inference speed on this hardware.
- `models/` - downloaded model files (git-ignored; large binaries, fetch them per-machine).

## 1. Install dependencies

A virtualenv was used (safer than `--user` on a shared machine, and just as easy to document):

```bash
cd tools/kokoro-server
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Confirm it imports and see which ONNX Runtime execution providers are available:

```bash
. .venv/bin/activate
python3 -c "import kokoro_onnx, onnxruntime; print(onnxruntime.get_available_providers())"
# -> ['AzureExecutionProvider', 'CPUExecutionProvider']
```

Only `CPUExecutionProvider` is ever actually used by `server.py`/`bench.py` (see "Execution provider"
below) - this machine has no GPU and the code pins CPU explicitly regardless of what's available.

## 2. Download the model

```bash
./fetch-model.sh
```

This downloads two files from the `kokoro-onnx` project's GitHub releases (verified current as of
2026-11-08, tag `model-files-v1.1`) into `models/`:

- Model: `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx`
  (fp32, ~326 MB) - the default.
- Voices: `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin`
  (~28 MB) - an npz archive of 54 named style vectors ("voices").

The script is idempotent (it checks exact expected file size and skips re-downloading complete
files) and writes `models/ACTIVE_MODEL`, a two-line marker (model filename, voices filename) that
`server.py`/`bench.py` read to find the right files without hardcoding a name.

**Quality/speed choice.** The project also publishes `fp16` and `int8` quantized exports. We
benchmarked both on this machine (an Intel Xeon E5-2680 v2 - AVX but **no AVX2/AVX-512 VNNI**) and
found **int8 was ~1.8x slower than fp32** here (RTF 2.67 vs. 1.45), because onnxruntime's CPU
execution provider has no fast integer GEMM path without AVX2/VNNI, so the quantize/dequantize
steps are pure overhead on this CPU. **fp32 is therefore the default.** On a modern CPU with
AVX2/AVX-512-VNNI (most anything from the last ~8 years) or on Apple Silicon, int8 is typically
*faster* and smaller - benchmark it yourself with `bench.py` before switching:

```bash
KOKORO_MODEL_QUALITY=int8 ./fetch-model.sh   # downloads the int8 variant alongside fp32
KOKORO_MODEL_PATH=models/kokoro-v1.0.int8.onnx python3 bench.py
```

If `fetch-model.sh` fails, it's almost always one of: no network egress to `github.com` /
`objects.githubusercontent.com`, or the upstream release asset having moved (unlikely but the
script checks exact byte size and will say so clearly rather than silently accepting a truncated
or wrong file).

## 3. Run the server

```bash
. .venv/bin/activate
python3 server.py
```

Defaults: binds `127.0.0.1:8178`, max concurrency 1 (serialized inference - sensible for a 2-core
CPU box), no auth, 30s synthesis timeout, CPU execution provider, onnxruntime's default thread
count.

### Configuration (env var, all optional)

| Env var | Default | Meaning |
|---|---|---|
| `KOKORO_HOST` | `127.0.0.1` | Bind address |
| `KOKORO_PORT` | `8178` | Bind port |
| `KOKORO_MAX_CONCURRENCY` | `1` | Max simultaneous synthesis jobs (serialized via a bounded thread pool). Keep at 1 on a 2-core box; CPU inference does not parallelize well across concurrent requests. |
| `KOKORO_NUM_THREADS` | onnxruntime default | `intra_op_num_threads` for ONNX Runtime (how many threads *one* inference call may use internally) |
| `KOKORO_MODEL_PATH` | from `models/ACTIVE_MODEL`, else `models/kokoro-v1.0.onnx` | Path to the `.onnx` model |
| `KOKORO_VOICES_PATH` | from `models/ACTIVE_MODEL`, else `models/voices-v1.0.bin` | Path to the voices file |
| `KOKORO_AUTH_TOKEN` | unset (no auth) | If set, `/synthesize` requires `Authorization: Bearer <token>`; `/health` and `/voices` are never gated |
| `KOKORO_SYNTH_TIMEOUT_SECONDS` | `30` | Per-request synthesis timeout |
| `KOKORO_MAX_TEXT_CHARS` | `2000` | Max characters accepted in `"text"` |
| `KOKORO_MAX_REQUEST_BYTES` | `65536` | Max request body size (rejected with 413 before reading past the limit) |

Every env var has an equivalent `--flag` on `server.py` (run `python3 server.py --help`).

Stop the server with `Ctrl-C` (SIGINT) or `kill -TERM <pid>` - both are handled gracefully: the
HTTP listener stops accepting new connections and the process exits cleanly once in-flight work is
done (verified: logs `Received signal 15, shutting down...` then `kokoro-server stopped.`).

### API

```
GET /health
  -> 200 {"status":"ok","voices_loaded":54,"model_version":"kokoro-v1.0.onnx",
          "execution_providers":["CPUExecutionProvider"]}

GET /voices
  -> 200 {"voices":["af_alloy","af_aoede", ... 54 total ...]}

POST /synthesize
  body: {"text": "...", "voice": "af_heart", "speed": 1.0, "lang": "en-us"}
  success -> 200, Content-Type: audio/wav, raw WAV bytes as the body, plus:
             X-Audio-Duration-Seconds: 9.6807
             X-Sample-Rate: 24000
  failure -> 4xx/5xx, Content-Type: application/json, {"error": "..."}
             (never a partial/corrupt WAV on failure)
```

`speed` must be between 0.5 and 2.0 (kokoro-onnx's own limit). `voice` must be one of the names
`/voices` returns. Unknown voice, empty/oversized text, bad JSON, wrong auth token, and synthesis
timeouts all return a clear JSON error with an appropriate status (400/401/404/411/413/500/504).

## 4. Benchmark

```bash
. .venv/bin/activate
python3 bench.py             # standalone: loads the model itself, measures pure inference
python3 bench.py --json      # same, machine-readable
python3 bench.py --http --url http://127.0.0.1:8178   # benchmark a server already running
```

`bench.py` synthesizes one representative ~27-word broadcast-announcer sentence ("Good evening,
and welcome back. Up next, a brand new episode featuring surprising twists, unforgettable
moments, and a finale you will not want to miss.") and reports generation time, audio duration,
real-time factor (`generation_seconds / audio_seconds` - **below 1.0 means faster than real
time**), peak RSS, CPU model, and the execution provider actually used.

**Standalone vs. `--http`:** standalone mode measures pure model inference with no HTTP/JSON
overhead - that's the number that answers "how fast is this CPU at TTS." `--http` measures the
same thing plus the thin stdlib HTTP wrapper, against a server you already started; use it to
sanity-check the deployed service matches the standalone number (on this machine they were
`14.1-14.5s` generation either way, confirming the HTTP layer adds negligible overhead).

### Actual numbers from this machine (verification run, 2026-11-08)

CPU: `Intel(R) Xeon(R) CPU E5-2680 v2 @ 2.80GHz`, 2 cores, no GPU, fp32 model, CPUExecutionProvider:

```
Generation time:      14.1 - 14.6 s
Audio duration:       9.68 - 9.70 s
Real-time factor:     ~1.46 - 1.50   (slower than real time by about 1.5x)
Peak memory (RSS):    ~815 - 830 MB  (standalone), ~20 MB (the bench client process itself, --http mode)
Model load time:      ~2.6 - 3.4 s   (one-time, at startup)
```

In practice: a ~10 second announcement takes ~14-15 seconds of CPU time to generate on this
hardware. That's workable for pre-generating announcer lines ahead of playback, but **not**
suitable for sub-second interactive latency on this particular CPU. A faster/newer CPU (modern
AVX2/AVX-512 Intel/AMD, or Apple Silicon) should do considerably better - re-run `bench.py` on the
target machine to get a real number before relying on it for anything latency-sensitive.

## 5. Deployment: local vs. remote

CRVideo's `KokoroHttpTtsProvider` always talks to this exact service over HTTP; only *where* it
runs changes between the two supported setups:

**(a) Local** - this script runs on the same machine as the PHP backend. Start it bound to
`127.0.0.1` (the default), point `KokoroHttpTtsProvider` at `http://127.0.0.1:8178`, and leave
`KOKORO_AUTH_TOKEN` unset (loopback traffic doesn't need bearer auth). CPU-only, as benchmarked
above.

**(b) Remote** - this same script runs as a persistent service on a separate machine (e.g. an
Apple Silicon Mac mini, which should give a meaningfully better real-time factor than this old
Xeon). On that machine:

```bash
KOKORO_HOST=0.0.0.0 KOKORO_PORT=8178 KOKORO_AUTH_TOKEN=<a long random shared secret> python3 server.py
```

Then point CRVideo's `KokoroHttpTtsProvider` config at `http://<that-machine>:8178`, with:

- a configurable request timeout (network round-trip + the measured generation time above, plus
  margin - e.g. at least 20-30s for a 10s clip on slow CPU hardware, less needed on faster boxes)
- the same `KOKORO_AUTH_TOKEN` value sent back as `Authorization: Bearer <token>` on every
  `/synthesize` call

If `KOKORO_AUTH_TOKEN` is unset on the server, no `Authorization` header is required at all (the
simple local case); if it *is* set, every `/synthesize` call must present it or gets a `401` -
`/health` and `/voices` are always open (no secret data there, and it's convenient for monitoring).
There's no TLS built into `server.py` itself; for a remote deployment over an untrusted network,
put it behind a reverse proxy (nginx, caddy, an SSH tunnel, a VPN, etc.) rather than exposing plain
HTTP to the internet, since the bearer token is otherwise sent in the clear.

Either way it's the same `server.py`, same model files, same API - only bind address, auth token,
and the PHP-side base URL change.

## Verification performed on this machine

- `./fetch-model.sh` run twice: first run downloaded both files and verified exact byte sizes;
  second run detected both as already complete and skipped (idempotency confirmed).
- `GET /health` and `GET /voices` returned sane JSON (54 voices, `CPUExecutionProvider`).
- `POST /synthesize` with a real sentence returned `200`, `Content-Type: audio/wav`, and
  `X-Audio-Duration-Seconds: 9.6807`; `ffprobe` independently confirmed the saved file is a valid
  `pcm_s16le`, 24000 Hz, mono WAV with `duration=9.680667` - matching the header almost exactly.
- Error paths checked individually: unknown voice -> 400 with the voice list in the message, empty
  text -> 400, out-of-range speed -> 400, unknown route -> 404, malformed JSON -> 400.
- Auth checked with `KOKORO_AUTH_TOKEN` set: no header -> 401, wrong token -> 401, correct
  `Authorization: Bearer <token>` -> 200.
- `bench.py` run both standalone and `--http` against a live server; numbers agreed closely (see
  table above).
- Clean shutdown checked by sending `SIGTERM` to the running process: it logged the signal, stopped
  accepting connections, and exited - no hang, no orphaned listener.

## Known caveats / things not covered here

- `kokoro-onnx`'s text-to-phoneme step uses `espeak-ng` under the hood via the `espeakng-loader` +
  `phonemizer` packages (bundled shared library + data, pulled in automatically by
  `pip install -r requirements.txt` - no system `espeak-ng` package needed on either machine).
- Only English voices/models were fetched (`kokoro-v1.0.onnx` / `voices-v1.0.bin`, 54 voices,
  `lang="en-us"` or `"en-gb"`). The same release also publishes a Chinese+English model
  (`kokoro-v1.1-zh.onnx` / `voices-v1.1-zh.bin`, 103 voices) - not needed for this feature, not
  downloaded, but the same `fetch-model.sh` pattern would apply if that changes.
- This was verified on one Linux x86_64 CPU only (the 2-core Xeon described above). Real-world
  real-time-factor on an Apple Silicon "remote" deployment is expected to be considerably better
  but was not measured here - run `bench.py` there once deployed.
- `server.py`'s synthesis timeout cannot forcibly kill a stuck CPU-bound inference thread (a
  limitation of Python's threading model); on timeout the *client* gets an immediate error, but
  the stuck worker still occupies one slot in the bounded thread pool until it eventually finishes.
  With `KOKORO_MAX_CONCURRENCY=1` this just means a single truly-hung request would stall the
  service until it finishes or the process is restarted - acceptable for this scale, worth knowing
  about.
