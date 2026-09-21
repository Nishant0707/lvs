import pino from "pino";
import { writeSync } from "node:fs";
import { env } from "./env.js";

type LogEntry = {
  level?: number;
  time?: number;
  msg?: string;
  err?: {
    message?: string;
    stack?: string;
  };
  port?: number;
  url?: string;
  responseTime?: number;
  req?: {
    method?: string;
    url?: string;
  };
  res?: {
    statusCode?: number;
  };
};

const useColor = Boolean(process.stdout.isTTY);

function color(text: string, code: number) {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function safeText(value: string) {
  return value
    .replace(
      /\b(?:mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"']+/gi,
      "[connection URL hidden]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
    .replace(/[\r\n\u001b]/g, " ");
}

const terminal = {
  write(chunk: string) {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;

      let entry: LogEntry;

      try {
        entry = JSON.parse(line) as LogEntry;
      } catch {
        continue;
      }

      const level = entry.level ?? 30;
      const time = new Date(entry.time ?? Date.now()).toLocaleTimeString(
        "en-GB",
        { hour12: false },
      );

      const icon =
        level >= 50 ? "❌" :
        level >= 40 ? "⚠️" :
        level <= 20 ? "🔎" : "ℹ️";

      const shade = level >= 50 ? 31 : level >= 40 ? 33 : 36;

      let message = safeText(entry.msg ?? "");

      if (entry.req?.method && entry.res?.statusCode) {
        // Exclude query parameters from terminal request logs.
        const path = (entry.req.url ?? "/").split("?")[0];
        const duration =
          typeof entry.responseTime === "number"
            ? ` · ${Math.round(entry.responseTime)} ms`
            : "";

        message =
          `${entry.req.method} ${safeText(path ?? "/")} ` +
          `→ ${entry.res.statusCode}${duration}`;
      }

      let output =
        `${color(`[${time}]`, 90)} ${color(`${icon} ${message}`, shade)}\n`;

      if (entry.err?.message) {
        output += `    ${color(safeText(entry.err.message), shade)}\n`;
      }

      if (entry.url) {
        output += `    ${color(safeText(entry.url), 32)}\n`;
      }

      if (env.LOG_LEVEL === "debug" && entry.err?.stack) {
        for (const stackLine of entry.err.stack.split("\n").slice(1)) {
          output += `    ${color(safeText(stackLine.trim()), 90)}\n`;
        }
      }

      // Synchronous output preserves the final error before process exit.
      writeSync(1, output);
    }
  },
};

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: undefined,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'res.headers["set-cookie"]',
        "password",
        "passwordHash",
        "token",
        "accessToken",
        "refreshToken",
        "secret",
        "MONGODB_URI",
        "REDIS_URL",
        "JWT_SECRET",
      ],
      censor: "[hidden]",
    },
  },
  terminal,
);