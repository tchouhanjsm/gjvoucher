#!/bin/bash
# fresh server + e2e run
cd "$(dirname "$0")/.."
node test/server.js > /tmp/srv.log 2>&1 & SP=$!
sleep 1
timeout 150 python3 "${1:-test/e2e.py}" 2>&1 | grep -vE "^\s+(File|\^|~)|Traceback" | tail -${2:-25}
kill $SP 2>/dev/null
