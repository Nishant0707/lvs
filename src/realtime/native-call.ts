import type { Server, Socket } from "socket.io";
import { z } from "zod";

import { objectId } from "../middleware/validation.js";
import { AppError } from "../middleware/errors.js";
import { requireMembership } from "../services/rooms.js";
import { consume } from "../middleware/rate-limit.js";

const roomInput = z.object({ roomId: objectId }).strict();

const signalInput = roomInput
  .extend({
    target: z.string().min(1).max(100),

    signal: z.union([
      z
        .object({
          description: z
            .object({
              type: z.enum(["offer", "answer"]),
              sdp: z.string().min(1).max(12000),
            })
            .strict(),
        })
        .strict(),

      z
        .object({
          candidate: z
            .object({
              candidate: z.string().max(2048),
              sdpMid: z.string().max(256).nullable().optional(),
              sdpMLineIndex: z.number().int().min(0).nullable().optional(),
              usernameFragment: z.string().max(256).nullable().optional(),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

const nativeChannel = (roomId: string) => `native:${roomId}`;

export function installNativeCalls(io: Server) {
  io.on("connection", (socket: Socket) => {
    let queue = Promise.resolve();
    let pending = 0;

    const leave = async () => {
      const roomId = socket.data.nativeRoom as string | undefined;

      if (!roomId) return;

      delete socket.data.nativeRoom;

      if (socket.rooms.has(nativeChannel(roomId))) {
        socket.to(nativeChannel(roomId)).emit("call:peer-left", {
          peerId: socket.id,
        });
      }

      await socket.leave(nativeChannel(roomId));
    };

    function handle(
      event: string,
      handler: (payload: unknown) => Promise<unknown>,
    ) {
      socket.on(event, (payload: unknown, ack: unknown) => {
        if (typeof ack !== "function") return;

        if (pending >= 40) {
          ack({
            success: false,
            error: {
              code: "TOO_MANY_PENDING_SIGNALS",
              message: "Too many pending signals. Try again shortly.",
            },
          });
          return;
        }

        pending++;

        queue = queue.then(async () => {
          try {
            if (!socket.connected) return;

            if (typeof socket.data.userId !== "string") {
              throw new AppError(
                401,
                "UNAUTHORIZED",
                "Sign in before joining a call.",
              );
            }

            await consume(`native:${socket.data.userId}`, 240);

            const data = await handler(payload);

            ack({ success: true, data });
          } catch (error) {
            if (error instanceof z.ZodError) {
              ack({
                success: false,
                error: {
                  code: "INVALID_SIGNAL",
                  message: error.issues
                    .map((issue) => issue.message)
                    .join("; "),
                },
              });
            } else if (error instanceof AppError) {
              ack({
                success: false,
                error: {
                  code: error.code,
                  message: error.message,
                },
              });
            } else {
              ack({
                success: false,
                error: {
                  code: "SIGNALING_FAILED",
                  message: "Signaling is unavailable. Retry the connection.",
                },
              });
            }
          } finally {
            pending--;
          }
        });
      });
    }

    handle("call:join", async (payload) => {
      const { roomId } = roomInput.parse(payload);
      const room = await requireMembership(roomId, socket.data.userId);

      if (room.mode !== "call") {
        throw new AppError(
          409,
          "INVALID_ROOM_MODE",
          "Create a video room on the video-call page first.",
        );
      }

      const targetChannel = nativeChannel(roomId);

      // Repeated joins return the current peers without disconnecting them.
      const alreadyJoined =
        socket.data.nativeRoom === roomId &&
        socket.rooms.has(targetChannel);

      if (!alreadyJoined) {
        await leave();

        if (!socket.connected) {
          throw new AppError(
            409,
            "SOCKET_DISCONNECTED",
            "Your connection closed. Reconnect and join again.",
          );
        }

        await socket.join(targetChannel);
        socket.data.nativeRoom = roomId;
      }

      try {
        // Membership might have changed while joining the socket room.
        await requireMembership(roomId, socket.data.userId);

        if (!socket.connected) {
          throw new AppError(
            409,
            "SOCKET_DISCONNECTED",
            "Your connection closed. Reconnect and join again.",
          );
        }

        const peers = await io.in(targetChannel).fetchSockets();

        if (!alreadyJoined) {
          socket.to(targetChannel).emit("call:peer-joined", {
            peerId: socket.id,
          });
        }

        return {
          peers: peers
            .filter(
              (peer) =>
                peer.id !== socket.id &&
                peer.data.nativeRoom === roomId,
            )
            .map((peer) => peer.id),
        };
      } catch (error) {
        await leave();
        throw error;
      }
    });

    handle("call:signal", async (payload) => {
      const { roomId, target, signal } = signalInput.parse(payload);
      const targetChannel = nativeChannel(roomId);

      if (
        socket.data.nativeRoom !== roomId ||
        !socket.rooms.has(targetChannel)
      ) {
        throw new AppError(
          403,
          "NOT_SUBSCRIBED",
          "Join this video call before sending signals.",
        );
      }

      if (target === socket.id) {
        throw new AppError(
          400,
          "INVALID_PEER",
          "Cannot send a call signal to yourself.",
        );
      }

      await requireMembership(roomId, socket.data.userId);

      const peer = (await io.in(targetChannel).fetchSockets()).find(
        (candidate) =>
          candidate.id === target &&
          candidate.data.nativeRoom === roomId,
      );

      if (!peer || typeof peer.data.userId !== "string") {
        throw new AppError(
          404,
          "PEER_NOT_FOUND",
          "That participant is no longer in this call.",
        );
      }

      await requireMembership(roomId, peer.data.userId);

      io.to(target).emit("call:signal", {
        roomId,
        from: socket.id,
        signal,
      });

      return {};
    });

    handle("call:leave", async () => {
      await leave();
      return {};
    });

    socket.on("disconnecting", () => {
      const roomId = socket.data.nativeRoom as string | undefined;

      if (roomId && socket.rooms.has(nativeChannel(roomId))) {
        socket.to(nativeChannel(roomId)).emit("call:peer-left", {
          peerId: socket.id,
        });
      }

      delete socket.data.nativeRoom;
    });
  });
}