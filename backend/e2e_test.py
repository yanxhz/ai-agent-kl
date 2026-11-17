import asyncio, json, urllib.request

def post_chat(session_id, message):
    body = json.dumps({"session_id": session_id, "message": message}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8790/api/chat",
        data=body, headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=90)
    return resp

print("sending chat...", flush=True)
try:
    resp = post_chat("local-e2e2", "Halo, kamu siapa? balas singkat aja.")
    print("status:", resp.status, flush=True)
    # read SSE
    data = resp.read().decode(errors="replace")
    print("body length:", len(data), flush=True)
    # split by double newline
    for seg in data.split("\n\n"):
        if seg.startswith("event:"):
            print(seg[:200], flush=True)
except Exception as e:
    print("ERROR:", type(e).__name__, str(e)[:300], flush=True)
