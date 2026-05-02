# Driven

A Discord-like chat app — web + desktop, real-time, invite-only servers, friends, DMs.

## Run locally

```bash
npm install
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64'))") \
NODE_ENV=production npm start
```

Open http://localhost:3000.

### Windows one-shot

`setup.bat` (admin) installs Node + ngrok and writes `.env`. `start.bat` runs the
server and opens an ngrok tunnel.

### Desktop dev

```bash
npm run desktop
```

## Production checklist

- `JWT_SECRET` must be set (server refuses to start otherwise).
- `NODE_ENV=production` enables HSTS and `Secure` cookies.
- Put behind HTTPS (ngrok, Caddy, nginx). Set `TRUST_PROXY=1`.
- Persist `DB_PATH` to a writable volume.
- Health check: `GET /healthz`.

### Docker

```bash
docker build -t driven .
docker run -p 3000:3000 -e JWT_SECRET=... -v driven-data:/data driven
```

## Desktop builds

GitHub Actions builds Windows / macOS / Linux on every push and attaches
artifacts. Push a `v*` tag to publish a GitHub Release.

```bash
npm run dist:win    # NSIS + portable .exe
npm run dist:mac    # .dmg + .zip (x64 + arm64)
npm run dist:linux  # AppImage + .deb
```

### iOS / Android

Not in this repo. Electron does not target mobile. The web client works on
mobile browsers; a real iOS/Android client would need a separate Capacitor or
React Native shell pointing at the same server. Happy to scaffold it on
request.
