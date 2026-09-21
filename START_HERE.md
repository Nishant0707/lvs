# Start here — updated video-call edition

Two modes are included:

- **Custom video calls:** http://localhost:4000/call.html — browser WebRTC + your authenticated Socket.IO signaling, without a LiveKit server or a paid media API.
- **LiveKit studio:** http://localhost:4000 — improved UI with automatic media connection on join and disabled microphone controls until connected. Keep this mode for the assignment's mandatory LiveKit demonstration.

## Update your existing project

Stop `npm run dev` with Ctrl+C. Back up your old project folder. Extract this package and copy its contents into `D:\Codes\lvs-live-platform`, replacing source files. The ZIP contains no `.env` and no `node_modules`.

Keep your own MongoDB connection string. Rotate the database password and any actual LiveKit credentials that were pasted in chat. Never commit `.env`.

Your earlier `LIVEKIT_URL=wss` was not a valid URL. If starting with the custom video mode, use these valid local placeholders in `.env` so the existing backend configuration can load:


These are development placeholders, not cloud credentials. The custom `/call.html` page does not call the LiveKit token endpoint. It still requires the backend, MongoDB and Redis. To use LiveKit Cloud later, replace all four values with the full URL and matching credentials from your own project.

Replace `JWT_SECRET` with a random value of at least 32 characters. Generate one locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

From the project folder:

```powershell
npm ci
docker compose up -d redis
npm run dev
```

If Redis already runs locally, the Docker command is unnecessary. `npm run dev` now automatically builds BOTH browser pages before starting the backend.

## First custom video-call test

1. Open http://localhost:4000/call.html in a normal browser window and an incognito window.
2. Register/sign in with two different accounts.
3. First account: create a video room and allow camera/microphone permission. Uncheck the camera option before joining if your device has no camera or cannot share it between sessions.
4. Copy the room ID. Second account: paste it and click Join video room.
5. Each user clicks Unmute when ready. The camera starts according to the checkbox; microphone starts muted.
6. Use headphones. Click Enable sound if the browser blocks playback. Leave closes connections and stops local capture.

The native room type is `call`; existing `voice` and `stream` rooms belong to the LiveKit studio. Invalid camera permissions are browser/device issues and are shown in the page's error box.

## Network boundary

Native calls default to **no external ICE servers**. Test on localhost first. Direct connections may work on a LAN, but remote browser access requires HTTPS and callers behind different networks may need your own STUN/TURN service. This is a small mesh-call prototype, recommended for 2–4 users, not a replacement for the scalable LiveKit/SFU architecture required by the assignment. No public-network media success is claimed here.

## LiveKit mode

Start the optional media profile: `docker compose --profile media up -d livekit`.

When Node runs on Windows instead of in Docker, change the webhook URL in `deploy/livekit.yaml` to `http://host.docker.internal:4000/webhooks/livekit` and restart LiveKit. Full-container setup uses the supplied `http://backend:4000/webhooks/livekit`.

Read `docs/VERIFICATION.md` for tested scope and outstanding runtime checks. Do not submit only the custom WebRTC page: the assignment explicitly requires a real LiveKit connection too.
