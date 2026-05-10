# Photonic Platform Frontend

Next.js (App Router) chat + dashboard front-end for the Photonic Platform —
talks to the n8n B flow (Chat Query Router) for routing, the IPKISS API for
simulations, and the GDS Analysis API for layout previews.

Sister repo: [photonic-platform](https://github.com/Wayne-55615/photonic-platform) (backend stack).

## Local development

```bash
npm install
cp .env.local.example .env.local      # then edit .env.local
npm run dev
```

Open <http://localhost:3000>.

The default values in `.env.local.example` assume the standard local stack:

| Service | Port | Purpose |
|---|---|---|
| n8n | 5678 | Webhook router (B flow) + sub-workflows |
| IPKISS API | 8000 | Photonic simulation backend |
| Ollama | 11434 | LLM (llama3.1:8b) + embedding (nomic-embed-text) |
| GDS Analysis API | 8200 | GDS preview / cell extraction |
| Postgres | 5432 | sim_run / llm_summary / gds_structures |

## Pages

| Route | What it does |
|---|---|
| `/` | Main chat — talks directly to `NEXT_PUBLIC_N8N_WEBHOOK_URL` |
| `/abstats` | A vs B flow comparison stats (with `?batch_id=` filter) |
| `/stats` | Overall sim_run review verdict charts |
| `/spectrum/<filename>` | Standalone S-parameter Touchstone viewer |

## Environment variables

See [`.env.local.example`](./.env.local.example) for the full list. Two-tier convention:

* `NEXT_PUBLIC_*` — exposed to the browser (chat webhook, A flow URL)
* others — server-side only (IPKISS / Ollama / Postgres / filesystem paths)

## Deploying to Vercel

This frontend is statically connected to local backend services by default.
To deploy on Vercel and still reach the local n8n / IPKISS / Ollama / GDS API,
expose them through a tunnel (cloudflared / ngrok / Tailscale Funnel) and set
the corresponding env vars in the Vercel project.

### 1. Tunnel the local services

Recommended: **Cloudflare Tunnel** — free, persistent URL, no port-forwarding.

Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
authenticate (`cloudflared tunnel login`), then create one tunnel that
exposes all four services. Example `~/.cloudflared/config.yml`:

```yaml
tunnel: photonic-platform
credentials-file: /Users/you/.cloudflared/photonic-platform.json

ingress:
  - hostname: n8n.example.com
    service: http://localhost:5678
  - hostname: ipkiss.example.com
    service: http://localhost:8000
  - hostname: ollama.example.com
    service: http://localhost:11434
  - hostname: gds.example.com
    service: http://localhost:8200
  - service: http_status:404
```

Run:

```bash
cloudflared tunnel route dns photonic-platform n8n.example.com
cloudflared tunnel route dns photonic-platform ipkiss.example.com
cloudflared tunnel route dns photonic-platform ollama.example.com
cloudflared tunnel route dns photonic-platform gds.example.com
cloudflared tunnel run photonic-platform
```

Quick alternative: **ngrok** (free, ephemeral URL). Run four sessions or use
ngrok's reserved-domain feature for stable URLs.

### 2. Configure Vercel env vars

In **Vercel → Project → Settings → Environment Variables**, set:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_N8N_WEBHOOK_URL` | `https://n8n.example.com/webhook/invoke_n8n_agent` |
| `NEXT_PUBLIC_A_FLOW_URL` | `https://n8n.example.com/webhook/a/agent-chat` |
| `N8N_URL` | `https://n8n.example.com` |
| `IPKISS_URL` | `https://ipkiss.example.com` |
| `OLLAMA_URL` | `https://ollama.example.com` |
| `GDS_API_URL` | `https://gds.example.com` |
| `DATABASE_URL` | `postgres://user:pass@your-db-host/db` (use a tunneled or cloud DB) |

`/api/results` reads files directly from the local Windows filesystem
(`D:/photonic-platform/...`) and **won't work on Vercel** unless you mount
the same directory. For now, just don't rely on s4p/gds download buttons in
the deployed UI — sim runs themselves still work.

### 3. Auto-deploy on push

After connecting the repo to Vercel:

```bash
git add -A
git commit -m "..."
git push
```

Every push to `main` triggers a fresh build + deploy.

## Development notes

* `app/page.tsx` is a 6,000-line monolith holding all chat / GDS / spectrum /
  replay / optimize / calibrate state. Yes, this is intentional — replay and
  optimize loops need shared visualization state.
* `components/SnpChart.tsx` is the main spectrum chart; `SnpHtmlViewer.tsx`
  is the standalone variant for `/spectrum/<filename>`.
* Bilingual UI labels (`中文 / English`) — see strings in pages and components.
