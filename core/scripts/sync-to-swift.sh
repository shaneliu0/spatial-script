#!/usr/bin/env bash
# Copies the built core bundle into the Swift package resources.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
core_root="$(cd "$here/.." && pwd)"
repo_root="$(cd "$core_root/.." && pwd)"

source_file="$core_root/dist/spatial-core.js"
dest_dir="$repo_root/Sources/SpatialScriptRuntime/Resources"
dest_file="$dest_dir/spatial-core.js"

if [ ! -f "$source_file" ]; then
  echo "spatial-core.js not found at $source_file; run the build first" >&2
  exit 1
fi

mkdir -p "$dest_dir"
cp "$source_file" "$dest_file"
echo "synced $(wc -c < "$dest_file" | tr -d ' ') bytes -> $dest_file"
