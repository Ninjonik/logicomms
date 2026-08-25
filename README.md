# LogiComms

LogiComms is a Tauri v2 desktop app with a React frontend and a local Node/Express control plane. It creates short-lived LiveKit rooms with one-word session codes and exposes a press-to-talk matrix for whisper routing.

## Stack

- Desktop: Tauri v2, React 19, TypeScript, Tailwind CSS
- Local backend: Node.js, Express, SQLite via `better-sqlite3`
- Realtime media: LiveKit
- Global keybinds: `@tauri-apps/plugin-global-shortcut`

## Prerequisites

- Rust and Tauri prerequisites installed locally
- Bun installed for frontend and Tauri scripts
- A LiveKit deployment with API key, secret, and webhook support

## Run locally

1. Install dependencies:

```bash
bun install
```

2. Configure the backend:

```bash
cp backend/.env.example backend/.env
```

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. The backend defaults to `http://localhost:3000`.

3. Start the local backend:

```bash
bun run backend:dev
```

4. In a second terminal, start the desktop app:

```bash
bun run tauri dev
```

If your frontend needs a different backend URL, set `VITE_API_URL`.

## Notes

- Session codes are stored in SQLite and released when the corresponding LiveKit room becomes empty.
- The current client publishes a temporary microphone track tagged with the selected whisper target. Hard recipient isolation still requires tighter LiveKit-side permission and routing policy.
- On Windows, run the packaged `.exe` as Administrator if you need global key capture to work over anti-cheat protected games.

## API

- `POST /api/session/create`
- `POST /api/session/join`
- `POST /api/webhooks/livekit`
- `GET /api/health`
