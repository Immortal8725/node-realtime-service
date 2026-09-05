# DigiMed Connect — Realtime Service

Socket.IO chat/notifications + internal OTP delivery for DigiMed / Forge Health.

## Run

```bash
cp .env.example .env
# Set JWT_SECRET to the SAME value as Spring JWT_SECRET
npm install
npm start
```

Default: `http://localhost:4001`

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | public |
| POST | `/internal/otp/send` | `X-Internal-Key` |
| POST | `/internal/otp/verify` | `X-Internal-Key` |
| POST | `/internal/notify` | `X-Internal-Key` |

## Socket.IO

Connect with DigiMed JWT:

```js
io("http://localhost:4001", { auth: { token: localStorage.token } })
```

### Rooms / events

- `chat:join` `{ appointmentId }` → room `appointment:{id}`
- `chat:message` `{ appointmentId, text }`
- `chat:leave` `{ appointmentId }`
- `notify:subscribe` → joins `user:{userId}` and `tenant:{tenantId}`
- Server push: `notify:event`

## Multi-instance (Redis)

Set `REDIS_URL` (e.g. `redis://127.0.0.1:6379`) to enable `@socket.io/redis-adapter`.
Without it, the service runs single-node (fine for local/dev).
`GET /health` reports `redisAdapter: true|false`.

## Env

- `JWT_SECRET` — must match Spring
- `INTERNAL_API_KEY` — Spring → this service only (≥ 16 chars)
- `REDIS_URL` — optional; enables HA fan-out across replicas
- `OTP_DEBUG_MODE` — if true, OTP responses include raw code (**forbidden when `NODE_ENV=production`**)
- `CORS_ORIGINS` — comma-separated FE origins
