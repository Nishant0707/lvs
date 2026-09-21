import type { RequestHandler } from "express";
import { createHash } from "node:crypto";
import { redis } from "../config/redis.js";
import { AppError } from "./errors.js";
const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
export async function consume(key: string, limit: number, seconds = 60) {
  const digest = createHash("sha256").update(key).digest("hex");
  const n = Number(await redis.eval(script, 1, `rate:${digest}`, seconds));
  if (n > limit)
    throw new AppError(429, "RATE_LIMITED", "Too many requests; retry later");
}
export const rateLimit =
  (prefix: string, limit: number): RequestHandler =>
  async (req, _res, next) => {
    await consume(`${prefix}:${req.ip}`, limit);
    next();
  };
