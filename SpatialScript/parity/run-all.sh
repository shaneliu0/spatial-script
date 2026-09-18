#!/bin/bash
# Runs the parity gate over every example and scenario. Usage: parity/run-all.sh
cd "$(dirname "$0")/.."
fail=0
for f in examples/*.js scenarios/*.js; do
  n=$(basename "$f" .js); steps="parity/steps/$n.json"
  if [ -f "$steps" ]; then node parity/run-parity.mjs "$f" --steps "$steps" --label "$n"; else node parity/run-parity.mjs "$f" --label "$n"; fi
  [ $? -ne 0 ] && fail=1
done
exit $fail
