#!/bin/bash
# Runs the parity gate over every example and scenario. Usage: verification/parity/run-all.sh
cd "$(dirname "$0")/../.."
fail=0
for f in examples/*.js verification/scenarios/*.js verification/scenarios/robustness/*.js; do
  n=$(basename "$f" .js); steps="verification/parity/steps/$n.json"
  if [ -f "$steps" ]; then node verification/parity/run-parity.mjs "$f" --steps "$steps" --label "$n"; else node verification/parity/run-parity.mjs "$f" --label "$n"; fi
  [ $? -ne 0 ] && fail=1
done
exit $fail
