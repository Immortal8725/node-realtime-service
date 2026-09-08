# DigiMed Connect - Realtime Service

Socket.IO chat/notifications + internal OTP delivery for DigiMed / Forge Health.

## Run locally

```bash
cp .env.example .env
# Set JWT_SECRET to the SAME value as Spring JWT_SECRET
npm install
npm start
```

Default: `http://localhost:4001`

## Deploy on Railway

1. Open [Railway](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select repo `Immortal8725/node-realtime-service`
3. Railway builds with the included `Dockerfile` (`railway.json`)
4. **Networking** → Generate Domain (e.g. `https://….up.railway.app`)
5. **Variables** tab — set:

| Variable | Value |
|----------|--------|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Same ≥64-char secret as Spring `JWT_SECRET` |
| `INTERNAL_API_KEY` | Same key as Spring `REALTIME_INTERNAL_API_KEY` |
| `CORS_ORIGINS` | FE origins, comma-separated (e.g. `https://www.digimed-connect.co.za,https://digimed-connect.co.za`) |
| `OTP_DEBUG_MODE` | `false` (required; `true` is blocked in production) |
| `PORT` | Leave unset (Railway injects it) |

### OTP delivery (optional but needed for real WhatsApp/email)

**Email (SMTP):**

| Variable | Example |
|----------|---------|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` (or `true` for 465) |
| `SMTP_USER` | mailbox user |
| `SMTP_PASS` | app password / SMTP secret |
| `SMTP_FROM` | `DigiMed Connect <noreply@digimed-connect.co.za>` |

**WhatsApp — pick one:**

| Provider | Variables |
|----------|-----------|
| **Baileys** (clinic WhatsApp Web) | `WHATSAPP_PROVIDER=baileys`, optional `BAILEYS_AUTH_DIR=./data/baileys-auth`, `BAILEYS_PRINT_QR=true` |
| Twilio | `WHATSAPP_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM=whatsapp:+1…` |
| Meta Cloud | `WHATSAPP_PROVIDER=meta`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional `WHATSAPP_TEMPLATE_NAME` + `WHATSAPP_TEMPLATE_LANG` |
| Generic HTTP | `WHATSAPP_API_URL`, `WHATSAPP_API_TOKEN` |

#### Baileys setup

1. Set `WHATSAPP_PROVIDER=baileys` and start the service.
2. Scan the QR printed in the console, or fetch it from `GET /internal/whatsapp/status` with header `X-Internal-Key`.
3. Persist `BAILEYS_AUTH_DIR` (volume on Railway/VPS). Use **one replica** — one WhatsApp session per process.
4. `GET /health` shows `delivery.whatsapp: "baileys"` and `delivery.baileys.connected`.

Without a provider, OTP send returns `stubbed` (logged only). Spring can still pass `code` so the delivered digits match Paperless verify.

Optional: Railway Redis plugin → set `REDIS_URL` for multi-replica Socket.IO.

6. Health check: `GET https://YOUR-RAILWAY-HOST/health` → `{ "status": "ok" }`

### Wire DigiMed to Railway

**Frontend:**

```text
REACT_APP_REALTIME_URL=https://YOUR-RAILWAY-HOST
```

**Spring backend:**

```text
REALTIME_ENABLED=true
REALTIME_BASE_URL=https://YOUR-RAILWAY-HOST
REALTIME_INTERNAL_API_KEY=<same as INTERNAL_API_KEY>
JWT_SECRET=<same as realtime JWT_SECRET>
```

Redeploy FE + BE after changing env.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | public |
| POST | `/internal/otp/send` | `X-Internal-Key` |
| POST | `/internal/otp/verify` | `X-Internal-Key` |
| GET | `/internal/whatsapp/status` | `X-Internal-Key` (Baileys QR / link status) |
| POST | `/internal/notify` | `X-Internal-Key` |

## Socket.IO

```js
io("https://YOUR-RAILWAY-HOST", { auth: { token: localStorage.token } })
```

### Rooms / events

- `chat:join` `{ appointmentId }` → room `appointment:{id}`
- `chat:message` `{ appointmentId, text }`
- `chat:leave` `{ appointmentId }`
- `notify:subscribe` → joins `user:{userId}` and `tenant:{tenantId}`
- Server push: `notify:event`

## Env summary

- `JWT_SECRET` — must match Spring
- `INTERNAL_API_KEY` — Spring → this service (≥ 16 chars)
- `REDIS_URL` — optional HA
- `OTP_DEBUG_MODE` — forbidden when `NODE_ENV=production` if `true`
- `CORS_ORIGINS` — comma-separated FE origins
- `SMTP_*` — email OTP
- `WHATSAPP_PROVIDER` / Baileys / Twilio / Meta / generic — WhatsApp OTP
- `BAILEYS_AUTH_DIR` / `BAILEYS_PRINT_QR` — when provider is `baileys`
