# Driven Mobile (Capacitor)

Wraps the Driven web client as native iOS + Android apps. The shell loads
your live server (ngrok URL or production domain) — there is no offline
client; the same backend serves web and mobile.

## One-time setup

```bash
cd mobile
npm install
# Edit capacitor.config.json: set "server.url" to your HTTPS server URL
npm run add:android   # requires Android Studio + JDK 17
npm run add:ios       # requires macOS + Xcode
```

The `www/` folder is generated from the project's `public/` on each sync.

## Develop

```bash
# from repo root: copy public/ -> mobile/www/ then sync
node -e "require('fs').cpSync('public','mobile/www',{recursive:true})"
cd mobile && npx cap sync
npm run open:android   # or open:ios
```

## Release

- **Android:** `npm run build:android` → `android/app/build/outputs/apk/release/`.
  Sign with your keystore (set `KEYSTORE_*` env vars in
  `android/app/build.gradle` or use Android Studio's Generate Signed Bundle).
- **iOS:** open in Xcode, set your team, Archive → Distribute. Needs Apple
  Developer Program ($99/yr).

## Pointing at your server

Edit `capacitor.config.json` `server.url`. For ngrok, use the HTTPS URL
(`https://xxx.ngrok-free.app`). For production, use your real domain.
Cookies require HTTPS — `COOKIE_SECURE=1` on the server.
