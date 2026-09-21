import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  it,
  expect,
} from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import request from "supertest";
import { io as connect, type Socket } from "socket.io-client";
import { MongoMemoryServer } from "mongodb-memory-server";

import { redis } from "../src/config/redis.js";
import { Room } from "../src/models/room.js";
import { User } from "../src/models/user.js";
import {
  touchPresence,
  dropPresence,
  isOnline,
  sweepPresence,
} from "../src/services/presence.js";
import { createApp } from "../src/app.js";
import { createRealtime } from "../src/realtime/socket.js";

type Account = {
  id: string;
  token: string;
};

type TestRoom = {
  id: string;
  mode: string;
  participantCount: number;
};

type EventReply = {
  success: boolean;
  data?: {
    peers?: string[];
    [key: string]: unknown;
  };
  error?: {
    code: string;
    message: string;
  };
};

describe.skipIf(process.env.RUN_INTEGRATION !== "1")(
  "Native calling: MongoDB, Redis and Socket.IO",
  () => {
    let mongo: MongoMemoryServer | undefined;
    let app: ReturnType<typeof createApp>;

    const workers: Awaited<ReturnType<typeof createRealtime>>[] = [];
    const urls: string[] = [];
    const sockets: Socket[] = [];

    let host: Account;
    let guest: Account;
    let stranger: Account;
    let room: TestRoom;

    const bearer = (account: Account) => `Bearer ${account.token}`;

    async function register(email: string): Promise<Account> {
      const response = await request(app)
        .post("/auth/register")
        .send({
          name: "Test User",
          email,
          password: "StrongPass123!",
        })
        .expect(201);

      return {
        id: response.body.data.user.id,
        token: response.body.data.token,
      };
    }

    async function createRoom(account: Account): Promise<TestRoom> {
      const response = await request(app)
        .post("/rooms")
        .set("Authorization", bearer(account))
        .send({
          name: "Native video test",
          mode: "call",
        })
        .expect(201);

      return response.body.data;
    }

    async function openSocket(
      account: Account,
      workerIndex = 0,
    ): Promise<Socket> {
      const socket = connect(urls[workerIndex]!, {
        transports: ["websocket"],
        auth: { token: account.token },
        forceNew: true,
        reconnection: false,
        autoConnect: false,
      });

      sockets.push(socket);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.disconnect();
          reject(new Error("Socket connection timed out"));
        }, 5000);

        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });

        socket.once("connect_error", (error) => {
          clearTimeout(timer);
          socket.disconnect();
          reject(error);
        });

        socket.connect();
      });

      return socket;
    }

    function ack(
      socket: Socket,
      event: string,
      payload: unknown,
    ): Promise<EventReply> {
      return new Promise((resolve, reject) => {
        socket.timeout(5000).emit(
          event,
          payload,
          (error: Error | null, result: EventReply) => {
            if (error) reject(error);
            else resolve(result);
          },
        );
      });
    }

    function once(
      socket: Socket,
      event: string,
    ): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const listener = (data: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(data);
        };

        const timer = setTimeout(() => {
          socket.off(event, listener);
          reject(new Error(`Missing event: ${event}`));
        }, 4000);

        socket.once(event, listener);
      });
    }

    async function joinCall(socket: Socket, roomId: string) {
      expect(
        (await ack(socket, "room:join", { roomId })).success,
      ).toBe(true);

      expect(
        (await ack(socket, "call:join", { roomId })).success,
      ).toBe(true);
    }

    beforeAll(async () => {
      const uri = process.env.TEST_MONGODB_URI;

      if (uri && !/\/lvs_test(?:\?|$)/.test(uri)) {
        throw new Error("TEST_MONGODB_URI must target lvs_test");
      }

      if (redis.options.db !== 15) {
        throw new Error("Integration Redis must use database 15");
      }

      if (!uri) {
        mongo = await MongoMemoryServer.create({
          binary: { version: "7.0.24" },
        });
      }

      await mongoose.connect(uri ?? mongo!.getUri("lvs_test"));

      if (mongoose.connection.name !== "lvs_test") {
        throw new Error("Refusing to clear a non-test MongoDB database");
      }

      await redis.connect();

      // Destructive operations are restricted to dedicated test databases.
      await mongoose.connection.dropDatabase();
      await redis.flushdb();

      await Promise.all([
        User.createIndexes(),
        Room.createIndexes(),
      ]);

      for (let index = 0; index < 2; index++) {
        const server = createServer((req, res) => {
          workerApp(req, res);
        });

        const realtime = await createRealtime(server);
        workers.push(realtime);

        const workerApp = createApp(realtime.io);

        if (index === 0) app = workerApp;

        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });

        const address = server.address() as AddressInfo;
        urls.push(`http://127.0.0.1:${address.port}`);
      }

      host = await register("host@example.com");
      guest = await register("guest@example.com");
      stranger = await register("stranger@example.com");
    }, 120000);

    beforeEach(async () => {
      room = await createRoom(host);
    });

    afterEach(() => {
      sockets.splice(0).forEach((socket) => socket.disconnect());
    });

    afterAll(async () => {
      sockets.splice(0).forEach((socket) => socket.disconnect());

      await Promise.allSettled(
        workers.map((worker) => worker.close()),
      );

      await mongoose.disconnect();

      if (redis.status === "ready") {
        await redis.quit();
      } else {
        redis.disconnect();
      }

      await mongo?.stop();
    });

    it("protects APIs and validates login without exposing password hashes", async () => {
      await request(app).get("/users/me").expect(401);

      await request(app)
        .post("/auth/login")
        .send({
          email: "host@example.com",
          password: "WrongPassword",
        })
        .expect(401);

      const login = await request(app)
        .post("/auth/login")
        .send({
          email: "HOST@example.com",
          password: "StrongPass123!",
        })
        .expect(200);

      expect(login.body.data.user.passwordHash).toBeUndefined();

      await request(app)
        .post("/auth/register")
        .send({
          name: "Duplicate User",
          email: "host@example.com",
          password: "StrongPass123!",
        })
        .expect(409);

      const profile = await request(app)
        .get("/users/me")
        .set("Authorization", bearer(host))
        .expect(200);

      expect(profile.body.data.id).toBe(host.id);
      expect(profile.body.data.passwordHash).toBeUndefined();

      await request(app)
        .get("/rooms/invalid")
        .set("Authorization", bearer(host))
        .expect(400);
    });

    it("creates native rooms and keeps concurrent joins idempotent", async () => {
      expect(room.mode).toBe("call");
      expect(room.participantCount).toBe(1);

      await Promise.all(
        Array.from({ length: 12 }, () =>
          request(app)
            .post(`/rooms/${room.id}/join`)
            .set("Authorization", bearer(guest))
            .send({})
            .expect(200),
        ),
      );

      const details = await request(app)
        .get(`/rooms/${room.id}`)
        .set("Authorization", bearer(host))
        .expect(200);

      expect(details.body.data.participantCount).toBe(2);

      const saved = await Room.findById(room.id);

      expect(
        saved!.history.filter((entry) => entry.action === "joined"),
      ).toHaveLength(2);
    });

    it("delivers chat across workers and rejects unsubscribed senders", async () => {
      const a = await openSocket(host);
      const b = await openSocket(guest, 1);
      const outsider = await openSocket(stranger);

      expect(
        (await ack(a, "room:join", { roomId: room.id })).success,
      ).toBe(true);

      expect(
        (await ack(b, "room:join", { roomId: room.id })).success,
      ).toBe(true);

      const [sent, received] = await Promise.all([
        ack(a, "room:message", {
          roomId: room.id,
          message: "Hello from worker one",
        }),
        once(b, "room:message"),
      ]);

      expect(sent.success).toBe(true);
      expect(received.message).toBe("Hello from worker one");
      expect(received.userId).toBe(host.id);

      expect(
        (
          await ack(outsider, "room:message", {
            roomId: room.id,
            message: "Unauthorized message",
          })
        ).success,
      ).toBe(false);

      expect(
        (
          await ack(a, "room:message", {
            roomId: room.id,
            message: "x".repeat(1001),
          })
        ).success,
      ).toBe(false);
    });

    it("routes native signals only between authorized same-room peers", async () => {
      const a = await openSocket(host);
      const b = await openSocket(guest, 1);
      const outsider = await openSocket(stranger, 1);

      await joinCall(a, room.id);
      await joinCall(b, room.id);

      const repeatedJoin = await ack(a, "call:join", {
        roomId: room.id,
      });

      expect(repeatedJoin.success).toBe(true);
      expect(repeatedJoin.data?.peers).toContain(b.id);

      // Authentication alone does not grant room membership.
      expect(
        (await ack(outsider, "call:join", { roomId: room.id })).success,
      ).toBe(false);

      const otherRoom = await createRoom(stranger);
      await joinCall(outsider, otherRoom.id);

      // This tests signaling delivery, not browser SDP negotiation.
      const signal = {
        description: {
          type: "offer",
          sdp: "v=0\r\n",
        },
      };

      const [sent, received] = await Promise.all([
        ack(a, "call:signal", {
          roomId: room.id,
          target: b.id,
          signal,
        }),
        once(b, "call:signal"),
      ]);

      expect(sent.success).toBe(true);
      expect(received.from).toBe(a.id);
      expect(received.roomId).toBe(room.id);
      expect(received.signal).toEqual(signal);

      expect(
        (
          await ack(a, "call:signal", {
            roomId: room.id,
            target: outsider.id,
            signal,
          })
        ).success,
      ).toBe(false);

      expect(
        (
          await ack(outsider, "call:signal", {
            roomId: room.id,
            target: a.id,
            signal,
          })
        ).success,
      ).toBe(false);
    });

    it("keeps multi-tab users online and expires stale presence", async () => {
      const id = "aaaaaaaaaaaaaaaaaaaaaaaa";

      expect(await touchPresence(id, "tab-1")).toBe(true);
      expect(await touchPresence(id, "tab-2")).toBe(false);

      expect(await dropPresence(id, "tab-1")).toBe(false);
      expect(await isOnline(id)).toBe(true);

      expect(await dropPresence(id, "tab-2")).toBe(true);
      expect(await isOnline(id)).toBe(false);

      await touchPresence(id, "stale");

      await redis.zadd(`presence:${id}`, Date.now() - 1, "stale");
      await redis.zadd("presence:users", Date.now() - 1, id);

      expect(await sweepPresence()).toContain(id);
      expect(await isOnline(id)).toBe(false);
    });

    it("cleans up leaving peers and allows only the host to end a room", async () => {
      const a = await openSocket(host);
      const b = await openSocket(guest, 1);

      await joinCall(a, room.id);
      await joinCall(b, room.id);

      const [, departure] = await Promise.all([
        request(app)
          .post(`/rooms/${room.id}/leave`)
          .set("Authorization", bearer(guest))
          .send({})
          .expect(200),
        once(a, "call:peer-left"),
      ]);

      expect(departure.peerId).toBe(b.id);

      // Repeating leave must still succeed.
      await request(app)
        .post(`/rooms/${room.id}/leave`)
        .set("Authorization", bearer(guest))
        .send({})
        .expect(200);

      expect(
        (await ack(b, "call:join", { roomId: room.id })).success,
      ).toBe(false);

      expect(
        (
          await ack(a, "call:signal", {
            roomId: room.id,
            target: b.id,
            signal: {
              description: { type: "offer", sdp: "v=0\r\n" },
            },
          })
        ).success,
      ).toBe(false);

      await request(app)
        .post(`/rooms/${room.id}/end`)
        .set("Authorization", bearer(guest))
        .send({})
        .expect(403);

      const [, ended] = await Promise.all([
        request(app)
          .post(`/rooms/${room.id}/end`)
          .set("Authorization", bearer(host))
          .send({})
          .expect(200),
        once(a, "room:status"),
      ]);

      expect(ended.status).toBe("ended");
      expect(ended.participantCount).toBe(0);

      await request(app)
        .post(`/rooms/${room.id}/join`)
        .set("Authorization", bearer(guest))
        .send({})
        .expect(409);

      const saved = await Room.findById(room.id);

      expect(saved!.status).toBe("ended");
      expect(saved!.participants).toHaveLength(0);
    });
  },
);