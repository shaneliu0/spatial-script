#!/bin/bash
# Pushes a generated stress scene to the macOS host and prints load time and steady-state stats.
# Usage: perf/measure.sh <gen-stress args...>    e.g. perf/measure.sh --count 1500 --shared-geometry
cd "$(dirname "$0")/.."
SCRIPT=$(mktemp /tmp/stress.XXXX.js); node perf/gen-stress.mjs "$@" > "$SCRIPT"
curl -s http://127.0.0.1:8787/logs > /dev/null
T0=$(python3 -c "import time; print(time.time())")
RESP=$(curl -s -m 120 -X POST --data-binary @"$SCRIPT" http://127.0.0.1:8787/script)
T1=$(python3 -c "import time; print(time.time())")
sleep 4
python3 - "$T0" "$T1" "$*" <<'PY'
import json,sys,urllib.request,time
t0,t1,label=float(sys.argv[1]),float(sys.argv[2]),sys.argv[3]
try:
    st=json.load(urllib.request.urlopen("http://127.0.0.1:8787/stats",timeout=5))
except Exception as e:
    st={"error":str(e)}
d=json.load(urllib.request.urlopen("http://127.0.0.1:8787/dump",timeout=10)); f0=d["frame"]; time.sleep(2); d2=json.load(urllib.request.urlopen("http://127.0.0.1:8787/dump",timeout=10))
fps=(d2["frame"]-f0)/2
ct=st.get('coreTickMs',{}); ap=st.get('applyMs',{}); fi=st.get('frameIntervalMs',{}); rc=st.get('resourceCache',{})
print(f"[{label}] jit={st.get('jit','?')} push round trip {t1-t0:.2f}s (server push-to-first-frame {st.get('pushToFirstFrameMs','?')} ms) | measured fps {fps:.1f} | interval {fi.get('median','?')} ms | core tick {ct.get('median','?')} ms | apply {ap.get('median','?')} ms | objects {len(d['objects'])} | errors {d['errors']} | mesh builds {rc.get('meshBuilds')} material builds {rc.get('materialBuilds')} shape builds {rc.get('shapeBuilds')}")
PY
ps -o rss=,%cpu= -p $(pgrep -x SpatialHost) | awk '{print "    process: rss MB",$1/1024,"cpu%",$2}'
rm -f "$SCRIPT"
