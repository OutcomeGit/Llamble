# A model left in the old llama.cpp container's storage (mounted at the import folder) is found,
# shown in the model list, and used without downloading again.
import requests, sys, time
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Fam"}).json()
H = {"Authorization": "Bearer " + s["token"]}
models = requests.get(B + "/api/admin/ai/models", headers=H).json()["models"]
m = [x for x in models if x["repo"] == "unsloth/Qwen3-4B-Instruct-2507-GGUF"]
assert m and m[0]["quant"] == "Q4_K_M" and m[0]["complete"] and m[0]["on_disk"] > 50_000_000, models
for _ in range(40):
    st = requests.get(B + "/api/admin/ai", headers=H).json()["status"]
    if st.get("state") == "ready": break
    time.sleep(0.25)
assert st["state"] == "ready" and st["repo"] == "unsloth/Qwen3-4B-Instruct-2507-GGUF", st
print("old llama.cpp model found, listed, and running without a download")
