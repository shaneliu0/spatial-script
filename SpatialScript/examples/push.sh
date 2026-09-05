#!/bin/bash
# Pushes a SpatialScript file to the running macOS host's dev server and prints the result.
# Usage: examples/push.sh <script.js> [host:port]
set -e
FILE="$1"; HOST="${2:-127.0.0.1:8787}"
[ -f "$FILE" ] || { echo "usage: examples/push.sh <script.js> [host:port]" >&2; exit 2; }
curl -s -X POST --data-binary @"$FILE" "http://$HOST/script"; echo
