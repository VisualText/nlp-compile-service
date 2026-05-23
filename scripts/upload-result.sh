#!/usr/bin/env bash
#
# Push build outputs from a GH Actions runner to the dispatcher.
# Uploaded blobs are stored under deterministic R2 keys derived from
# the job ID, so the dispatcher's /callback step doesn't need to
# round-trip storage keys back to itself.
#
# Usage:
#   bash scripts/upload-result.sh \
#     --job   <jobId> \
#     --lib   <path>           # optional; omitted on build failure
#     --log   <path>           # optional but recommended
#     --errors <path>          # optional; JSON file from parse-errors.py
#
# Required env vars (set as workflow secrets):
#   DISPATCHER_URL    e.g. https://compile.visualtext.org
#   JOB_TOKEN         shared secret known to dispatcher

set -euo pipefail

JOB=""
LIB=""
LOG=""
ERRORS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --job)     JOB="$2";     shift 2 ;;
    --lib)     LIB="$2";     shift 2 ;;
    --log)     LOG="$2";     shift 2 ;;
    --errors)  ERRORS="$2";  shift 2 ;;
    *) echo "upload-result.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$JOB" ] || { echo "upload-result.sh: --job required" >&2; exit 2; }
: "${DISPATCHER_URL:?DISPATCHER_URL not set}"
: "${JOB_TOKEN:?JOB_TOKEN not set}"

put() {
  local kind="$1"
  local file="$2"
  local ctype="$3"
  echo "upload-result.sh: PUT $kind ($(wc -c <"$file") bytes)"
  curl -fsSL -X PUT \
    -H "authorization: Bearer $JOB_TOKEN" \
    -H "content-type: $ctype" \
    --data-binary "@$file" \
    "$DISPATCHER_URL/jobs/$JOB/artifacts/$kind"
}

if [ -n "$LIB" ] && [ -f "$LIB" ]; then
  put lib "$LIB" "application/octet-stream"
fi

if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  put log "$LOG" "text/plain"
fi

if [ -n "$ERRORS" ] && [ -f "$ERRORS" ]; then
  put errors "$ERRORS" "application/json"
fi
