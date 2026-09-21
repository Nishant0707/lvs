import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { io as connect, type Socket } from "socket.io-client";
import { redis } from "../src/config/redis.js";
import { createRealtime } from "../src/realtime/socket.js";
import {
  touchPresence,
  dropPresence,
  isOnline,
  sweepPresence,
} from "../src/services/presence.js";
import { consume } from "../src/middleware/rate-limit.js";
import { issueToken } from "../src/services/auth.js";
// Transport tests use real Redis and sockets, with durable membership stubbed.
// Full MongoDB membership behavior is covered by the separate integration suite.
vi.mock("../src/models/user.js", () => ({
  User: { exists: vi.fn().mockResolvedValue(true) },
}));
vi.mock("../src/models/room.js", () => ({
  Room: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../src/services/rooms.js", () => ({
  channel: (id: string) => `room:${id}`,
  joinRoom: async (id: string) => ({ room: { id }, changed: false }),
  roomDto: (room: unknown) => room,
  requireMembership: async () => ({ mode: "call" }),
  leaveRoom: async () => {
    throw new Error("Not part of this transport test");
  },
}));
describe.skipIf(process.env.RUN_REALTIME !== "1")(
  "real Redis and Socket.IO transport",
  () => {
    const workers: Awaited<ReturnType<typeof createRealtime>>[] = [];
    const urls: string[] = [];
    const sockets: Socket[] = [];
    beforeAll(async () => {
      if (redis.options.db !== 15)
        throw new Error("Test Redis must use database 15");
      await redis.connect();
      await redis.flushdb();
      for (let i = 0; i < 2; i++) {
        const server = createServer((_req, res) => res.end("ok"));
        const worker = await createRealtime(server);
        workers.push(worker);
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        urls.push(
          `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        );
      }
    });
    afterAll(async () => {
      sockets.forEach((s) => s.disconnect());
      for (const worker of workers) await worker.close();
      if (redis.status === "ready") await redis.quit();
    });
    async function client(index: number) {
      const token = await issueToken("0123456789abcdef01234567");
      const s = connect(urls[index]!, {
        transports: ["websocket"],
        auth: { token },
        forceNew: true,
      });
      sockets.push(s);
      await new Promise<void>((resolve, reject) => {
        s.once("connect", resolve);
        s.once("connect_error", reject);
      });
      return s;
    }
    function ack(
      s: Socket,
      event: string,
      payload: unknown,
    ): Promise<{ success: boolean }> {
      return new Promise((resolve, reject) =>
        s
          .timeout(3000)
          .emit(event, payload, (err: Error | null, r: { success: boolean }) =>
            err ? reject(err) : resolve(r),
          ),
      );
    }
    it("does not mark a user offline until the last socket lease ends", async () => {
      const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
      expect(await touchPresence(id, "tab1")).toBe(true);
      expect(await touchPresence(id, "tab2")).toBe(false);
      expect(await dropPresence(id, "tab1")).toBe(false);
      expect(await isOnline(id)).toBe(true);
      expect(await dropPresence(id, "tab2")).toBe(true);
      expect(await isOnline(id)).toBe(false);
    });
    it("sweeps crashed sockets without expiring a fresh competing heartbeat", async () => {
      const id = "bbbbbbbbbbbbbbbbbbbbbbbb";
      await touchPresence(id, "old");
      await redis.zadd(`presence:${id}`, Date.now() - 1, "old");
      await redis.zadd("presence:users", Date.now() - 1, id);
      expect(await sweepPresence()).toContain(id);
      await touchPresence(id, "new");
      expect(await sweepPresence()).not.toContain(id);
      expect(await isOnline(id)).toBe(true);
    });
    it("enforces a shared atomic rate limit under concurrent requests", async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, () => consume("test-concurrent-limit", 5)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(10);
    });
    it("rejects a forged socket token", async () => {
      const s = connect(urls[0]!, {
        transports: ["websocket"],
        auth: { token: "forged" },
        reconnection: false,
      });
      sockets.push(s);
      const error = await new Promise<Error>((resolve) =>
        s.once("connect_error", resolve),
      );
      expect(error.message).toContain("Unauthorized");
    });
    it("fans out messages across workers only to subscribed sockets", async () => {
      const a = await client(0),
        b = await client(1),
        outsider = await client(1);
      const roomId = "cccccccccccccccccccccccc";
      expect((await ack(a, "room:join", { roomId })).success).toBe(true);
      expect((await ack(b, "room:join", { roomId })).success).toBe(true);
      const received = new Promise<{ message: string }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("No cross-worker message")),
          3000,
        );
        b.once("room:message", (data) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
      const spy = vi.fn();
      outsider.on("room:message", spy);
      expect(
        (
          await ack(a, "room:message", {
            roomId,
            message: "cross-worker hello",
          })
        ).success,
      ).toBe(true);
      expect((await received).message).toBe("cross-worker hello");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(spy).not.toHaveBeenCalled();
      expect(
        (
          await ack(outsider, "room:message", {
            roomId,
            message: "not subscribed",
          })
        ).success,
      ).toBe(false);
    });
    it("routes native call signals across workers and rejects cross-room targets", async () => {
      const a = await client(0),
        b = await client(1),
        outsider = await client(1);
      const roomId = "dddddddddddddddddddddddd";
      expect((await ack(a, "call:join", { roomId })).success).toBe(true);
      expect((await ack(b, "call:join", { roomId })).success).toBe(true);
      expect(
        (
          await ack(outsider, "call:join", {
            roomId: "eeeeeeeeeeeeeeeeeeeeeeee",
          })
        ).success,
      ).toBe(true);
      const received = new Promise<{ from: string }>((resolve) =>
        b.once("call:signal", resolve),
      );
      const signal = { description: { type: "offer", sdp: "v=0" } };
      expect(
        (await ack(a, "call:signal", { roomId, target: b.id, signal })).success,
      ).toBe(true);
      expect((await received).from).toBe(a.id);
      expect(
        (await ack(a, "call:signal", { roomId, target: outsider.id, signal }))
          .success,
      ).toBe(false);
      await ack(b, "call:leave", {});
      expect(
        (await ack(a, "call:signal", { roomId, target: b.id, signal })).success,
      ).toBe(false);
    });
  },
);
