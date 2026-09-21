import { createServer } from "node:http";
import mongoose from "mongoose";

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { redis } from "./config/redis.js";
import { User } from "./models/user.js";
import { Room } from "./models/room.js";
import { createApp } from "./app.js";
import { createRealtime } from "./realtime/socket.js";

let realtime: Awaited<ReturnType<typeof createRealtime>> | undefined;
let stopping = false;

async function closeResources() {
  const results = await Promise.allSettled([
    mongoose.disconnect(),
    redis.status === "ready"
      ? redis.quit()
      : Promise.resolve(redis.disconnect()),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "Dependency cleanup failed");
    }
  }
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;

  logger.info(`Stopping server · ${signal}`);

  const force = setTimeout(() => {
    logger.error("Shutdown timed out");
    process.exit(1);
  }, 10000);

  force.unref();

  try {
    await realtime?.close();
    await closeResources();

    logger.info("Server stopped");
    clearTimeout(force);
    process.exitCode = 0;
  } catch (error) {
    logger.error({ err: error }, "Shutdown failed");
    await closeResources();
    clearTimeout(force);
    process.exitCode = 1;
  }
}

async function start() {
  logger.info("Starting LVS Meet");

  logger.info("Connecting to MongoDB…");

  await mongoose.connect(env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  logger.info("✅ MongoDB connected");

  logger.info("Connecting to Redis…");
  await redis.connect();
  logger.info("✅ Redis connected");

  await Promise.all([
    User.createIndexes(),
    Room.createIndexes(),
  ]);

  logger.info("✅ Database indexes ready");

  const server = createServer();
  realtime = await createRealtime(server);

  const app = createApp(realtime.io);

  // Socket.IO already installed its request handling on this server.
  server.on("request", app);

  logger.info("✅ Realtime signaling ready");

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);

    server.once("error", onError);

    server.listen(env.PORT, () => {
      server.off("error", onError);
      resolve();
    });
  });

  server.on("error", (error) => {
    logger.error({ err: error }, "HTTP server error");
  });

  logger.info(
    {
      port: env.PORT,
      url: `http://localhost:${env.PORT}/call.html`,
    },
    "✅ LVS Meet is ready",
  );

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  process.once("SIGINT", () => {
    void shutdown("Ctrl+C");
  });
}

start().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);

  if (/bad auth|authentication failed/i.test(message)) {
    logger.fatal(
      "MongoDB login failed. Update the database username/password in MONGODB_URI.",
    );
  } else if (
    error instanceof Error &&
    "code" in error &&
    error.code === "EADDRINUSE"
  ) {
    logger.fatal(
      `Port ${env.PORT} is already in use. Stop the previous backend or Docker container.`,
    );
  } else {
    logger.fatal({ err: error }, "Startup failed");
  }

  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();

  try {
    await realtime?.close();
  } catch {
    // Continue cleaning up database connections after a startup failure.
  }

  await closeResources();
  clearTimeout(force);
  process.exit(1);
});