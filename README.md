# Digital Dashboard

A one-page dashboard for projects, team resourcing and todos, behind a password.

## Stack

- **Frontend:** a single HTML file (`public/index.html`) with plain HTML, CSS and JavaScript. No framework, no build step.
- **Server:** Node.js 18+ with no dependencies (`server.js`). It handles the password login and saves data to a JSON file.
- **Data:** `data/db.json` on the server, created on first save. Back this file up.

## Run it

```bash
cp .env.example .env      # then set DASHBOARD_PASSWORD in .env
npm start                 # or: node server.js
```

Open `http://your-server:3000` and sign in.

## Settings (`.env`)

| Key | What it does |
| --- | --- |
| `DASHBOARD_PASSWORD` | The login password. Changing it signs everyone out. |
| `PORT` | Port to listen on (default 3000). |
| `DATA_FILE` | Where data is saved (default `data/db.json`). |
| `SESSION_DAYS` | How long a sign-in lasts (default 30). |
| `SECURE_COOKIE` | `true` when served over HTTPS. |
| `TRUST_PROXY` | `true` when behind Nginx, Caddy or similar. |

Restart the server after editing `.env`.

## Run with Docker

```bash
cp .env.example .env      # then set DASHBOARD_PASSWORD in .env
docker compose up -d
```

Data is kept in the `dashboard-data` volume, so it survives rebuilds. The dashboard is served on port 80, so open `http://your-server` with no port number.

Every push to `main` publishes a new image to `ghcr.io/sallihin/digital-dashboard:latest` (see `.github/workflows/docker-publish.yml`). Redeploy once the action finishes to pick it up. To build locally instead, run `docker build -t ghcr.io/sallihin/digital-dashboard:latest .` first.

**Hostinger Docker Manager:** choose *Compose from URL*, paste
`https://raw.githubusercontent.com/sallihin/digital-dashboard/main/docker-compose.yml`,
and add `DASHBOARD_PASSWORD` under environment variables.

## Keep it running (example with pm2)

```bash
npm install -g pm2
pm2 start server.js --name digital-dashboard
pm2 save && pm2 startup
```

## Security notes

- Put the site behind HTTPS (e.g. Caddy or Nginx with Let's Encrypt) and set `SECURE_COOKIE=true` and `TRUST_PROXY=true`.
- After 8 wrong passwords, an IP is locked out for 15 minutes.
- `.env` and `data/` are git-ignored, so the password and your data never go into the repo.
