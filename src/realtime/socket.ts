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

  await Promise.all([pub.connect(), sub.connect()]);

  const io = new Server(server, {
    cors: { origin: origins },
    transports: ["websocket"],
    maxHttpBufferSize: 16384,
    allowRequest: (req, callback) => {
      callback(
        null,
        !req.headers.origin || origins.includes(req.headers.origin),
      );
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

    if (rooms.length) {
      io.to(rooms.map((room) => channel(String(room._id)))).emit(
        "user:presence",
        {
          userId,
          online,
          at: new Date().toISOString(),
        },
      );
    }
  }

  // Authentication applies to room events and native WebRTC signaling.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (typeof token !== "string") {
        throw new AppError(401, "UNAUTHORIZED", "Token required");
      }

      const claims = await verifyToken(token);

      if (!(await User.exists({ _id: claims.userId }))) {
        throw new AppError(401, "UNAUTHORIZED", "User does not exist");
      }

      await consume(`socket-connect:${claims.userId}`, 60);

      socket.data = claims;
      next();
    } catch {
      next(new Error("Unauthorized or rate limited"));
    }
  });

  installNativeCalls(io);

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    const userChannel = `user:${userId}`;

    let commands = Promise.resolve();
    let pendingCommands = 0;

    const run = (fn: () => Promise<unknown>, ack?: Ack) => {
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
          if (!socket.connected) return;

          // Execute even when the client does not provide an acknowledgement.
          const data = await fn();
          ack?.({ success: true, data });
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

    void socket.join(userChannel);

    const heartbeat = async () => {
      if (!socket.connected) return;

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

          await socket.join(channel(roomId));

          try {
            await requireMembership(roomId, userId);
          } catch (error) {
            await socket.leave(channel(roomId));
            throw error;
          }

          if (changed) {
            broadcastMembership(io, room, "participant:joined", userId);
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
            broadcastMembership(io, room, "participant:left", userId);
          }

          const nativeChannel = `native:${roomId}`;
          const userSockets = await io.in(userChannel).fetchSockets();

          // Tell other callers to close connections to this user's tabs.
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

      void pulse
        .then(() => dropPresence(userId, socket.id))
        .then((changed) =>
          changed ? publishPresence(userId, false) : undefined,
        )
        .catch((error) => {
          logger.warn({ err: error }, "Presence cleanup failed");
        });
    });
  });

  const sweeper = setInterval(() => {
    void sweepPresence()
      .then((ids) =>
        Promise.all(ids.map((id) => publishPresence(id, false))),
      )
      .catch((error) => {
        logger.warn({ err: error }, "Presence sweep failed");
      });
  }, 15000);

  return {
    io,
    close: async () => {
      clearInterval(sweeper);

      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });

      await Promise.all([pub.quit(), sub.quit()]);
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