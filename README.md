# DigiMed Connect — Realtime Service

Socket.IO chat and notifications, plus internal OTP delivery, for DigiMed Connect.

Spring `healthcare-backend` calls this service with `X-Internal-Key`. The web app connects with `REACT_APP_REALTIME_URL` and `src/services/realtime.js`. JWT auth, the `X-Internal-Key` header, and the Socket.IO v4 event names stay the same. Appointment chat now requires a participant check.

## Upgrade notes (1.2.0)

- Chat rooms are no longer open to every valid JWT. `chat:join` and `chat:message` are denied unless the caller is a participant of that appointment. Denial emits `chat:error` and does not join the room. See [Chat access](#chat-access).
- CORS no longer accepts `https://*.vercel.app` or any other wildcard. Set explicit origins in `ALLOWED_ORIGINS` (legacy name: `CORS_ORIGINS`). The default, when neither variable is set, is `https://digimed-connect.co.za,https://www.digimed-connect.co.za`. The same list is applied to Express and to the Socket.IO handshake.
- `TRUST_PROXY` is a hop count. Production defaults to `1` (Railway). It is never boolean `true`, so rate limits use `req.ip` (the right-most untrusted `X-Forwarded-For` hop) rather than the client-supplied first hop.
- `GET /health` is liveness only (`status`, `service`). Provider names (`twilio`, `stub`, and the rest) are on `GET /internal/health` behind `X-Internal-Key`.
- OTP codes are stored in Redis with a TTL when `REDIS_URL` is set. Without Redis they stay in memory on this process only, so a second replica cannot verify them.

## Upgrade notes (1.1.0)

- Node 20+ (Docker image `node:22-alpine`). Socket.IO stays on v4 (`socket.io@4.8`) so the existing frontend client keeps the same protocol.
- Express stays on the 4.22 security line so route and error behavior match what Spring and the frontend already use.
- Helmet, JSON body limit (`100kb` by default), and per-IP rate limits on `/internal/*`.
- Structured JSON logs. OTP codes, tokens, and provider secrets are redacted. Message bodies are not logged.
- Production refuses to boot when `OTP_DEBUG_MODE=true`, when `JWT_SECRET` is under 32 characters, or when `INTERNAL_API_KEY` is under 16 characters. A 64+ character `JWT_SECRET` matching Spring is still the DigiMed standard.
- JWTs are verified as HMAC only (`HS256`, `HS384`, `HS512`). Claim names are the same: `sub` / `username`, `tenantId`, `userId`, `roles`.
- Optional Resend email (`RESEND_API_KEY` + `RESEND_FROM`) beside SMTP. Choose with `EMAIL_PROVIDER`.
- Optional Redis adapter when `REDIS_URL` is set. In production a configured Redis that cannot be reached stops startup, so replicas do not silently split.
- `GET /ready` reports configuration with booleans only. Delivery provider names are not part of the public health payload.
- No `VOLUME` instruction in the Dockerfile (Railway Railpack rejects it). Mount a Railway Volume at `/app/data/baileys-auth` for Baileys.

## Run locally

```bash
cp .env.example .env
# Set JWT_SECRET to the SAME value as Spring JWT_SECRET
npm install
npm start
```

`npm test` runs the health, internal-auth, and OTP stub checks.

Default: `http://localhost:4001`

## Deploy on Railway

1. Open [Railway](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select repo `Immortal8725/node-realtime-service`
3. Railway builds with the included `Dockerfile` (`railway.json` builder is `DOCKERFILE`)
4. **Networking** → Generate Domain (for example `https://….up.railway.app`)
5. **Variables** — set the table below. Leave `PORT` unset; Railway injects it.
6. Health check: `GET https://YOUR-RAILWAY-HOST/health` → `{ "status": "ok", "service": "node-realtime-service" }`
7. Readiness: `GET https://YOUR-RAILWAY-HOST/ready` → `{ "status": "ready" }` when secrets are set and Redis is connected if `REDIS_URL` is set
8. Set `HEALTHCARE_BACKEND_URL` so appointment chat can ask Spring whether the caller is a participant. Without it, chat requires an appointment-scoped JWT claim or `appointmentToken` (see below).

### Baileys volume

Do not add a Dockerfile `VOLUME`. In the Railway service settings, attach a Volume mounted at `/app/data/baileys-auth`. Keep **one replica** while `WHATSAPP_PROVIDER=baileys` — one WhatsApp session cannot be shared. Redis can still fan out Socket.IO, but Baileys itself stays on that single replica.

## Wire DigiMed to Railway

**Frontend**

```text
REACT_APP_REALTIME_URL=https://YOUR-RAILWAY-HOST
```

**Spring backend**

```text
REALTIME_ENABLED=true
REALTIME_BASE_URL=https://YOUR-RAILWAY-HOST
REALTIME_INTERNAL_API_KEY=<same as INTERNAL_API_KEY>
JWT_SECRET=<same as realtime JWT_SECRET>
OTP_PHONE_CHANNEL=sms
```

On the realtime service, set `HEALTHCARE_BACKEND_URL` to the Spring base URL (for example `https://api.digimed-connect.co.za` or the Railway private URL). Spring must expose the participant endpoint below and accept the same `X-Internal-Key`.

Redeploy the frontend and backend after changing env. The Socket.IO client can keep using v4 and the same handshake JWT. It should handle the new `chat:error` event. It only needs to send `appointmentToken` when `HEALTHCARE_BACKEND_URL` is not set and the login JWT is not appointment-scoped.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | public liveness (`status`, `service` only) |
| GET | `/internal/health` | `X-Internal-Key` (version, redis, OTP store, delivery providers) |
| GET | `/ready` | public readiness (booleans only, no keys) |
| POST | `/internal/otp/send` | `X-Internal-Key` |
| POST | `/internal/otp/verify` | `X-Internal-Key` |
| GET | `/internal/whatsapp/status` | `X-Internal-Key` (Baileys QR / link status) |
| POST | `/internal/notify` | `X-Internal-Key` |

`/internal/*` is limited per client IP (`INTERNAL_RATE_LIMIT_PER_MIN`, default 300). OTP send is tighter (`OTP_SEND_RATE_LIMIT_PER_MIN`, default 30).

### `POST /internal/otp/send`

```json
{ "channel": "email|sms|whatsapp", "to": "...", "purpose": "login", "tenantId": 1, "message": "optional", "code": "optional" }
```

When Spring sends `code`, that exact code is delivered and stored for verify. Without a provider the result is `delivery.status: "stubbed"` and `otpSent: true` (local/dev). `debugOtp` is returned only when `OTP_DEBUG_MODE=true`, which production refuses to boot with.

## Socket.IO

Protocol v4, same events as `src/services/realtime.js`:

```js
io("https://YOUR-RAILWAY-HOST", { auth: { token: localStorage.token } })
```

The handshake token is the Spring JWT (`auth.token`, `Authorization`, or `query.token`).

### Rooms / events

- `chat:join` `{ appointmentId, appointmentToken? }` → room `appointment:{id}` only after the participant check
- `chat:message` `{ appointmentId, text, appointmentToken? }`
- `chat:leave` `{ appointmentId }`
- `chat:error` `{ error, message, code, appointmentId? }` when join or send is denied
- `notify:subscribe` → joins `user:{userId}` and `tenant:{tenantId}`
- Server push: `notify:event`
- Internal fan-out: `POST /internal/notify` with `{ target: { userId?, username?, tenantId? }, event }`

`appointmentId` must be a decimal id (up to 18 digits) or a UUID. Anything else is rejected with `code: "invalid_appointment"`.

### Chat access

A valid login JWT is not enough to join an appointment room. The service denies by default.

**Preferred: healthcare-backend lookup.** When `HEALTHCARE_BACKEND_URL` is set, every join and send calls:

```http
GET {HEALTHCARE_BACKEND_URL}/internal/realtime/appointments/{appointmentId}/access?userId={userId}&username={username}&tenantId={tenantId}
X-Internal-Key: <INTERNAL_API_KEY>
Accept: application/json
```

`userId`, `username`, and `tenantId` are taken from the verified socket JWT. Spring must authorize that identity against its own appointment record. Return HTTP 200 and:

```json
{ "allowed": true, "tenantId": 7, "participant": "patient" }
```

`participant` is informational (`patient`, `clinician`, or `staff`). `allowed` must be boolean `true`. When `tenantId` is present it must match the JWT. Any other status, a non-JSON body, `allowed: false`, a tenant mismatch, a timeout, or a network error is a denial. Allows are cached for `CHAT_ACCESS_CACHE_SECONDS` (default 30). Denials are cached for at most 10 seconds. The browser never sees `X-Internal-Key`.

While this URL is set, appointment claims inside the JWT do not override a backend denial.

**Fallback, only when `HEALTHCARE_BACKEND_URL` is unset.** All of the following are required:

- The socket JWT has a numeric `tenantId`.
- The socket JWT has a participant role: `PATIENT`, `DOCTOR`, `NURSE`, `CLINICIAN`, `STAFF`, `ADMIN`, `RECEPTIONIST`, `PRACTICE_MANAGER`, `PHARMACIST`, `PHYSICIAN`, `MIDWIFE`, `THERAPIST`, `TENANT_ADMIN`, or `SUPER_ADMIN` (`ROLE_` is stripped, as before).
- The appointment is scoped by one of:
  - `appointmentId` on the socket JWT
  - `appointmentIds` (array, at most 50) on the socket JWT
  - `appointmentToken` on the `chat:join` / `chat:message` payload

`appointmentToken` is an HMAC JWT (`HS256`, `HS384`, or `HS512`) signed with the same `JWT_SECRET`:

```json
{ "sub": "<same username>", "userId": 11, "tenantId": 7, "appointmentId": 42 }
```

`exp` is enforced. `sub` / `userId` and `tenantId` must match the socket session. Mint a short-lived token per appointment the user may enter. Do not put every appointment a clinician might ever see into the login token unless that list is actually the authorization decision.

Denied calls emit:

```json
{
  "error": "Forbidden",
  "message": "You are not a participant of this appointment",
  "code": "not_a_participant",
  "appointmentId": "42"
}
```

The socket is removed from that appointment room. `chat:leave` only announces presence when the socket was actually in the room.

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | production | `production` enables fail-closed checks and trust-proxy |
| `PORT` | Railway sets it | Listen port (local default `4001`) |
| `JWT_SECRET` | yes | Same secret as Spring. Minimum 32 characters; DigiMed standard is 64+ |
| `INTERNAL_API_KEY` | yes | Same as Spring `REALTIME_INTERNAL_API_KEY`. Minimum 16 characters. Header remains `X-Internal-Key` |
| `ALLOWED_ORIGINS` | yes | Comma-separated explicit origins. No wildcards. `CORS_ORIGINS` is used only when this is unset |
| `TRUST_PROXY` | no | Hop count. Production default `1` (Railway). `true` means 1 hop, never “trust every hop”. `false` disables it |
| `HEALTHCARE_BACKEND_URL` | for chat | Spring base URL used for the appointment participant check |
| `CHAT_ACCESS_CACHE_SECONDS` | no | Successful participant lookups. Default `30` (max 300). Denials cache for at most 10 seconds |
| `CHAT_ACCESS_TIMEOUT_MS` | no | Backend lookup timeout. Default `2000` |
| `JSON_BODY_LIMIT` | no | Default `100kb` |
| `INTERNAL_RATE_LIMIT_PER_MIN` | no | Default `300` |
| `OTP_SEND_RATE_LIMIT_PER_MIN` | no | Default `30` |
| `OTP_DEBUG_MODE` | yes | `false` in production. `true` is refused when `NODE_ENV=production` |
| `OTP_TTL_SECONDS` | no | Default `600` |
| `OTP_MAX_ATTEMPTS` | no | Default `5` |
| `REDIS_URL` | no | Socket.IO Redis adapter and the shared OTP store (keys expire with `OTP_TTL_SECONDS`). Example `redis://…` or `rediss://…` |
| `REDIS_CONNECT_TIMEOUT_MS` | no | Default `10000`. Production exits if Redis was requested and does not connect |
| `EMAIL_PROVIDER` | no | `auto` (default), `resend`, or `smtp` |
| `RESEND_API_KEY` | for Resend | Resend API key. Never commit it |
| `RESEND_FROM` | for Resend | Verified sender, e.g. `DigiMed Connect <noreply@digimed-connect.co.za>` |
| `SMTP_HOST` | for SMTP | `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| `TWILIO_ACCOUNT_SID` | for SMS | With `TWILIO_AUTH_TOKEN` and `TWILIO_SMS_FROM` (E.164) |
| `WHATSAPP_PROVIDER` | for WhatsApp | `baileys`, `twilio`, `meta`, or generic `WHATSAPP_API_URL` + `WHATSAPP_API_TOKEN` |
| `BAILEYS_AUTH_DIR` | for Baileys | Default in Docker: `/app/data/baileys-auth` |
| `BAILEYS_PRINT_QR` | no | `true` prints the pairing QR in the console. The QR is also on `GET /internal/whatsapp/status` |

### CORS

List every browser origin explicitly. Wildcards are ignored, including `https://*.vercel.app`.

```text
ALLOWED_ORIGINS=https://digimed-connect.co.za,https://www.digimed-connect.co.za
```

Add a preview host only as a full origin, for example `https://healthcare-frontend-git-main-team.vercel.app`. Local development also needs `http://localhost:3000` (and `http://127.0.0.1:3000` if the app uses that host). Requests with no `Origin` (Spring, curl, Railway health checks) are allowed. A presented `Origin` must match exactly. Credentialed browser calls only succeed for a listed origin. The Socket.IO handshake rejects a presented origin that is not on the list.

### Email

`EMAIL_PROVIDER=auto` uses Resend when both `RESEND_API_KEY` and `RESEND_FROM` are set, otherwise SMTP when `SMTP_HOST` is set, otherwise a stub. `EMAIL_PROVIDER=smtp` forces nodemailer even if Resend is configured. `EMAIL_PROVIDER=resend` forces Resend and fails the send (and, in production, startup) when the Resend variables are missing.

`GET /internal/health` (header `X-Internal-Key`) → `delivery.email` is `resend`, `smtp`, or `stub`. SMS and WhatsApp use `twilio` / `baileys` / `meta` / `generic` / `stub`. The public `GET /health` payload is only `status` and `service`. Neither payload includes keys, QR codes, or auth paths.

### Redis

Leave `REDIS_URL` unset for a single Railway replica. OTP codes then live in this process only: a second instance cannot verify a code created on the first, and a restart drops pending codes. When Railway Redis is attached, set `REDIS_URL` to the plugin URL. The password in that URL is not written to logs. Chat and `notify:event` then reach sockets on every replica, and OTP hashes are stored under `digimed:otp:v1:` with the OTP TTL. Baileys still needs exactly one replica.

## Local checks

```bash
npm test
npm start
```
