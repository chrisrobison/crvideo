#!/usr/bin/env bash
#
# fetch-model.sh - download the Kokoro ONNX model + voices file for kokoro-server.
#
# Source: https://github.com/thewh1teagle/kokoro-onnx releases ("model-files-v1.1" tag,
# English v1.0 model exports). Idempotent: skips any file that already exists and matches
# the expected size.
#
# Usage:
#   ./fetch-model.sh                  # fetch default quality (fp32, recommended for most CPUs)
#   KOKORO_MODEL_QUALITY=int8 ./fetch-model.sh   # quantized (smaller; only faster on CPUs with
#                                                 # AVX2/AVX-512 VNNI -- see README benchmark notes)
#   KOKORO_MODEL_QUALITY=fp16 ./fetch-model.sh   # half precision (mainly useful on GPU, not CPU)
#
# NOTE on quality choice: measured on this project's reference machine (an older Xeon with AVX
# but no AVX2/VNNI), the int8 model was ~1.8x SLOWER than fp32 (RTF 2.67 vs 1.45) because
# onnxruntime's CPU EP has no fast int8 GEMM path without AVX2/VNNI, so quantize/dequantize is
# pure overhead there. On a modern CPU (AVX2/AVX-512 VNNI, e.g. recent Intel/AMD or Apple Silicon
# via ARM NEON dot-product), int8 is typically faster and is worth benchmarking with bench.py.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODELS_DIR="${SCRIPT_DIR}/models"
RELEASE_TAG="model-files-v1.1"
BASE_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/${RELEASE_TAG}"

QUALITY="${KOKORO_MODEL_QUALITY:-fp32}"

case "${QUALITY}" in
  fp32)
    MODEL_FILE="kokoro-v1.0.onnx"
    MODEL_SIZE=325505369
    ;;
  fp16)
    MODEL_FILE="kokoro-v1.0.fp16.onnx"
    MODEL_SIZE=163527961
    ;;
  int8)
    MODEL_FILE="kokoro-v1.0.int8.onnx"
    MODEL_SIZE=114119327
    ;;
  *)
    echo "ERROR: unknown KOKORO_MODEL_QUALITY='${QUALITY}' (expected fp32, fp16, or int8)" >&2
    exit 1
    ;;
esac

VOICES_FILE="voices-v1.0.bin"
VOICES_SIZE=28214398

mkdir -p "${MODELS_DIR}"

log() { printf '[fetch-model] %s\n' "$*"; }
err() { printf '[fetch-model] ERROR: %s\n' "$*" >&2; }

# download <filename> <expected-size-bytes>
download() {
  local name="$1" expected_size="$2"
  local dest="${MODELS_DIR}/${name}"
  local url="${BASE_URL}/${name}"

  if [[ -f "${dest}" ]]; then
    local actual_size
    actual_size="$(stat -c%s "${dest}" 2>/dev/null || stat -f%z "${dest}" 2>/dev/null || echo 0)"
    if [[ "${actual_size}" -eq "${expected_size}" ]]; then
      log "OK: ${name} already present and complete (${actual_size} bytes), skipping."
      return 0
    else
      err "${name} exists but has unexpected size (${actual_size} != ${expected_size} expected). Re-downloading."
      rm -f "${dest}"
    fi
  fi

  log "Downloading ${name} (~$((expected_size / 1024 / 1024)) MiB) from ${url}"
  local tmp="${dest}.part"
  rm -f "${tmp}"

  if ! curl -fL --retry 3 --retry-delay 2 --progress-bar -o "${tmp}" "${url}"; then
    err "Failed to download ${name} from ${url}"
    err "Check network egress to github.com / objects.githubusercontent.com, or that the release asset still exists."
    rm -f "${tmp}"
    return 1
  fi

  local got_size
  got_size="$(stat -c%s "${tmp}" 2>/dev/null || stat -f%z "${tmp}" 2>/dev/null || echo 0)"
  if [[ "${got_size}" -ne "${expected_size}" ]]; then
    err "Downloaded ${name} has size ${got_size}, expected ${expected_size}. Download likely truncated or asset changed upstream."
    rm -f "${tmp}"
    return 1
  fi

  mv "${tmp}" "${dest}"
  log "Done: ${name} (${got_size} bytes)"
}

log "Model quality: ${QUALITY} (set KOKORO_MODEL_QUALITY=fp32|fp16|int8 to change)"
log "Target directory: ${MODELS_DIR}"

FAILED=0
download "${MODEL_FILE}" "${MODEL_SIZE}" || FAILED=1
download "${VOICES_FILE}" "${VOICES_SIZE}" || FAILED=1

if [[ "${FAILED}" -ne 0 ]]; then
  err "One or more downloads failed. See messages above."
  exit 1
fi

# Write a small marker so server.py / bench.py can discover the active model
# without re-deriving the quality choice.
cat > "${MODELS_DIR}/ACTIVE_MODEL" <<EOF
${MODEL_FILE}
${VOICES_FILE}
EOF

log "All files present:"
log "  model:  ${MODELS_DIR}/${MODEL_FILE}"
log "  voices: ${MODELS_DIR}/${VOICES_FILE}"
log "Done."
