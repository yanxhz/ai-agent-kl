import asyncio, sys
sys.path.insert(0, ".")
from app import HermesPtyBridge

async def main():
    b = HermesPtyBridge("dbg-session", "http://127.0.0.1:9119")
    print("connecting...", flush=True)
    try:
        await b.connect()
        print("connected OK", flush=True)
    except Exception as e:
        print("CONNECT FAIL:", type(e).__name__, str(e)[:300], flush=True)
        return
    print("sending...", flush=True)
    try:
        await b.send("HAI\n")
        print("sent OK", flush=True)
    except Exception as e:
        print("SEND FAIL:", type(e).__name__, str(e)[:300], flush=True)
        return
    print("reading...", flush=True)
    try:
        n=0
        async for raw in b.events():
            n+=1
            print(f"RECV[{n}]:", repr(raw)[:120], flush=True)
            if n>=3: break
    except Exception as e:
        print("READ FAIL:", type(e).__name__, str(e)[:300], flush=True)
    finally:
        await b.close()
    print("done", flush=True)

asyncio.run(main())
