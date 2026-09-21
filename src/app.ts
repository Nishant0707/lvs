import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Server } from "socket.io";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { env, origins } from "./config/env.js";
import { logger } from "./config/logger.js";
import { redis } from "./config/redis.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { AppError, errorHandler } from "./middleware/errors.js";
import { apiRoutes } from "./routes/api.js";

// Works from src/app.ts and compiled dist/app.js.
const publicDirectory = fileURLToPath(
  new URL("../public/", import.meta.url),
);

const docsDirectory = fileURLToPath(
  new URL("../docs/", import.meta.url),
);

export function createApp(io: Server) {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: () => randomUUID(),
      customLogLevel(_req, res, error) {
        if (error || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      autoLogging: {
        ignore: (req) =>
          req.url === "/health/live" || req.url === "/health/ready",
      },
    }),
  );

  const socketOrigins = origins.map((origin) => {
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.origin;
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          connectSrc: ["'self'", ...origins, ...socketOrigins],
          mediaSrc: ["'self'", "blob:"],
          workerSrc: ["'self'", "blob:"],
          upgradeInsecureRequests:
            env.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );

  app.use(cors({ origin: origins }));

  app.get("/health/live", (_req, res) => {
    res.json({
      success: true,
      data: { status: "alive" },
    });
  });

  app.get("/health/ready", async (_req, res) => {
    try {
      const db = mongoose.connection.db;

      if (mongoose.connection.readyState !== 1 || !db) {
        throw new Error("MongoDB disconnected");
      }

      await db.admin().ping();
      await redis.ping();

      res.json({
        success: true,
        data: { status: "ready" },
      });
    } catch {
      res.status(503).json({
        success: false,
        error: {
          code: "NOT_READY",
          message: "Dependency unavailable",
        },
      });
    }
  });

  // Public UI routes must run before the authenticated API router.
  app.get(["/", "/index.html"], (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, "/call.html");
  });

  for (const filename of ["call.html", "call.css", "call.js"]) {
    app.get(`/${filename}`, (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");

      res.sendFile(resolve(publicDirectory, filename), (error) => {
        if (!error) return;

        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          ("statusCode" in error && error.statusCode === 404)
        ) {
          next(
            new AppError(
              404,
              "UI_FILE_MISSING",
              `${filename} is missing from public. Save the UI files and run npm run build:demo.`,
            ),
          );
          return;
        }

        next(error);
      });
    });
  }

  app.use(
    express.static(publicDirectory, {
      index: false,
      etag: false,
      maxAge: 0,
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  app.get("/openapi.json", (_req, res, next) => {
    res.sendFile(
      resolve(docsDirectory, "openapi.json"),
      (error) => {
        if (error) next(error);
      },
    );
  });

  app.use(express.json({ limit: "16kb" }));
  app.use(rateLimit("api", 180), apiRoutes(io));

  app.use((_req, _res) => {
    throw new AppError(404, "NOT_FOUND", "Route not found");
  });

  app.use(errorHandler);

  return app;
}