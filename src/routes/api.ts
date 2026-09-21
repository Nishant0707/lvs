import { Router } from "express";
import type { Server } from "socket.io";
import { z } from "zod";

import { User } from "../models/user.js";
import { Room } from "../models/room.js";
import { auth } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { rateLimit, consume } from "../middleware/rate-limit.js";
import {
  registration,
  credentials,
  roomBody,
  objectId,
} from "../middleware/validation.js";
import {
  hashPassword,
  verifyPassword,
  issueToken,
} from "../services/auth.js";
import { isOnline } from "../services/presence.js";
import {
  createRoom,
  getRoom,
  joinRoom,
  leaveRoom,
  endRoom,
  roomDto,
  channel,
} from "../services/rooms.js";
import { broadcastMembership } from "../realtime/socket.js";

export function apiRoutes(io: Server) {
  const router = Router();

  const publicUser = (user: InstanceType<typeof User>) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    profileImage: user.profileImage,
  });

  router.post("/auth/register", rateLimit("register", 10), async (req, res) => {
    const body = registration.parse(req.body);

    const user = await User.create({
      name: body.name,
      email: body.email,
      profileImage: body.profileImage,
      passwordHash: await hashPassword(body.password),
    });

    res.setHeader("Cache-Control", "no-store");

    res.status(201).json({
      success: true,
      data: {
        user: publicUser(user),
        token: await issueToken(user.id),
        expiresIn: 3600,
      },
    });
  });

  router.post("/auth/login", rateLimit("login", 20), async (req, res) => {
    const body = credentials.parse(req.body);

    await consume(`login-email:${body.email}`, 20, 300);

    const user = await User.findOne({ email: body.email }).select(
      "+passwordHash",
    );

    const valid = await verifyPassword(
      body.password,
      user?.passwordHash ??
        "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW",
    );

    if (!user || !valid) {
      throw new AppError(
        401,
        "INVALID_CREDENTIALS",
        "Invalid email or password",
      );
    }

    res.setHeader("Cache-Control", "no-store");

    res.json({
      success: true,
      data: {
        user: publicUser(user),
        token: await issueToken(user.id),
        expiresIn: 3600,
      },
    });
  });

  router.use(auth);

  router.get("/users/me", async (req, res) => {
    const user = await User.findById(req.userId);

    if (!user) {
      throw new AppError(401, "UNAUTHORIZED", "User does not exist");
    }

    res.setHeader("Cache-Control", "no-store");

    res.json({
      success: true,
      data: {
        ...publicUser(user),
        online: await isOnline(req.userId),
      },
    });
  });

  router.post("/rooms", async (req, res) => {
    await consume(`create-room:${req.userId}`, 10);

    const body = roomBody.parse(req.body);
    const room = await createRoom(req.userId, body.name, body.mode);

    res.status(201).json({
      success: true,
      data: roomDto(room),
    });
  });

  router.get("/rooms", async (req, res) => {
    const query = z
      .object({
        page: z.coerce.number().int().min(1).max(1000).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);

    const rooms = await Room.find({ status: "active" })
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit);

    res.json({
      success: true,
      data: rooms.map(roomDto),
      pagination: query,
    });
  });

  router.get("/rooms/:id", async (req, res) => {
    const room = await getRoom(objectId.parse(req.params.id));

    const presence = await Promise.all(
      room.participants.map(async (id) => ({
        userId: String(id),
        online: await isOnline(String(id)),
      })),
    );

    res.json({
      success: true,
      data: {
        ...roomDto(room),
        presence,
      },
    });
  });

  router.post("/rooms/:id/join", async (req, res) => {
    const { room, changed } = await joinRoom(
      objectId.parse(req.params.id),
      req.userId,
    );

    if (changed) {
      broadcastMembership(io, room, "participant:joined", req.userId);
    }

    res.json({
      success: true,
      data: roomDto(room),
    });
  });

  router.post("/rooms/:id/leave", async (req, res) => {
    const { room, changed } = await leaveRoom(
      objectId.parse(req.params.id),
      req.userId,
    );

    if (changed) {
      broadcastMembership(io, room, "participant:left", req.userId);
    }

    const userChannel = `user:${req.userId}`;
    const nativeChannel = `native:${room.id}`;

    // Notify remaining peers to close connections to this user's tabs.
    const sockets = await io.in(userChannel).fetchSockets();

    for (const socket of sockets) {
      if (socket.rooms.has(nativeChannel)) {
        io.to(nativeChannel).emit("call:peer-left", {
          peerId: socket.id,
        });
      }
    }

    io.in(userChannel).socketsLeave(nativeChannel);
    io.in(userChannel).socketsLeave(channel(room.id));

    res.json({
      success: true,
      data: roomDto(room),
    });
  });

  router.post("/rooms/:id/end", async (req, res) => {
    // endRoom verifies that the caller owns the room.
    const room = await endRoom(
      objectId.parse(req.params.id),
      req.userId,
    );

    const roomChannel = channel(room.id);
    const nativeChannel = `native:${room.id}`;

    // Both room subscribers and native-call peers receive the end event.
    io.to([roomChannel, nativeChannel]).emit("room:status", {
      roomId: room.id,
      status: "ended",
      participantCount: 0,
      revision: room.revision,
    });

    io.to(roomChannel).emit("room:count", {
      roomId: room.id,
      participantCount: 0,
      revision: room.revision,
    });

    io.in(roomChannel).socketsLeave(roomChannel);
    io.in(nativeChannel).socketsLeave(nativeChannel);

    res.json({
      success: true,
      data: roomDto(room),
    });
  });

  return router;
}