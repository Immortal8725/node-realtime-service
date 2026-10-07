/**
 * OTP persistence. Redis (with TTL) when REDIS_URL is set, otherwise an
 * in-memory map that lives only in this process.
 */

const KEY_PREFIX = "digimed:otp:v1:";

function createMemoryOtpStore(now = () => Date.now()) {
  const map = new Map();
  return {
    mode: "memory",
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlSeconds) {
      const ttl = Number(ttlSeconds);
      if (!Number.isFinite(ttl) || ttl < 1) {
        map.delete(key);
        return;
      }
      map.set(key, { value, expiresAt: now() + ttl * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
    async ttl(key) {
      const entry = map.get(key);
      if (!entry) return 0;
      const seconds = Math.ceil((entry.expiresAt - now()) / 1000);
      return seconds > 0 ? seconds : 0;
    },
  };
}

function createRedisOtpStore(client) {
  const redisKey = (key) => `${KEY_PREFIX}${key}`;
  return {
    mode: "redis",
    async get(key) {
      const raw = await client.get(redisKey(key));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed;
      } catch (_) {
        await client.del(redisKey(key));
        return null;
      }
    },
    async set(key, value, ttlSeconds) {
      const ttl = Math.floor(Number(ttlSeconds));
      if (!Number.isFinite(ttl) || ttl < 1) {
        await client.del(redisKey(key));
        return;
      }
      await client.set(redisKey(key), JSON.stringify(value), "EX", ttl);
    },
    async delete(key) {
      await client.del(redisKey(key));
    },
    async ttl(key) {
      const seconds = await client.ttl(redisKey(key));
      if (typeof seconds !== "number" || seconds < 1) return 0;
      return seconds;
    },
  };
}

function defaultRedisFactory(url) {
  const Redis = require("ioredis");
  const timeoutMs = Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 10000);
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: Number.isFinite(timeoutMs) ? timeoutMs : 10000,
    commandTimeout: 5000,
    connectionName: "digimed-otp",
    enableOfflineQueue: false,
    lazyConnect: true,
  });
}

function createOtpStore(env = process.env, redisFactory = defaultRedisFactory) {
  const url = String(env.REDIS_URL || "").trim();
  if (!url) return createMemoryOtpStore();
  return createRedisOtpStore(redisFactory(url));
}

module.exports = {
  KEY_PREFIX,
  createMemoryOtpStore,
  createRedisOtpStore,
  createOtpStore,
};
