#!/usr/bin/env python3
"""
kokoro-server: a small, persistent HTTP microservice wrapping Kokoro TTS
(kokoro-onnx, CPU-only ONNX Runtime) for the CRVideo "AI continuity announcer"
feature.

The model is loaded exactly once at process startup and kept resident in
memory. Requests are served over plain HTTP using only the Python standard
library (http.server) - no web framework.

Endpoints:
    GET  /health      -> {"status":"ok","voices_loaded":N,"model_version":"...",
                           "execution_providers":[...]}
    GET  /voices       -> {"voices": ["af_heart", "am_adam", ...]}
    POST /synthesize   -> body: {"text": str, "voice": str, "speed": float,
                                   "lang": str}
                          success: HTTP 200, Content-Type: audio/wav, raw WAV
                          bytes in the body, plus X-Audio-Duration-Seconds and
                          X-Sample-Rate response headers.
                          failure: HTTP 4xx/5xx with a JSON {"error": "..."}
                          body. Never a partial/corrupt WAV.

Configuration (env var, with CLI flag override):
    KOKORO_HOST                 bind host              (default 127.0.0.1)
    KOKORO_PORT                 bind port               (default 8178)
    KOKORO_MAX_CONCURRENCY      max concurrent synth jobs (default 1)
    KOKORO_NUM_THREADS          onnxruntime intra-op thread count (default:
                                 all logical CPUs, capped by the OS)
    KOKORO_MODEL_PATH           path to the .onnx model (default: models/
                                 + the file recorded by fetch-model.sh)
    KOKORO_VOICES_PATH          path to the voices .bin file (same default
                                 mechanism as above)
    KOKORO_AUTH_TOKEN           if set, require
                                 "Authorization: Bearer <token>" on
                                 /synthesize (unset = no auth, for local use)
    KOKORO_SYNTH_TIMEOUT_SECONDS  per-request synthesis timeout (default 30)
    KOKORO_MAX_TEXT_CHARS        max characters accepted in "text" (default 2000)
    KOKORO_MAX_REQUEST_BYTES      max request body size (default 65536)

See README.md for full deployment notes (local vs. remote).
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import signal
import struct
import sys
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
MODELS_DIR = SCRIPT_DIR / "models"

# ---------------------------------------------------------------------------
# Logging: timestamped lines to stdout, stdlib logging module only.
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("KOKORO_LOG_LEVEL", "INFO"),
    format="%(asctime)s.%(msecs)03dZ [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
logging.Formatter.converter = time.gmtime  # UTC timestamps
log = logging.getLogger("kokoro-server")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def _default_model_paths() -> tuple[str, str]:
    """Resolve model/voices paths from the ACTIVE_MODEL marker fetch-model.sh
    writes, falling back to the fp32 model name if the marker is absent."""
    marker = MODELS_DIR / "ACTIVE_MODEL"
    if marker.exists():
        lines = [l.strip() for l in marker.read_text().splitlines() if l.strip()]
        if len(lines) >= 2:
            return str(MODELS_DIR / lines[0]), str(MODELS_DIR / lines[1])
    return str(MODELS_DIR / "kokoro-v1.0.onnx"), str(MODELS_DIR / "voices-v1.0.bin")


def build_config(argv: list[str] | None = None) -> argparse.Namespace:
    default_model, default_voices = _default_model_paths()

    parser = argparse.ArgumentParser(description="Kokoro TTS HTTP microservice")
    parser.add_argument(
        "--host", default=os.environ.get("KOKORO_HOST", "127.0.0.1")
    )
    parser.add_argument(
        "--port", type=int, default=int(os.environ.get("KOKORO_PORT", "8178"))
    )
    parser.add_argument(
        "--max-concurrency",
        type=int,
        default=int(os.environ.get("KOKORO_MAX_CONCURRENCY", "1")),
        help="Max concurrent synthesis jobs (default 1: serialize CPU inference)",
    )
    parser.add_argument(
        "--num-threads",
        type=int,
        default=int(os.environ.get("KOKORO_NUM_THREADS", "0")) or None,
        help="onnxruntime intra-op thread count (0/unset = onnxruntime default)",
    )
    parser.add_argument(
        "--model-path", default=os.environ.get("KOKORO_MODEL_PATH", default_model)
    )
    parser.add_argument(
        "--voices-path",
        default=os.environ.get("KOKORO_VOICES_PATH", default_voices),
    )
    parser.add_argument(
        "--auth-token", default=os.environ.get("KOKORO_AUTH_TOKEN") or None
    )
    parser.add_argument(
        "--synth-timeout-seconds",
        type=float,
        default=float(os.environ.get("KOKORO_SYNTH_TIMEOUT_SECONDS", "30")),
    )
    parser.add_argument(
        "--max-text-chars",
        type=int,
        default=int(os.environ.get("KOKORO_MAX_TEXT_CHARS", "2000")),
    )
    parser.add_argument(
        "--max-request-bytes",
        type=int,
        default=int(os.environ.get("KOKORO_MAX_REQUEST_BYTES", "65536")),
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# Model loading (once, at startup)
# ---------------------------------------------------------------------------


class TtsEngine:
    """Holds the single resident Kokoro model instance plus the synthesis
    concurrency gate. Thread-safe: synthesize() may be called from many
    request-handling threads, but only `max_concurrency` run inference at once."""

    def __init__(
        self,
        model_path: str,
        voices_path: str,
        num_threads: int | None,
        max_concurrency: int,
    ) -> None:
        import onnxruntime as rt
        from kokoro_onnx import Kokoro

        if not Path(model_path).is_file():
            raise FileNotFoundError(
                f"Model file not found: {model_path} (run fetch-model.sh first)"
            )
        if not Path(voices_path).is_file():
            raise FileNotFoundError(
                f"Voices file not found: {voices_path} (run fetch-model.sh first)"
            )

        sess_options = rt.SessionOptions()
        if num_threads:
            sess_options.intra_op_num_threads = num_threads
        # Explicitly pin to CPU execution provider: this service is CPU-only
        # by design (no GPU/CUDA/Metal requirement).
        providers = ["CPUExecutionProvider"]

        t0 = time.time()
        session = rt.InferenceSession(
            model_path, sess_options=sess_options, providers=providers
        )
        self.kokoro = Kokoro.from_session(session, voices_path)
        load_seconds = time.time() - t0

        self.model_path = model_path
        self.voices_path = voices_path
        self.model_version = Path(model_path).name
        self.execution_providers = session.get_providers()
        self.sample_rate = 24000  # kokoro_onnx.config.SAMPLE_RATE
        self.voices = self.kokoro.get_voices()
        self._gate = threading.Semaphore(max_concurrency)
        self._executor = ThreadPoolExecutor(
            max_workers=max_concurrency, thread_name_prefix="kokoro-synth"
        )

        log.info(
            "Model loaded in %.2fs: %s (%d voices, providers=%s, threads=%s)",
            load_seconds,
            self.model_version,
            len(self.voices),
            self.execution_providers,
            num_threads or "default",
        )

    def _synthesize_blocking(self, text: str, voice: str, speed: float, lang: str):
        with self._gate:
            t0 = time.time()
            audio, sample_rate = self.kokoro.create(
                text, voice=voice, speed=speed, lang=lang
            )
            gen_seconds = time.time() - t0
            return audio, sample_rate, gen_seconds

    def synthesize(
        self, text: str, voice: str, speed: float, lang: str, timeout_seconds: float
    ):
        """Run synthesis on the bounded executor and wait up to timeout_seconds.

        Raises concurrent.futures.TimeoutError on timeout. Note: Python cannot
        forcibly cancel a running CPU-bound thread, so a timed-out job keeps
        occupying one executor slot until it finishes on its own; this merely
        stops the *client* from hanging rather than killing stuck inference.
        """
        future = self._executor.submit(
            self._synthesize_blocking, text, voice, speed, lang
        )
        return future.result(timeout=timeout_seconds)


# ---------------------------------------------------------------------------
# WAV encoding (stdlib wave module; no soundfile dependency needed)
# ---------------------------------------------------------------------------


def float32_to_wav_bytes(audio, sample_rate: int) -> bytes:
    """Convert a float32 PCM numpy array in [-1, 1] to 16-bit PCM WAV bytes."""
    import numpy as np

    clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype("<i2")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm16.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "kokoro-server/1.0"
    engine: TtsEngine  # set on the server instance, accessed via self.server
    config: argparse.Namespace

    # Silence default stderr access logging; we log ourselves to stdout.
    def log_message(self, fmt, *args):  # noqa: A003
        log.info("%s - %s", self.address_string(), fmt % args)

    # -- helpers --------------------------------------------------------

    def _json_response(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        log.warning("error %d: %s", status, message)
        self._json_response(status, {"error": message})

    def _check_auth(self) -> bool:
        token = self.server.config.auth_token  # type: ignore[attr-defined]
        if not token:
            return True
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {token}"
        if header != expected:
            self._error(401, "Missing or invalid Authorization bearer token")
            return False
        return True

    # -- routes -----------------------------------------------------------

    def do_GET(self):  # noqa: N802
        engine: TtsEngine = self.server.engine  # type: ignore[attr-defined]
        if self.path == "/health":
            self._json_response(
                200,
                {
                    "status": "ok",
                    "voices_loaded": len(engine.voices),
                    "model_version": engine.model_version,
                    "execution_providers": engine.execution_providers,
                },
            )
        elif self.path == "/voices":
            self._json_response(200, {"voices": engine.voices})
        else:
            self._error(404, f"Not found: {self.path}")

    def do_POST(self):  # noqa: N802
        if self.path != "/synthesize":
            self._error(404, f"Not found: {self.path}")
            return
        if not self._check_auth():
            return

        config = self.server.config  # type: ignore[attr-defined]
        engine: TtsEngine = self.server.engine  # type: ignore[attr-defined]

        content_length_header = self.headers.get("Content-Length")
        if content_length_header is None:
            self._error(411, "Content-Length is required")
            return
        try:
            content_length = int(content_length_header)
        except ValueError:
            self._error(400, "Invalid Content-Length")
            return
        if content_length > config.max_request_bytes:
            self._error(
                413,
                f"Request body too large ({content_length} bytes, "
                f"max {config.max_request_bytes})",
            )
            return

        raw_body = self.rfile.read(content_length)
        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, f"Invalid JSON body: {exc}")
            return
        if not isinstance(payload, dict):
            self._error(400, "Request body must be a JSON object")
            return

        text = payload.get("text")
        voice = payload.get("voice")
        speed = payload.get("speed", 1.0)
        lang = payload.get("lang", "en-us")

        if not isinstance(text, str) or not text.strip():
            self._error(400, "'text' must be a non-empty string")
            return
        if len(text) > config.max_text_chars:
            self._error(
                400,
                f"'text' is too long ({len(text)} chars, max {config.max_text_chars})",
            )
            return
        if not isinstance(voice, str) or not voice:
            self._error(400, "'voice' must be a non-empty string")
            return
        if voice not in engine.voices:
            self._error(
                400,
                f"Unknown voice '{voice}'. Available voices: "
                f"{', '.join(engine.voices)}",
            )
            return
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            self._error(400, "'speed' must be a number")
            return
        if not (0.5 <= speed <= 2.0):
            self._error(400, f"'speed' must be between 0.5 and 2.0, got {speed}")
            return
        if not isinstance(lang, str) or not lang:
            self._error(400, "'lang' must be a non-empty string")
            return

        try:
            audio, sample_rate, gen_seconds = engine.synthesize(
                text, voice, speed, lang, config.synth_timeout_seconds
            )
        except FutureTimeoutError:
            self._error(
                504,
                f"Synthesis timed out after {config.synth_timeout_seconds}s",
            )
            return
        except ValueError as exc:
            # kokoro-onnx raises ValueError for bad input (e.g. unphonemizable
            # text, out-of-range speed it re-validates, etc.)
            self._error(400, f"Synthesis failed: {exc}")
            return
        except Exception as exc:  # noqa: BLE001
            log.exception("Unexpected synthesis failure")
            self._error(500, f"Internal synthesis error: {exc}")
            return

        try:
            wav_bytes = float32_to_wav_bytes(audio, sample_rate)
        except Exception as exc:  # noqa: BLE001
            log.exception("WAV encoding failure")
            self._error(500, f"Internal audio encoding error: {exc}")
            return

        audio_duration = len(audio) / sample_rate
        log.info(
            "synthesized voice=%s chars=%d speed=%s gen_seconds=%.2f "
            "audio_seconds=%.2f rtf=%.2f",
            voice,
            len(text),
            speed,
            gen_seconds,
            audio_duration,
            gen_seconds / audio_duration if audio_duration else 0.0,
        )

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav_bytes)))
        self.send_header("X-Audio-Duration-Seconds", f"{audio_duration:.4f}")
        self.send_header("X-Sample-Rate", str(sample_rate))
        self.end_headers()
        self.wfile.write(wav_bytes)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler_cls, engine: TtsEngine, config: argparse.Namespace):
        super().__init__(addr, handler_cls)
        self.engine = engine
        self.config = config


def main(argv: list[str] | None = None) -> int:
    config = build_config(argv)

    log.info("Loading Kokoro model (this happens once at startup)...")
    engine = TtsEngine(
        model_path=config.model_path,
        voices_path=config.voices_path,
        num_threads=config.num_threads,
        max_concurrency=config.max_concurrency,
    )

    server = Server((config.host, config.port), Handler, engine, config)
    log.info(
        "kokoro-server listening on http://%s:%d (max_concurrency=%d, "
        "auth=%s, synth_timeout=%ss)",
        config.host,
        config.port,
        config.max_concurrency,
        "enabled" if config.auth_token else "disabled",
        config.synth_timeout_seconds,
    )

    stop_event = threading.Event()

    def _handle_signal(signum, _frame):
        log.info("Received signal %d, shutting down...", signum)
        stop_event.set()
        # shutdown() must be called from a different thread than serve_forever()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        engine._executor.shutdown(wait=False)
        log.info("kokoro-server stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
