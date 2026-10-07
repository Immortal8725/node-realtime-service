# DigiMed Connect — Realtime Service

Socket.IO chat and notifications, plus internal OTP delivery, for DigiMed Connect.

Spring `healthcare-backend` calls this service with `X-Internal-Key`. The web app connects with `REACT_APP_REALTIME_URL` and `src/services/realtime.js`. Those contracts are unchanged.

## Upgrade notes (1.1.0)

- Node 20+ (Docker image `node:22-alpine`). Socket.IO stays on v4 (`socket.io@4.8`) so the existing frontend client keeps the same protocol.
- Express stays on the 4.22 security line so route and error behavior match what Spring and the frontend already use.
- Helmet, JSON body limit (`100kb` by default), and per-IP rate limits on `/internal/*`.
- Structured JSON logs. OTP codes, tokens, and provider secrets are redacted. Message bodies are not logged.
- Production refuses to boot when `OTP_DEBUG_MODE=true`, when `JWT_SECRET` is under 32 characters, or when `INTERNAL_API_KEY` is under 16 characters. A 64+ character `JWT_SECRET` matching Spring is still the DigiMed standard.
- JWTs are verified as HMAC only (`HS256`, `HS384`, `HS512`). Claim names are the same: `sub` / `username`, `tenantId`, `userId`, `roles`.
- Optional Resend email (`RESEND_API_KEY` + `RESEND_FROM`) beside SMTP. Choose with `EMAIL_PROVIDER`.
- Optional Redis adapter when `REDIS_URL` is set. In production a configured Redis that cannot be reached stops startup, so replicas do not silently split.
- `GET /health` adds `version`, `uptimeSeconds`, and `redis`. `GET /ready` reports configuration with booleans only.
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
6. Health check: `GET https://YOUR-RAILWAY-HOST/health` → `{ "status": "ok" }`
7. Readiness: `GET https://YOUR-RAILWAY-HOST/ready` → `{ "status": "ready" }` when secrets are set and Redis is connected if `REDIS_URL` is set

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

Redeploy the frontend and backend after changing env.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | public liveness |
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

- `chat:join` `{ appointmentId }` → room `appointment:{id}`
- `chat:message` `{ appointmentId, text }`
- `chat:leave` `{ appointmentId }`
- `notify:subscribe` → joins `user:{userId}` and `tenant:{tenantId}`
- Server push: `notify:event`
- Internal fan-out: `POST /internal/notify` with `{ target: { userId?, username?, tenantId? }, event }`

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `NODE_ENV` | production | `production` enables fail-closed checks and trust-proxy |
| `PORT` | Railway sets it | Listen port (local default `4001`) |
| `JWT_SECRET` | yes | Same secret as Spring. Minimum 32 characters; DigiMed standard is 64+ |
| `INTERNAL_API_KEY` | yes | Same as Spring `REALTIME_INTERNAL_API_KEY`. Minimum 16 characters. Header remains `X-Internal-Key` |
| `CORS_ORIGINS` | yes | Comma-separated origins. `*` matches one host label |
| `TRUST_PROXY` | no | Default on in production (one hop, Railway). Set `false` to disable |
| `JSON_BODY_LIMIT` | no | Default `100kb` |
| `INTERNAL_RATE_LIMIT_PER_MIN` | no | Default `300` |
| `OTP_SEND_RATE_LIMIT_PER_MIN` | no | Default `30` |
| `OTP_DEBUG_MODE` | yes | `false` in production. `true` is refused when `NODE_ENV=production` |
| `OTP_TTL_SECONDS` | no | Default `600` |
| `OTP_MAX_ATTEMPTS` | no | Default `5` |
| `REDIS_URL` | no | Enables `@socket.io/redis-adapter` for more than one replica. Example `redis://…` or `rediss://…` |
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

Set both clinic hosts and Vercel previews:

```text
CORS_ORIGINS=https://digimed-connect.co.za,https://www.digimed-connect.co.za,https://*.vercel.app
```

`https://*.vercel.app` matches `https://<project>.vercel.app` and preview hosts such as `https://<project>-git-<branch>-<team>.vercel.app`. That broad pattern allows every Vercel host. A project prefix is tighter, for example `https://healthcare-frontend-*.vercel.app`. Requests with no `Origin` (Spring, curl, Railway health checks) are allowed. Credentialed browser calls only succeed for a listed origin.

### Email

`EMAIL_PROVIDER=auto` uses Resend when both `RESEND_API_KEY` and `RESEND_FROM` are set, otherwise SMTP when `SMTP_HOST` is set, otherwise a stub. `EMAIL_PROVIDER=smtp` forces nodemailer even if Resend is configured. `EMAIL_PROVIDER=resend` forces Resend and fails the send (and, in production, startup) when the Resend variables are missing.

`GET /health` → `delivery.email` is `resend`, `smtp`, or `stub`. SMS and WhatsApp use the same `twilio` / `baileys` / `meta` / `generic` / `stub` values as before. The public payload does not include keys, QR codes, or auth paths.

### Redis

Leave `REDIS_URL` unset for a single Railway replica. When Railway Redis is attached, set `REDIS_URL` to the plugin URL. The password in that URL is not written to logs. Chat and `notify:event` then reach sockets on every replica. Baileys still needs exactly one replica.

## Local checks

```bash
npm test
npm start
```
