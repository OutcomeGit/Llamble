# Brute-force protection: wrong passwords get an address+username blocked for a while
import requests, sys
B=sys.argv[1]
s=requests.post(B+"/api/setup",json={"username":"bran","password":"right-password1"}).json(); assert "token" in s, s
codes=[requests.post(B+"/api/auth/login",json={"username":"bran","password":f"guess{i}"}).status_code for i in range(8)]
assert codes==[401]*8, codes
r=requests.post(B+"/api/auth/login",json={"username":"bran","password":"right-password1"})
assert r.status_code==429 and "try again in" in r.json()["error"], (r.status_code, r.text)
print("8 wrong passwords -> blocked, even the right one waits:", r.json()["error"])
r=requests.post(B+"/api/auth/login",json={"username":"BRAN ","password":"x"}); assert r.status_code==429  # same account, other spelling
# other accounts from the same address still get tries until the address limit
codes=[requests.post(B+"/api/auth/login",json={"username":f"user{i}","password":"x"}).status_code for i in range(22)]
assert codes==[401]*22, codes
r=requests.post(B+"/api/auth/login",json={"username":"someoneelse","password":"x"}); assert r.status_code==429, r.status_code
print("30 failures from one address -> that address is blocked")
# relayed visitors (arriving from this machine) only get the per-account limit
L="http://127.0.0.1:8099"
codes=[requests.post(L+"/api/auth/login",json={"username":f"relayed{i}","password":"x"}).status_code for i in range(35)]
assert codes==[401]*35, codes
print("relayed visitors: no shared address lockout")
print("ALL LOGIN GUARD OK")
