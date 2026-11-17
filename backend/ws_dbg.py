import asyncio, websockets
async def main():
    url = "ws://127.0.0.1:9119/api/pty?session_id=test-relay2&token=demo-relay-token-123"
    try:
        async with websockets.connect(url, open_timeout=8, origin=None) as ws:
            await ws.send("HAI\n")
            resp = await asyncio.wait_for(ws.recv(), timeout=8)
            print("WS OK:", repr(resp)[:120])
    except Exception as e:
        print("WS FAIL:", str(e)[:200])
asyncio.run(main())
