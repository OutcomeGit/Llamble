#!/usr/bin/env bash
# Runs every server test suite against a fresh server each time. Usage: tests/run_all.sh [server-binary]
set -u
cd "$(dirname "$0")"; T=$(pwd)
BIN=$(realpath ${1:-$T/../server/target/debug/llamble-server})
python3 mock_llama.py >/dev/null 2>&1 & M1=$!
python3 mock_hf.py >/dev/null 2>&1 & M2=$!
python3 mock_namecheap_livekit.py >/dev/null 2>&1 & M3=$!
trap 'kill $M1 $M2 $M3 2>/dev/null; pkill -f fake_livekit.py; pkill -f fake_llama_server.py' EXIT
sleep 1
# lets the remote test check "I handle it myself" mode against a name that resolves
grep -q manual.llamble.test /etc/hosts 2>/dev/null || { [ -w /etc/hosts ] && echo "127.0.0.1 manual.llamble.test" >> /etc/hosts; }
FAIL=0
run() { # name, extra env..., -- test args...
  local name=$1; shift; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  pkill -f llamble-server 2>/dev/null; pkill -f fake_livekit.py; sleep 0.8
  local D=$(mktemp -d)
  env LLAMBLE_DATA=$D LLAMBLE_BIND=127.0.0.1:8099 LLAMBLE_ACME_STAGING=1 LLAMBLE_LIVEKIT_BIN=/nonexistent "${envs[@]}" "$BIN" >$D/log 2>&1 &
  local P=$!; sleep 1.5
  local INV=$(cat $D/ADMIN_INVITE.txt 2>/dev/null)
  local args=(); for a in "$@"; do args+=("${a//@INV@/$INV}"); done
  if timeout 240 python3 "${args[@]}" >$D/out 2>&1; then echo "PASS $name"; else echo "FAIL $name (see $D)"; tail -5 $D/out; FAIL=1; fi
  kill $P 2>/dev/null; wait $P 2>/dev/null
}
LK=(LIVEKIT_URL=ws://NASIP:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=devsecretdevsecretdevsecretdevsecret)
run smoke "${LK[@]}" -- smoke.py http://127.0.0.1:8099 @INV@
run bot LLAMBLE_LLAMA_URL=http://127.0.0.1:8098 -- bot_test.py http://127.0.0.1:8099 @INV@
run setup FAKE_LLAMA_LOAD_SECS=4 LLAMBLE_HF_ENDPOINT=http://127.0.0.1:8097 LLAMBLE_LLAMA_BIN=$T/fake_llama_server.py -- setup_test.py http://127.0.0.1:8099
run gpu_pool LLAMBLE_LLAMA_URL=http://127.0.0.1:8098 -- gpu_pool_test.py http://127.0.0.1:8099
run remote "${LK[@]}" LLAMBLE_DDNS_ENDPOINT=http://127.0.0.1:8096 LLAMBLE_CLOUDFLARE_API=http://127.0.0.1:8096/client/v4 LLAMBLE_DUCKDNS_ENDPOINT=http://127.0.0.1:8096/duck LLAMBLE_IP_ECHO=http://127.0.0.1:8096/trace LIVEKIT_INTERNAL_URL=http://127.0.0.1:8095 -- remote_test.py http://127.0.0.1:8099
run relay LLAMBLE_LIVEKIT_BIN=$T/fake_livekit.py FAKE_LK_OUT=/tmp/fake_lk.yaml -- relay_test.py http://127.0.0.1:8099 "$BIN"
exit $FAIL
