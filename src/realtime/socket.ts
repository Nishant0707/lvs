import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

import { installNativeCalls } from "./native-call.js";
import { makeRedis } from "../config/redis.js";
import { origins } from "../config/env.js";
import { logger } from "../config/logger.js";
import { verifyToken } from "../services/auth.js";
import { User } from "../models/user.js";
import { Room } from "../models/room.js";

import {
  channel,
  joinRoom,
  leaveRoom,
  requireMembership,
  roomDto,
} from "../services/rooms.js";

import {
  touchPresence,
  dropPresence,
  sweepPresence,
} from "../services/presence.js";

import { roomEvent, messageEvent } from "../middleware/validation.js";
import { consume } from "../middleware/rate-limit.js";
import { AppError } from "../middleware/errors.js";

type Ack = (data: unknown) => void;

export async function createRealtime(server: HttpServer) {
  const pub = makeRedis();
  const sub = makeRedis();

  try {
    await Promise.all([pub.connect(), sub.connect()]);
  } catch (error) {
    pub.disconnect();
    sub.disconnect();
    throw error;
  }

  let closing = false;
  let closePromise: Promise<void> | undefined;

  const backgroundTasks = new Set<Promise<void>>();
  const backgroundErrors: unknown[] = [];

  function trackBackground(
    task: Promise<unknown>,
    message: string,
  ): void {
    const tracked = task
      .then(() => undefined)
      .catch((error: unknown) => {
        if (closing) backgroundErrors.push(error);
        logger.warn({ err: error }, message);
      });

    backgroundTasks.add(tracked);

    void tracked.then(() => {
      backgroundTasks.delete(tracked);
    });
  }

  const io = new Server(server, {
    cors: { origin: origins },
    transports: ["websocket"],
    maxHttpBufferSize: 16384,

    allowRequest: (req, callback) => {
      const allowedOrigin =
        !req.headers.origin || origins.includes(req.headers.origin);

      callback(null, !closing && allowedOrigin);
    },
  });

  io.adapter(createAdapter(pub, sub));

  async function publishPresence(userId: string, online: boolean) {
    const rooms = await Room.find({
      status: "active",
      participants: userId,
    })
      .select("_id")
      .lean();

    if (!rooms.length) return;

    io.to(rooms.map((room) => channel(String(room._id)))).emit(
      "user:presence",
      {
        userId,
        online,
        at: new Date().toISOString(),
      },
    );
  }

  io.use((socket, next) => {
    trackBackground(
      (async () => {
        try {
          if (closing) {
            next(new Error("Server is shutting down"));
            return;
          }

          const token = socket.handshake.auth.token;

          if (typeof token !== "string") {
            throw new AppError(401, "UNAUTHORIZED", "Token required");
          }

          const claims = await verifyToken(token);

          if (!(await User.exists({ _id: claims.userId }))) {
            throw new AppError(
              401,
              "UNAUTHORIZED",
              "User does not exist",
            );
          }

          await consume(`socket-connect:${claims.userId}`, 60);

          if (closing) {
            next(new Error("Server is shutting down"));
            return;
          }

          socket.data = claims;
          next();
        } catch {
          next(new Error("Unauthorized or rate limited"));
        }
      })(),
      "Socket authentication failed",
    );
  });

  installNativeCalls(io);

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const userChannel = `user:${userId}`;

    let commands = Promise.resolve();
    let pendingCommands = 0;

    const run = (fn: () => Promise<unknown>, ack?: Ack) => {
      if (closing || !socket.connected) {
        ack?.({
          success: false,
          error: {
            code: "SERVER_CLOSING",
            message: "Connection closing. Reconnect shortly.",
          },
        });
        return;
      }

      if (pendingCommands >= 40) {
        ack?.({
          success: false,
          error: {
            code: "TOO_MANY_PENDING_EVENTS",
            message: "Too many pending requests. Try again shortly.",
          },
        });
        return;
      }

      pendingCommands++;

      commands = commands.then(async () => {
        try {
          if (closing || !socket.connected) return;

          // Execute the operation even without an acknowledgement.
          const data = await fn();

          ack?.({
            success: true,
            data,
          });
        } catch (error) {
          const failure =
            error instanceof AppError
              ? error
              : new AppError(
                  400,
                  "EVENT_FAILED",
                  "Invalid event or service unavailable",
                );

          ack?.({
            success: false,
            error: {
              code: failure.code,
              message: failure.message,
            },
          });
        } finally {
          pendingCommands--;
        }
      });
    };

    trackBackground(
      Promise.resolve(socket.join(userChannel)),
      "User channel subscription failed",
    );

    const heartbeat = async () => {
      if (closing || !socket.connected) return;

      try {
        if (await touchPresence(userId, socket.id)) {
          await publishPresence(userId, true);
        }
      } catch (error) {
        logger.warn({ err: error }, "Presence unavailable");
        socket.disconnect(true);
      }
    };

    let pulse = heartbeat();

    const interval = setInterval(() => {
      if (closing || !socket.connected) return;
      pulse = pulse.then(heartbeat);
    }, 20000);

    const expiry = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, Number(socket.data.expiresAt) - Date.now()),
    );

    socket.on("room:join", (payload: unknown, ack?: Ack) => {
      run(
        async () => {
          await consume(`socket:${userId}`, 120);

          const { roomId } = roomEvent.parse(payload);
          const { room, changed } = await joinRoom(roomId, userId);

          if (closing || !socket.connected) {
            throw new AppError(
              409,
              "SOCKET_DISCONNECTED",
              "Connection closed. Reconnect and join again.",
            );
          }

          await socket.join(channel(roomId));

          try {
            await requireMembership(roomId, userId);
          } catch (error) {
            await socket.leave(channel(roomId));
            throw error;
          }

          if (changed) {
            broadcastMembership(
              io,
              room,
              "participant:joined",
              userId,
            );
          }

          return roomDto(room);
        },
        typeof ack === "function" ? ack : undefined,
      );
    });

    socket.on("room:leave", (payload: unknown, ack?: Ack) => {
      run(
        async () => {
          await consume(`socket:${userId}`, 120);

          const { roomId } = roomEvent.parse(payload);
          const { room, changed } = await leaveRoom(roomId, userId);

          if (changed) {
            broadcastMembership(
              io,
              room,
              "participant:left",
              userId,
            );
          }

          const nativeChannel = `native:${roomId}`;
          const userSockets = await io.in(userChannel).fetchSockets();

          for (const userSocket of userSockets) {
            if (userSocket.rooms.has(nativeChannel)) {
              io.to(nativeChannel).emit("call:peer-left", {
                peerId: userSocket.id,
              });
            }
          }

          io.in(userChannel).socketsLeave(nativeChannel);
          io.in(userChannel).socketsLeave(channel(roomId));

          return roomDto(room);
        },
        typeof ack === "function" ? ack : undefined,
      );
    });

    socket.on("room:message", (payload: unknown, ack?: Ack) => {
      run(
        async () => {
          await consume(`message:${userId}`, 30);

          const { roomId, message } = messageEvent.parse(payload);

          await requireMembership(roomId, userId);

          if (!socket.rooms.has(channel(roomId))) {
            throw new AppError(
              403,
              "NOT_SUBSCRIBED",
              "Subscribe with room:join first",
            );
          }

          const event = {
            id: randomUUID(),
            roomId,
            userId,
            message,
            at: new Date().toISOString(),
          };

          io.to(channel(roomId)).emit("room:message", event);

          return event;
        },
        typeof ack === "function" ? ack : undefined,
      );
    });

    socket.on("disconnect", () => {
      clearInterval(interval);
      clearTimeout(expiry);

      trackBackground(
        Promise.all([pulse, commands])
          .then(() => dropPresence(userId, socket.id))
          .then((changed) =>
            changed ? publishPresence(userId, false) : undefined,
          ),
        "Presence cleanup failed",
      );
    });
  });

  const sweeper = setInterval(() => {
    if (closing) return;

    trackBackground(
      sweepPresence().then((ids) =>
        Promise.all(
          ids.map((userId) => publishPresence(userId, false)),
        ),
      ),
      "Presence sweep failed",
    );
  }, 15000);

  return {
    io,

    close: (): Promise<void> => {
      if (closePromise) return closePromise;

      closing = true;
      clearInterval(sweeper);

      closePromise = (async () => {
        try {
          // Socket disconnect handlers can still use Redis here.
          await new Promise<void>((resolve) => {
            io.close(() => resolve());
          });

          // Drain presence cleanup, room commands and running sweeps.
          while (backgroundTasks.size > 0) {
            await Promise.all([...backgroundTasks]);
          }

          // Wait for queued adapter publish/unsubscribe commands.
          await Promise.all([pub.ping(), sub.ping()]);

          const results = await Promise.allSettled([
            pub.quit(),
            sub.quit(),
          ]);

          const failures: unknown[] = [...backgroundErrors];

          for (const result of results) {
            if (result.status === "rejected") {
              failures.push(result.reason);
            }
          }

          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "Realtime shutdown failed",
            );
          }
        } finally {
          // Release connections even if graceful shutdown fails.
          pub.disconnect();
          sub.disconnect();
        }
      })();

      return closePromise;
    },
  };
}

export function broadcastMembership(
  io: Server,
  room: InstanceType<typeof Room>,
  event: string,
  userId: string,
) {
  const data = {
    roomId: room.id,
    userId,
    participantCount: room.participants.length,
    revision: room.revision,
  };

  io.to(channel(room.id)).emit(event, data);
  io.to(channel(room.id)).emit("room:count", data);
}