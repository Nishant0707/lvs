import { Redis } from "ioredis";
import { env } from "./env.js";
import { logger } from "./logger.js";
export function makeRedis() {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  client.on("error", (error) =>
    logger.error({ error: error.message }, "Redis connection error"),
  );
  return client;
}
export const redis = makeRedis();
