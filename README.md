# LVS Live Platform

**Updated video-call edition:** read [START_HERE.md](START_HERE.md). Custom calls are at `/call.html`; the LiveKit studio remains at `/`.

A TypeScript backend for the LVS Innovation live-streaming and group-voice assignment, with a small browser demo for real media connections.

**Stack:** Node.js 22, Express 5, TypeScript, MongoDB/Mongoose, Redis, Socket.IO, LiveKit, Docker Compose, GitHub Actions. The lockfile pins the resolved npm dependency tree.

## Start locally with Docker (recommended)

Install Node.js 22 if running outside Docker, plus Docker Desktop with Linux containers (Windows/macOS) or Docker Engine + Compose (Linux).

```bash
cp .env.example .env
docker compose --profile media up --build -d
docker compose ps
```

PowerShell: use `Copy-Item .env.example .env` for the first command. Run all commands from this project directory.

Open **http://localhost:4000**. Use two browser sessions and two accounts. Create a room, join it in both windows, media connects automatically after joining; then enable microphone/camera where allowed. On localhost browsers allow media access; remote use needs HTTPS. The default local media profile includes public development keys in `deploy/livekit.yaml`; keep `.env` aligned with them for this local setup only.

- `voice`: everyone may publish microphone audio; camera is prohibited by the token.
- `stream`: host can broadcast; guests subscribe only.
- Host ownership persists even when the host leaves. Active rooms end only through the host end API.
- A socket disconnect changes presence; it does not remove durable room membership.

Local Compose exposes services only on loopback. Redis and Mongo use named volumes. `docker compose down` preserves data; `down -v` destroys development data. Never run this local configuration as public production infrastructure.

## Run the API outside Docker

```bash
docker compose --profile media up -d mongo redis livekit
npm ci
npm run build
npm run dev
```

Use `.env.example` defaults for host-run Mongo/Redis/LiveKit. For **webhooks** with a host-run API, change `deploy/livekit.yaml` URL to `http://host.docker.internal:4000/webhooks/livekit` (Docker Desktop); on Linux add the appropriate host-gateway mapping. Restart LiveKit. Alternatively run the full Compose stack so the built-in `http://backend:4000` webhook URL resolves.

## Use LiveKit Cloud

Set `LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud`, `LIVEKIT_API_URL=https://YOUR_PROJECT.livekit.cloud`, and your API key/secret in `.env`. For containerized API, remove the fixed `LIVEKIT_API_URL` override from local `docker-compose.yml` or replace it with your Cloud API URL. Start `docker compose up --build -d` without the media profile. Register `/webhooks/livekit` as a public HTTPS webhook endpoint in your own LiveKit project. Never send API secrets to the browser.

## API

Successful responses use `{success:true,data:...}`. Errors use `{success:false,error:{code,message,details?}}`. Authentication is `Authorization: Bearer <JWT>`. User registration/login returns a one-hour app JWT. LiveKit tokens are separate and scoped to one room.

| Method | Route                    | Purpose                                                       |
| ------ | ------------------------ | ------------------------------------------------------------- |
| POST   | `/auth/register`         | Name, email, password, optional HTTPS profileImage            |
| POST   | `/auth/login`            | Email/password login                                          |
| GET    | `/users/me`              | Current profile and Redis-derived online status               |
| POST   | `/rooms`                 | `{name,mode:'voice' or 'stream'}`; host automatically joins   |
| GET    | `/rooms?page=1&limit=20` | Active rooms; limit max 50                                    |
| GET    | `/rooms/:id`             | Room DTO, participants, count and presence snapshot           |
| POST   | `/rooms/:id/join`        | Idempotent membership join                                    |
| POST   | `/rooms/:id/leave`       | Idempotent membership leave and media removal                 |
| POST   | `/rooms/:id/end`         | Host-only room end and media-room deletion                    |
| POST   | `/livekit/token`         | `{roomName}`; optional userId/role are checked, never trusted |
| POST   | `/webhooks/livekit`      | Signed LiveKit raw webhook                                    |
| GET    | `/health/live`           | Process liveness                                              |
| GET    | `/health/ready`          | MongoDB + Redis readiness                                     |
| GET    | `/openapi.json`          | OpenAPI document                                              |

`roomName` means the opaque `roomName` returned by the room API, not the display `name` or MongoDB `id`.

```json
{
  "success": true,
  "data": {
    "token": "LIVEKIT_JWT",
    "serverUrl": "ws://localhost:7880",
    "roomName": "room-UUID",
    "role": "participant",
    "expiresIn": 120
  }
}
```

Import [OpenAPI](docs/openapi.json) into Postman/Swagger Editor. See [socket contract](docs/SOCKETS.md) for the mandatory real-time events and reconnect behavior. The API does not accept a caller-selected host ID or privileged role. Errors distinguish validation (400), unauthenticated (401), forbidden (403), missing room (404), conflicts/capacity (409), limits (429), and failed media cleanup (503).

## Tests and quality checks

```bash
npm ci
npm run check
npm run test:integration
npm run test:realtime
```

`check` runs ESLint, strict backend TypeScript build, demo bundling, and unit/security tests. Integration tests are explicitly opted in and use a **real MongoDB process** (mongodb-memory-server downloads a disposable binary if no test URI is supplied) and a **real Redis server on localhost**, isolated to logical database 15. Ensure Redis is running. This suite drops the `lvs_test` database and flushes Redis DB 15: never point it at shared or production data.

CI supplies MongoDB and Redis service containers and runs all suites. `test:realtime` independently tests real Redis and Socket.IO across two workers, with durable membership stubbed so transport can be verified without MongoDB. Integration checks include auth, idempotent concurrent joins, forged role/identity rejection, cross-instance room events, subscription isolation, multi-tab presence, signed webhook deduplication, and host-only room ending. Media removal calls are mocked in integration tests; actual signed token generation is exercised. See [verification](docs/VERIFICATION.md) for exactly what was run here and what still needs manual demonstration.

## Security and production boundaries

Passwords use bcrypt cost 12 with a 72-byte cap. JWT verification fixes algorithm, issuer, audience and expiry. Zod rejects unexpected body fields. Helmet, restricted origins, small request bodies, Redis-backed HTTP/socket rate limits, no token logging, non-root image, readiness checks and graceful shutdown are included. Tokens stay in browser memory in the demo. Sign-out discards the local JWT and disconnects; it does not revoke the JWT server-side. There is no refresh-token, email verification, upload storage, moderation or account-recovery subsystem in this assignment scope.

Persistent membership and transient presence are intentionally separate. Chat and Socket.IO notifications are best-effort live events. Room history is capped at 500 actions. Room capacity is 100. Host end/leave requests can return 503 after membership is committed if LiveKit is unreachable; retry the request. Short-lived tokens are not instant revocation; signed admission webhooks remove users who are no longer authorized. Read the [architecture document](docs/ARCHITECTURE.md) for failure/recovery tradeoffs before calling this production-ready.

## Scale from 100 to 10,000+ concurrent users

10,000 connections is a load-test target, not a measured capacity claim. Also distinguish 10,000 users spread across rooms from 10,000 publishers/viewers in one room.

| Component      | Scaling approach                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend        | Run stateless API replicas behind a load balancer. Autoscale on CPU, latency, event-loop delay and connection count; bound DB pools and bcrypt concurrency. Separate auth/REST from socket workers if load warrants it.                                                                                                                                             |
| WebSocket      | Redis adapter already supports cross-instance rooms. Keep WebSocket-only transport, or add sticky sessions when allowing polling. Drain connections during rolling deploys; clients reconnect, rejoin and refetch snapshots. Add a durable outbox/stream if reliable replay is required.                                                                            |
| Redis          | Use a private HA deployment with failover, monitoring, appropriate persistence and memory limits. Separate ephemeral presence/rate state from messaging at larger scale. Before Redis Cluster, redesign Lua keys for hash slots and adopt a compatible sharded Socket.IO adapter; the current scripts target standalone Redis.                                      |
| MongoDB        | Replica set with backups and monitored pools/indexes. Replace offset pagination with cursor pagination at scale. For large rooms, normalize memberships with a unique `(roomId,userId)` index and transactional/outbox updates instead of embedded arrays. Partition append-only history and apply retention. Shard only after measuring access patterns.           |
| LiveKit        | Media traffic bypasses Node. Use LiveKit Cloud or dedicated regional SFU nodes with reachable UDP/TURN, capacity planning, simulcast/adaptive subscriptions and bandwidth monitoring. More API replicas do not increase a single media room's capacity. Plan SFU/room placement and viewer fanout separately; consider egress/CDN for very large passive audiences. |
| Load balancing | TLS termination, upgrade headers, idle timeouts above heartbeat intervals, health checks and connection draining. Place API workers near Redis/Mongo and media nodes near users.                                                                                                                                                                                    |
| Infrastructure | Managed secrets, CI-tested immutable images, staged deploys, private networking, monitoring/alerts and backup restoration drills. Load-test connection churn, room hotspots, media bandwidth and dependency failures with k6/Artillery plus real WebRTC workloads before claiming 10k support.                                                                      |

## Submission material

- [Architecture](docs/ARCHITECTURE.md)
- [Ubuntu / Nginx / HTTPS deployment](docs/DEPLOYMENT.md)
- [8-minute recording walkthrough](docs/RECORDING_GUIDE.md)
- [Submission checklist](docs/SUBMISSION.md)
- [Verification record](docs/VERIFICATION.md)

A GitHub repository URL, uploaded screen recording, and public staging deployment must be supplied from your own accounts. No credentials or public deployment are fabricated in this package.

Integration references: [LiveKit tokens](https://docs.livekit.io/frontends/reference/tokens-grants/), [LiveKit webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/), [Socket.IO Redis adapter](https://socket.io/docs/v4/redis-adapter/).
