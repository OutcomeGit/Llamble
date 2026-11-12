#!/usr/bin/env bash
# Runs every server test suite against a fresh server each time. Usage: tests/run_all.sh [server-binary]
set -u
cd "$(dirname "$0")"; T=$(pwd)
BIN=$(realpath ${1:-$T/../server/target/debug/llamble-server})
python3 mock_llama.py >/dev/null 2>&1 & M1=$!
python3 mock_hf.py >/dev/null 2>&1 & M2=$!
python3 mock_namecheap_livekit.py >/dev/null 2>&1 & M3=$!
python3 mock_smtp.py >/dev/null 2>&1 & M4=$!
trap 'kill $M1 $M2 $M3 $M4 2>/dev/null; pkill -f fake_livekit.py; pkill -f fake_llama_server.py' EXIT
sleep 1
# lets the remote test check "I handle it myself" mode against a name that resolves
grep -q manual.llamble.test /etc/hosts 2>/dev/null || { [ -w /etc/hosts ] && echo "127.0.0.1 manual.llamble.test" >> /etc/hosts; }
FAIL=0
run() { # name, extra env..., -- test args...
  local name=$1; shift; local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  pkill -f llamble-server 2>/dev/null; pkill -f fake_livekit.py; sleep 0.8
  local D=$(mktemp -d)
  env LLAMBLE_DATA=$D LLAMBLE_BIND=127.0.0.1:8099 LLAMBLE_ACME_STAGING=1 LLAMBLE_LIVEKIT_BIN=/nonexistent "${envs[@]}" "$BIN" >$D/log 2>&1 &
  local P=$!
  for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:8099/api/info && break; sleep 0.25; done
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
# connect over the network address: relayed (localhost) visitors only get the per-account limit
LAN_IP=$(hostname -I 2>/dev/null | awk "{print \$1}")
run accounts -- accounts_test.py http://127.0.0.1:8099
run shows LLAMBLE_LIVEKIT_BIN=$T/fake_livekit.py FAKE_LK_OUT=/tmp/fake_lk2.yaml -- shows_test.py http://127.0.0.1:8099
run soundboard LLAMBLE_LIVEKIT_BIN=$T/fake_livekit.py FAKE_LK_OUT=/tmp/fake_lk3.yaml -- soundboard_test.py http://127.0.0.1:8099
IMP=$(mktemp -d); python3 -c "f=open('$IMP/unsloth_Qwen3-4B-Instruct-2507-GGUF_Qwen3-4B-Instruct-2507-Q4_K_M.gguf','wb'); f.write(b'GGUF'); f.truncate(60_000_000)"
run import LLAMBLE_IMPORT_DIR=$IMP LLAMBLE_LLAMA_BIN=$T/fake_llama_server.py -- import_test.py http://127.0.0.1:8099
run voicebot LLAMBLE_LIVEKIT_BIN=$T/fake_livekit.py FAKE_LK_OUT=/tmp/fake_lk4.yaml LLAMBLE_LLAMA_URL=http://127.0.0.1:8098 LLAMBLE_VOICE_MODELS_URL=http://127.0.0.1:8094 LLAMBLE_STT_BIN=$T/fake_stt.py LLAMBLE_TTS_BIN=$T/fake_tts.py FAKE_STT_MAP=/tmp/fake_stt_map.json -- voicebot_test.py http://127.0.0.1:8099
run images LLAMBLE_LLAMA_URL=http://127.0.0.1:8098 LLAMBLE_HF_ENDPOINT=http://127.0.0.1:8093 LLAMBLE_SD_BIN=$T/fake_sd.py -- images_test.py http://127.0.0.1:8099
run presence_race -- presence_race_test.py http://127.0.0.1:8099
run activity -- activity_test.py http://127.0.0.1:8099
run share -- share_test.py http://127.0.0.1:8099
run pushes -- pushes_test.py http://127.0.0.1:8099
run social -- social_test.py http://127.0.0.1:8099
run home -- home_test.py http://127.0.0.1:8099
run alarms -- alarms_test.py http://127.0.0.1:8099
NEWS_KEY=$(python3 -c "import base64;from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K;from cryptography.hazmat.primitives import serialization as s;print(base64.b64encode(K.from_private_bytes(bytes(range(32))).public_key().public_bytes(s.Encoding.Raw,s.PublicFormat.Raw)).decode())")
run news LLAMBLE_NEWS_TEST_KEY=$NEWS_KEY -- news_test.py http://127.0.0.1:8099
run news_nokey -- news_test.py http://127.0.0.1:8099 nokey
run login_guard LLAMBLE_BIND=0.0.0.0:8099 -- login_guard_test.py http://${LAN_IP:-127.0.0.1}:8099
exit $FAIL
