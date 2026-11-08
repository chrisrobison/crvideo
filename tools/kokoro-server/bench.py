#!/usr/bin/env python3
"""
bench.py - benchmark Kokoro TTS inference speed on this machine.

By default this loads the model directly in-process (standalone mode) and
times a single call to Kokoro.create(). That measures pure inference
performance without HTTP/JSON overhead, which is what matters for sizing
"how fast is this CPU at TTS" - the number PHP/CRVideo cares about is
dominated by model inference, not the thin HTTP wrapper around it.

Pass --http to instead benchmark an already-running server's POST
/synthesize endpoint (useful to confirm the deployed service performs the
same as the standalone number, and to include real HTTP overhead).

Usage:
    python3 bench.py                         # standalone, loads the model itself
    python3 bench.py --json                  # machine-readable output
    python3 bench.py --http --url http://127.0.0.1:8178   # benchmark running server
    python3 bench.py --voice af_heart --text "..."        # override sample
"""

from __future__ import annotations

import argparse
import json
import platform
import resource
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# A realistic ~27-word broadcast-announcer sentence, chosen to read aloud in
# roughly 9-10 seconds at a natural pace - representative of a CRVideo
# "up next" continuity announcement.
SAMPLE_TEXT = (
    "Good evening, and welcome back. Up next, a brand new episode featuring "
    "surprising twists, unforgettable moments, and a finale you will not "
    "want to miss."
)
DEFAULT_VOICE = "af_heart"


def cpu_model_name() -> str:
    try:
        with open("/proc/cpuinfo", encoding="utf-8") as fp:
            for line in fp:
                if line.lower().startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or platform.machine()


def peak_memory_mb() -> float:
    """ru_maxrss is in KB on Linux, bytes on macOS. Normalize to MB."""
    ru_maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform == "darwin":
        return ru_maxrss / (1024 * 1024)
    return ru_maxrss / 1024


def _default_model_paths() -> tuple[str, str]:
    models_dir = SCRIPT_DIR / "models"
    marker = models_dir / "ACTIVE_MODEL"
    if marker.exists():
        lines = [l.strip() for l in marker.read_text().splitlines() if l.strip()]
        if len(lines) >= 2:
            return str(models_dir / lines[0]), str(models_dir / lines[1])
    return str(models_dir / "kokoro-v1.0.onnx"), str(models_dir / "voices-v1.0.bin")


def run_standalone(args) -> dict:
    import onnxruntime as rt
    from kokoro_onnx import Kokoro

    model_path = args.model_path or _default_model_paths()[0]
    voices_path = args.voices_path or _default_model_paths()[1]

    sess_options = rt.SessionOptions()
    if args.num_threads:
        sess_options.intra_op_num_threads = args.num_threads
    providers = ["CPUExecutionProvider"]

    load_t0 = time.time()
    session = rt.InferenceSession(
        model_path, sess_options=sess_options, providers=providers
    )
    kokoro = Kokoro.from_session(session, voices_path)
    load_seconds = time.time() - load_t0

    if args.voice not in kokoro.get_voices():
        raise SystemExit(
            f"Voice '{args.voice}' not found. Available: {kokoro.get_voices()}"
        )

    # Warm-up run (first inference pays one-time graph/session warmup cost
    # that would otherwise skew a single-shot benchmark).
    kokoro.create(args.text, voice=args.voice, speed=1.0, lang=args.lang)

    gen_t0 = time.time()
    audio, sample_rate = kokoro.create(
        args.text, voice=args.voice, speed=1.0, lang=args.lang
    )
    gen_seconds = time.time() - gen_t0
    audio_seconds = len(audio) / sample_rate

    return {
        "mode": "standalone",
        "model_version": Path(model_path).name,
        "execution_providers": session.get_providers(),
        "voice": args.voice,
        "model_load_seconds": round(load_seconds, 3),
        "generation_seconds": round(gen_seconds, 3),
        "audio_seconds": round(audio_seconds, 3),
        "real_time_factor": round(gen_seconds / audio_seconds, 4),
        "sample_rate": sample_rate,
        "peak_memory_mb": round(peak_memory_mb(), 1),
        "cpu_model": cpu_model_name(),
        "text_chars": len(args.text),
    }


def run_http(args) -> dict:
    health_req = urllib.request.Request(f"{args.url}/health")
    with urllib.request.urlopen(health_req, timeout=10) as resp:
        health = json.loads(resp.read())

    body = json.dumps(
        {"text": args.text, "voice": args.voice, "speed": 1.0, "lang": args.lang}
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{args.url}/synthesize",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if args.auth_token:
        req.add_header("Authorization", f"Bearer {args.auth_token}")

    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=args.timeout) as resp:
            wav_bytes = resp.read()
            audio_duration = float(resp.headers.get("X-Audio-Duration-Seconds", "0"))
            sample_rate = int(resp.headers.get("X-Sample-Rate", "0"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Server returned HTTP {exc.code}: {exc.read().decode()}")
    wall_seconds = time.time() - t0

    return {
        "mode": "http",
        "url": args.url,
        "model_version": health.get("model_version"),
        "execution_providers": health.get("execution_providers"),
        "voice": args.voice,
        "wall_clock_seconds": round(wall_seconds, 3),
        "audio_seconds": round(audio_duration, 3),
        "real_time_factor": round(wall_seconds / audio_duration, 4)
        if audio_duration
        else None,
        "sample_rate": sample_rate,
        "wav_bytes": len(wav_bytes),
        "peak_memory_mb": round(peak_memory_mb(), 1),
        "cpu_model": cpu_model_name(),
        "text_chars": len(args.text),
        "note": "RTF here includes HTTP+JSON overhead, not just inference.",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark Kokoro TTS inference")
    parser.add_argument("--http", action="store_true", help="Benchmark a running server instead of loading the model directly")
    parser.add_argument("--url", default="http://127.0.0.1:8178", help="Server base URL (with --http)")
    parser.add_argument("--auth-token", default=None, help="Bearer token (with --http, if the server requires one)")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP request timeout seconds (with --http)")
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--text", default=SAMPLE_TEXT)
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--model-path", default=None, help="Standalone mode only")
    parser.add_argument("--voices-path", default=None, help="Standalone mode only")
    parser.add_argument("--num-threads", type=int, default=0, help="Standalone mode only; 0 = onnxruntime default")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of a human summary")
    args = parser.parse_args(argv)

    result = run_http(args) if args.http else run_standalone(args)

    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    print("Kokoro TTS benchmark")
    print("====================")
    print(f"Mode:                 {result['mode']}")
    print(f"CPU:                  {result['cpu_model']}")
    print(f"Execution providers:  {result['execution_providers']}")
    print(f"Voice:                {result['voice']}")
    print(f"Text length:          {result['text_chars']} chars")
    if result["mode"] == "standalone":
        print(f"Model load time:      {result['model_load_seconds']:.3f} s")
        print(f"Generation time:      {result['generation_seconds']:.3f} s")
    else:
        print(f"Wall-clock time:      {result['wall_clock_seconds']:.3f} s  (includes HTTP overhead)")
    print(f"Audio duration:       {result['audio_seconds']:.3f} s")
    rtf = result["real_time_factor"]
    print(f"Real-time factor:     {rtf:.3f}  ({'faster' if rtf and rtf < 1.0 else 'slower'} than real time)")
    print(f"Peak memory (RSS):    {result['peak_memory_mb']:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
