# Alarms, reminders and the schedule: firing over the gateway, snooze/dismiss on every
# device, repeating alarms in a time zone, parents' locked alarms, the "get off" suggestion
# from a work schedule, and calendar links (ICS with RRULE / EXDATE / TZID).
import json, sys, threading, time, requests
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zoneinfo import ZoneInfo
from websocket import create_connection
B = sys.argv[1]
NY = ZoneInfo("America/New_York")

def call(method, path, tok=None, expect=200, tz=None, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    if tz:
        h["X-TZ"] = tz
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.text else {}

def conn(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    return ws, json.loads(ws.recv())["d"]

def wait(ws, t, pred=lambda d: True, secs=4):
    ws.settimeout(0.3)
    end = time.time() + secs
    while time.time() < end:
        try:
            m = json.loads(ws.recv())
        except Exception:
            continue
        if m.get("t") == t and pred(m["d"]):
            return m["d"]
    return None

now = lambda: int(time.time() * 1000)

s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"})
M, gid = s["token"], s["guild_id"]
inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 10})["code"]
reg = lambda u: call("POST", "/api/auth/register", json={"invite": inv, "username": u, "password": "pass-word-123"})
mom = reg("mom"); MOM, mom_id = mom["token"], mom["user"]["id"]
CAL = reg("cal")["token"]

# ---- a one-off alarm rings on time
ws1, _ = conn(M)
ws2, _ = conn(M)
a = call("POST", "/api/alarms", M, tz="America/New_York", json={"label": "Pizza", "kind": "alarm", "at": now() + 2000})
assert a["enabled"] and a["next_at"] == a["at"] and a["tz"] == "America/New_York" and a["sound"] == "classic" and a["snooze_min"] == 10 and a["set_by"] is None, a
assert wait(ws1, "ALARM_CREATE", lambda d: d["id"] == a["id"])
f = wait(ws1, "ALARM_FIRE", lambda d: d["alarm"]["id"] == a["id"], secs=6)
assert f and f["occurrence_at"] == a["at"], f
assert wait(ws2, "ALARM_FIRE", lambda d: d["alarm"]["id"] == a["id"]), "every device rings"
print("one-off alarm fires on all devices")

# ---- a device that comes online while it's ringing rings too
ws3, _ = conn(M)
assert wait(ws3, "ALARM_FIRE", lambda d: d["alarm"]["id"] == a["id"]), "still ringing → sent again after READY"
ws3.close()
print("ringing alarm re-sent after READY")

# ---- snooze from one device stops the others
t0 = now()
sn = call("POST", f"/api/alarms/{a['id']}/snooze", M, json={"minutes": 5})
assert wait(ws2, "ALARM_STOP", lambda d: d["alarm_id"] == a["id"]), "snooze stops the other device"
assert abs(sn["next_at"] - (t0 + 5 * 60_000)) < 3000 and sn["snoozed_until"] == sn["next_at"], sn
assert sn["enabled"]
ws4, _ = conn(M)
assert not wait(ws4, "ALARM_FIRE", secs=1), "snoozed alarms don't ring on connect"
ws4.close()
call("POST", f"/api/alarms/{a['id']}/snooze", M, expect=400, json={"minutes": 0})
print("snooze: ALARM_STOP everywhere, next ring in 5 min")

# ---- dismiss: a one-off turns off
d = call("POST", f"/api/alarms/{a['id']}/dismiss", M)
assert not d["enabled"] and d["next_at"] is None and d["snoozed_until"] is None, d
assert wait(ws1, "ALARM_STOP", lambda x: x["alarm_id"] == a["id"])
print("dismiss turns a one-off off")

# ---- validation
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "alarm", "at": now() - 1000})
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "alarm", "time": "07:30", "days": []})
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "alarm", "at": now() + 60000, "time": "07:30", "days": [1]})
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "alarm"})
call("POST", "/api/alarms", M, expect=400, json={"label": "", "kind": "alarm", "at": now() + 60000})
call("POST", "/api/alarms", M, expect=400, json={"label": "x" * 81, "kind": "alarm", "at": now() + 60000})
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "nap", "at": now() + 60000})
call("POST", "/api/alarms", M, expect=400, json={"label": "x", "kind": "alarm", "time": "7:30", "days": [1]})
print("validation OK")

# ---- repeating: 07:30 on weekdays in New York
r = call("POST", "/api/alarms", M, tz="America/New_York", json={"label": "School run", "kind": "alarm", "time": "07:30", "days": [1, 2, 3, 4, 5]})
def next_weekday_730(after_ms):
    d = datetime.fromtimestamp(after_ms / 1000, NY).date()
    for i in range(9):
        day = d + timedelta(days=i)
        if day.isoweekday() <= 5:
            t = datetime(day.year, day.month, day.day, 7, 30, tzinfo=NY)
            if t.timestamp() * 1000 > after_ms:
                return int(t.timestamp() * 1000)
expected = next_weekday_730(now())
assert r["next_at"] == expected and r["days"] == [1, 2, 3, 4, 5] and r["time"] == "07:30", (r, expected)
# dismissing a repeating alarm keeps it on, for the next one
d = call("POST", f"/api/alarms/{r['id']}/dismiss", M)
assert d["enabled"] and d["next_at"] == expected, d
# turning it off and on
off = call("PATCH", f"/api/alarms/{r['id']}", M, json={"enabled": False})
assert not off["enabled"] and off["next_at"] is None
on = call("PATCH", f"/api/alarms/{r['id']}", M, json={"enabled": True, "time": "06:45", "days": [0, 6]})
assert on["enabled"] and on["days"] == [0, 6] and datetime.fromtimestamp(on["next_at"] / 1000, NY).strftime("%H:%M %w") in ("06:45 0", "06:45 6"), on
assert len(call("GET", "/api/alarms", M)) == 2
print("repeating alarm: next 07:30 weekday in New York")

# ---- a parent's locked alarm on a kid
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "display_name": "Junior", "password": "kid-pass12"})
kid_id = kid["user"]["id"]
K = call("POST", "/api/auth/login", json={"username": "junior", "password": "kid-pass12"})["token"]
wsk, _ = conn(K)
wsm, _ = conn(MOM)
ka = call("POST", f"/api/kids/{kid_id}/alarms", MOM, tz="America/Chicago", json={"label": "Bedtime", "kind": "alarm", "time": "20:30", "days": [0, 1, 2, 3, 4, 5, 6]})
assert ka["locked"] and ka["set_by"]["id"] == mom_id and ka["tz"] == "America/Chicago", ka
assert wait(wsk, "ALARM_CREATE", lambda d: d["id"] == ka["id"]) and wait(wsm, "ALARM_CREATE", lambda d: d["id"] == ka["id"]), "kid and parent both hear about it"
call("POST", f"/api/kids/{kid_id}/alarms", M, expect=403, json={"label": "x", "kind": "alarm", "time": "20:30", "days": [1]})
call("GET", f"/api/kids/{kid_id}/alarms", M, expect=403)
assert [x["id"] for x in call("GET", f"/api/kids/{kid_id}/alarms", MOM)] == [ka["id"]]
assert [x["id"] for x in call("GET", "/api/alarms", K)] == [ka["id"]]
r403 = requests.delete(B + f"/api/alarms/{ka['id']}", headers={"Authorization": "Bearer " + K})
assert r403.status_code == 403 and r403.json()["error"] == "A parent set this alarm", r403.text
call("PATCH", f"/api/alarms/{ka['id']}", K, expect=403, json={"enabled": False})
call("DELETE", f"/api/alarms/{ka['id']}", M, expect=404)  # not yours
call("POST", f"/api/alarms/{ka['id']}/snooze", K)
call("POST", f"/api/alarms/{ka['id']}/snooze", K)
r403 = requests.post(B + f"/api/alarms/{ka['id']}/snooze", headers={"Authorization": "Bearer " + K})
assert r403.status_code == 403 and r403.json()["error"] == "No more snoozes", r403.text
up = call("PATCH", f"/api/alarms/{ka['id']}", MOM, json={"time": "20:45"})
assert up["time"] == "20:45" and up["locked"]
assert wait(wsk, "ALARM_UPDATE", lambda d: d["id"] == ka["id"] and d["time"] == "20:45")
# a kid's own alarm is theirs to change
own = call("POST", "/api/alarms", K, json={"label": "Cartoons", "kind": "reminder", "at": now() + 3_600_000})
call("DELETE", f"/api/alarms/{own['id']}", K)
call("DELETE", f"/api/alarms/{ka['id']}", MOM)
assert wait(wsk, "ALARM_DELETE", lambda d: d["id"] == ka["id"])
print("kid: locked alarm can't be deleted/changed, 2 snoozes max; parent can")

# ---- "get off" suggestion from a manual work schedule
TZ = "America/New_York"
sch = call("GET", "/api/schedule", MOM, tz=TZ)
assert sch == {"calendar": {"set": False, "error": None, "fetched_at": None}, "manual": None, "sleep_hours": 8.0, "ready_minutes": 60, "suggest": True}, sch
call("PUT", "/api/schedule", MOM, expect=400, json={"sleep_hours": 4})
call("PUT", "/api/schedule", MOM, expect=400, json={"ready_minutes": 300})
call("PUT", "/api/schedule", MOM, expect=400, json={"manual": {"days": [], "start": "10:00", "end": None, "title": "Work"}})
# a 10:00 start with 5 h sleep and no getting-ready: the alarm (05:00 tomorrow) is always ahead
sch = call("PUT", "/api/schedule", MOM, tz=TZ, json={"manual": {"days": [0, 1, 2, 3, 4, 5, 6], "start": "10:00", "end": "18:00", "title": "Work"}, "sleep_hours": 5, "ready_minutes": 0})
assert sch["manual"] == {"days": [0, 1, 2, 3, 4, 5, 6], "start": "10:00", "end": "18:00", "title": "Work"} and sch["sleep_hours"] == 5.0, sch
tomorrow = datetime.now(NY).date() + timedelta(days=1)
start = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 10, 0, tzinfo=NY)
want_alarm = int((start - timedelta(hours=5)).timestamp() * 1000)
sg = call("GET", "/api/schedule/suggestion", MOM, tz=TZ)
assert sg and sg["event"] == {"title": "Work", "start": int(start.timestamp() * 1000)} and sg["alarm_at"] == want_alarm, (sg, want_alarm)
assert sg["message"] == "You have Work at 10:00 AM tomorrow. Get-off alarm at 5:00 AM?", sg["message"]
up = call("GET", "/api/schedule/upcoming?days=2", MOM, tz=TZ)
assert all(e["source"] == "manual" and e["title"] == "Work" and not e["all_day"] for e in up) and int(start.timestamp() * 1000) in [e["start"] for e in up], up
# an alarm already near that time: no suggestion
near = call("POST", "/api/alarms", MOM, tz=TZ, json={"label": "Mine", "kind": "alarm", "at": want_alarm + 30 * 60_000})
assert call("GET", "/api/schedule/suggestion", MOM, tz=TZ) is None
call("DELETE", f"/api/alarms/{near['id']}", MOM)
assert call("GET", "/api/schedule/suggestion", MOM, tz=TZ)["alarm_at"] == want_alarm
# turned off, then on; then declined for tomorrow
call("PUT", "/api/schedule", MOM, json={"suggest": False})
assert call("GET", "/api/schedule/suggestion", MOM, tz=TZ) is None
call("PUT", "/api/schedule", MOM, json={"suggest": True})
assert call("GET", "/api/schedule/suggestion", MOM, tz=TZ) is not None
call("POST", "/api/schedule/suggestion/decline", MOM, tz=TZ)
assert call("GET", "/api/schedule/suggestion", MOM, tz=TZ) is None
print("suggestion from a work schedule: right time and message; hidden by a nearby alarm, off, or decline")

# ---- a calendar link (ICS over local HTTP)
BER = ZoneInfo("Europe/Berlin")
bd = datetime.now(BER).date()
fmt = lambda d, hm: f"{d:%Y%m%d}T{hm}00"
d1, d2, d8 = bd + timedelta(days=1), bd + timedelta(days=2), bd + timedelta(days=8)
day = lambda d: ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d.isoweekday() % 7]
nyd = datetime.now(NY).date() + timedelta(days=1)
ICS = "\r\n".join([
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VTIMEZONE", "TZID:Europe/Berlin", "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:standup@test", "SUMMARY:Stand\\, up",
    f"DTSTART;TZID=Europe/Berlin:{fmt(bd - timedelta(days=13), '0900')}",
    f"DTEND;TZID=Europe/Berlin:{fmt(bd - timedelta(days=13), '0930')}",
    f"RRULE:FREQ=WEEKLY;BYDAY={day(d1)},{day(d2)}",
    f"EXDATE;TZID=Europe/Berlin:{fmt(d2, '0900')}",
    "BEGIN:VALARM", "TRIGGER:-PT15M", "SUMMARY:not this", "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT", "UID:dentist@test", "SUMMARY:Dentist",
    f"DTSTART:{fmt(nyd, '0800')}", "DURATION:PT1H", "END:VEVENT",
    "BEGIN:VEVENT", "UID:cancel@test", "SUMMARY:Cancelled thing", "STATUS:CANCELLED",
    f"DTSTART:{fmt(nyd, '1200')}Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:hol@test", "SUMMARY:Holi",
    " day", f"DTSTART;VALUE=DATE:{nyd:%Y%m%d}", "END:VEVENT",
    "END:VCALENDAR", ""])

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/cal.ics":
            body = ICS.encode()
            self.send_response(200); self.send_header("content-type", "text/calendar"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path == "/page":
            body = b"<html>hello</html>"
            self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers()
    def log_message(self, *a): pass
srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

url = f"http://127.0.0.1:{port}/cal.ics"
sch = call("PUT", "/api/schedule", CAL, tz=TZ, json={"calendar_url": url})
assert sch["calendar"]["set"] and sch["calendar"]["error"] is None and sch["calendar"]["fetched_at"], sch
assert url not in json.dumps(call("GET", "/api/schedule", CAL)), "the private link is never sent back"
up = call("GET", "/api/schedule/upcoming?days=3", CAL, tz=TZ)
ms = lambda d, h, m, tz: int(datetime(d.year, d.month, d.day, h, m, tzinfo=tz).timestamp() * 1000)
timed = [(e["title"], e["start"], e["end"]) for e in up if not e["all_day"]]
want = sorted([("Stand, up", ms(d1, 9, 0, BER), ms(d1, 9, 30, BER)), ("Dentist", ms(nyd, 8, 0, NY), ms(nyd, 9, 0, NY))], key=lambda x: x[1])
assert timed == want, (timed, want)
hol = [e for e in up if e["all_day"]]
assert len(hol) == 1 and hol[0]["title"] == "Holiday" and hol[0]["start"] == ms(nyd, 0, 0, NY), hol
assert all(e["source"] == "calendar" for e in up)
# a week on, the standup is back (same weekday as d1)
up14 = call("GET", "/api/schedule/upcoming?days=14", CAL, tz=TZ)
assert ms(d8, 9, 0, BER) in [e["start"] for e in up14] and ms(d2, 9, 0, BER) not in [e["start"] for e in up14], "EXDATE skipped, next week kept"
print("calendar link: weekly RRULE + EXDATE + TZID, floating, all-day, cancelled, folded lines")

# ---- bad links
call("PUT", "/api/schedule", CAL, expect=400, json={"calendar_url": "ftp://example.com/cal.ics"})
call("PUT", "/api/schedule", CAL, expect=400, json={"calendar_url": "not a link"})
bad = call("PUT", "/api/schedule", CAL, json={"calendar_url": "http://127.0.0.1:1/nope.ics"})
assert bad["calendar"]["set"] and bad["calendar"]["error"], bad
bad = call("PUT", "/api/schedule", CAL, json={"calendar_url": f"http://127.0.0.1:{port}/gone.ics"})
assert "404" in bad["calendar"]["error"], bad
bad = call("PUT", "/api/schedule", CAL, json={"calendar_url": f"http://127.0.0.1:{port}/page"})
assert "calendar" in bad["calendar"]["error"].lower(), bad
# webcal:// is accepted (and turned into https://)
wc = call("PUT", "/api/schedule", CAL, json={"calendar_url": "webcal://127.0.0.1:1/cal.ics"})
assert wc["calendar"]["set"] and wc["calendar"]["error"], wc
off = call("PUT", "/api/schedule", CAL, json={"calendar_url": None})
assert off["calendar"] == {"set": False, "error": None, "fetched_at": None}, off
assert call("GET", "/api/schedule/upcoming", CAL) == []
print("bad calendar links: friendly error kept on the schedule")

print("ALL OK")
