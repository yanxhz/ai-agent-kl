import asyncio, os, websockets

async def main():
    os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = "demo-relay-token-123"
    url = "ws://127.0.0.1:9119/api/pty?session_id=test-token&token=demo-relay-token-123"
    print("connecting to:", url)
    try:
        async with websockets.connect(url, open_timeout=10) as ws:
            print("CONNECTED OK")
            await ws.send("HAI\n")
            resp = await asyncio.wait_for(ws.recv(), timeout=8)
            print("RECV:", repr(resp)[:300])
    except Exception as e:
        print("ERROR:", type(e).__name__, str(e)[:400])

asyncio.run(main())
