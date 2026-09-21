import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  MONGODB_URI: z.string().trim().min(1),
  REDIS_URL: z.url(),

  JWT_SECRET: z.string().min(32),
  CORS_ORIGINS: z.string().trim().min(1),

  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info"),

  TRUST_PROXY: z.coerce.number().int().min(0).max(2).default(0),
});

export const env = schema.parse(process.env);

if (
  env.NODE_ENV === "production" &&
  env.JWT_SECRET.includes("replace-with")
) {
  throw new Error("Set a random JWT_SECRET before running in production.");
}

export const origins = env.CORS_ORIGINS
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);