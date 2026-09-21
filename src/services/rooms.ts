import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { Room } from "../models/room.js";
import { AppError } from "../middleware/errors.js";
export const channel = (id: string) => `room:${id}`;
export function roomDto(room: InstanceType<typeof Room>) {
  return {
    id: room.id,
    name: room.name,
    roomName: room.livekitName,
    host: String(room.host),
    mode: room.mode,
    status: room.status,
    participants: room.participants.map(String),
    participantCount: room.participants.length,
    createdAt: room.createdAt,
    revision: room.revision,
  };
}
export async function getRoom(id: string) {
  const room = await Room.findById(id);
  if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found");
  return room;
}
export async function createRoom(
  userId: string,
  name: string,
  mode: "voice" | "stream" | "call",
) {
  return Room.create({
    name,
    mode,
    host: userId,
    livekitName: `room-${randomUUID()}`,
    participants: [userId],
    history: [{ userId, action: "joined", at: new Date() }],
  });
}
export async function joinRoom(id: string, userId: string) {
  const room = await Room.findOneAndUpdate(
    {
      _id: id,
      status: "active",
      participants: { $ne: new Types.ObjectId(userId) },
      "participants.99": { $exists: false },
    },
    {
      $addToSet: { participants: userId },
      $inc: { revision: 1 },
      $push: {
        history: {
          $each: [{ userId, action: "joined", at: new Date() }],
          $slice: -500,
        },
      },
    },
    { new: true },
  );
  if (room) return { room, changed: true };
  const existing = await getRoom(id);
  if (existing.status !== "active")
    throw new AppError(409, "ROOM_ENDED", "Room has ended");
  if (existing.participants.some((p) => String(p) === userId))
    return { room: existing, changed: false };
  throw new AppError(409, "ROOM_FULL", "Room capacity is 100 participants");
}
export async function leaveRoom(id: string, userId: string) {
  const room = await Room.findOneAndUpdate(
    { _id: id, participants: new Types.ObjectId(userId) },
    {
      $pull: { participants: userId },
      $inc: { revision: 1 },
      $push: {
        history: {
          $each: [{ userId, action: "left", at: new Date() }],
          $slice: -500,
        },
      },
    },
    { new: true },
  );
  return { room: room ?? (await getRoom(id)), changed: !!room };
}
export async function endRoom(id: string, userId: string) {
  const previous = await getRoom(id);
  if (String(previous.host) !== userId)
    throw new AppError(403, "FORBIDDEN", "Only the host can end this room");
  return (
    (await Room.findOneAndUpdate(
      { _id: id, status: "active" },
      {
        $set: { status: "ended", participants: [], endedAt: new Date() },
        $inc: { revision: 1 },
        $push: {
          history: {
            $each: [{ userId, action: "ended", at: new Date() }],
            $slice: -500,
          },
        },
      },
      { new: true },
    )) ?? previous
  );
}
export async function requireMembership(id: string, userId: string) {
  const room = await getRoom(id);
  if (
    room.status !== "active" ||
    !room.participants.some((p) => String(p) === userId)
  )
    throw new AppError(403, "NOT_A_MEMBER", "Join an active room first");
  return room;
}
