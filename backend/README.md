# AI_Agent_KL

Next.js chat frontend + local Hermes relay.

## Local dev

```bash
# 1) local relay (backend/app.py) on laptop
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
HERMES_SERVE_URL=http://127.0.0.1:9119 RELAY_PORT=8787 python app.py

# 2) next app
cp .env.example .env.local
npm run dev
```

## Build

```bash
npm run build
```

## Env (Vercel)

- NEXT_PUBLIC_RELAY_URL — relay public URL
- NEXT_PUBLIC_AUTH_TOKEN — optional bearer token shared with relay

## LICENSE

MIT
