# AI_Agent_KL

A browser-based interface for your **local Hermes AI Agent**. The website is hosted on Vercel, connects to your existing local Hermes installation through Cloudflare Tunnel — no port forwarding, no direct public exposure.

**AI_Agent_KL** = the user interface (Vercel)  
**Hermes** = the brain (local)  
**Your laptop** = the execution host  
**Cloudflare Tunnel** = secure connection between them

> All AI interactions are processed by your actual local Hermes Agent (main-model via 9Router, skills, tools, MCP, memory). Nothing interchangeable.

---

## Architecture

```
REMOTE DEVICES (phone/laptop/tablet)
   |
   v
VERCEL HOSTING  ---- Cloudflare Tunnel ---->  LOCAL WINDOWS LAPTOP
- Next.js chat UI          (secure, authenticating HTTPS)
                                             |
                                             v
                                    LOCAL RELAY (FastAPI)
                                          |
                                          v
                                    HERMES AGENT (v0.22.4)
                                    main-model via 9Router
                                    Skills · Tools · MCP · Memory
```

---

## Project Structure

```
AI_Agent_KL/
├── src/
│   └── app/
│       ├── layout.tsx       # Root layout
│       ├── page.tsx         # Chat app (sidebar + workspace + composer)
│       └── globals.css      # Dark theme + component styles
├── backend/                 # Local relay on your laptop
│   ├── app.py               # FastAPI relay
│   ├── requirements.txt
│   ├── .env.example
│   └── README.md             # (see backend README)
├── .gitignore
├── package.json
├── next.config.ts
├── tsconfig.json
└── vercel.json
```

---

## Local Development

### 1. Start the local relay (on your laptop)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
HERMES_SERVE_URL=http://127.0.0.1:9119 RELAY_PORT=8787 python app.py
```

Make sure `hermes serve` is running (listens on `127.0.0.1:9119`):

```bash
hermes serve --port 9119 --host 127.0.0.1
```

### 2. Start the Next.js app locally

```bash
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000

---

## Vercel Deployment

1. Push the repo to GitHub/GitLab.
2. Import into Vercel → `npm run build` (output `.next`).
3. Set env `NEXT_PUBLIC_RELAY_URL` = your Cloudflare Tunnel URL (e.g. `https://agent-kl.example.com`).
4. Cloudflare Tunnel exposes your laptop's relay.

> Tunnel connects your VERCEL DOMAIN → local laptop's relay.

### Cloudflare Tunnel (on the laptop)

```yaml
# config.yml
tunnels:
  agent-kl:
    url: http://127.0.0.1:8787
    originRequest:
      disableProxyProtocol: true
    credentials-src: cloudflare
```

```bash
cloudflared tunnel --config config.yml run agent-kl
```

Prod: https://your-domain.example.com → laptop relay :8787.

### Auth (recommended)
- HTTPS + Cloudflare Tunnel hides the relay from the public internet.
- Add password/OAuth on `hermes serve` (required for public binds) and a shared `HERMES_DASHBOARD_SESSION_TOKEN` between relay and hermes serve.
- Frontend is token-free: Vercel only needs `NEXT_PUBLIC_RELAY_URL`.

---

## Using the Interface

- Sidebar: conversation history (pulled from Hermes `state.db`), search, new chat, rename, delete.
- Chat: streaming responses, markdown/code, activity panel (tool/thinking events).
- Desktop: model chip showing your real 9Router model.

> File/image attachment via PID is supported by `hermes serve` but UI wiring is marked `TODO`.

---

## Zero-Cost Architecture

- Vercel Hobby for frontend (free).
- Cloudflare Tunnel Free for remote connectivity.
- Existing local Hermes runtime + 9Router model/credentials.
- Existing installed Hermes skills and tools.
- Zero third-party subscriptions; only electricity + internet + existing model usage.

---

## LICENSE

MIT
