import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";

import { env } from "../src/config/env.js";
import {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
} from "../src/services/auth.js";
import {
  registration,
  roomBody,
  objectId,
  roomEvent,
  messageEvent,
} from "../src/middleware/validation.js";

const userId = "0123456789abcdef01234567";
const key = new TextEncoder().encode(env.JWT_SECRET);

async function createTestToken(
  options: {
    subject?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
  } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(options.subject ?? userId)
    .setIssuer(options.issuer ?? "lvs-api")
    .setAudience(options.audience ?? "lvs-client")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(key);
}

describe("password security", () => {
  it("hashes passwords and rejects an incorrect password", async () => {
    const password = "SafePassword123!";
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("WrongPassword123!", hash)).toBe(false);
  });

  it("rejects passwords exceeding the bcrypt byte limit", () => {
    const result = registration.safeParse({
      name: "Test User",
      email: "test@example.com",
      password: "é".repeat(40),
    });

    expect(result.success).toBe(false);
  });
});

describe("JWT authentication", () => {
  it("accepts a valid application token", async () => {
    const token = await issueToken(userId);
    const claims = await verifyToken(token);

    expect(claims.userId).toBe(userId);
    expect(claims.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects a tampered token", async () => {
    const token = await issueToken(userId);

    await expect(verifyToken(`${token}x`)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects an expired token", async () => {
    const token = await createTestToken({ expiresIn: "-1h" });

    await expect(verifyToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a token intended for another audience", async () => {
    const token = await createTestToken({ audience: "another-app" });

    await expect(verifyToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a token from another issuer", async () => {
    const token = await createTestToken({ issuer: "another-server" });

    await expect(verifyToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects a signed token with an invalid user ID", async () => {
    const token = await createTestToken({ subject: "invalid-user" });

    await expect(verifyToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects an invalid token string", async () => {
    await expect(verifyToken("not-a-jwt")).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe("native-call input validation", () => {
  it("accepts creation of a native video-call room", () => {
    const result = roomBody.safeParse({
      name: "Team video call",
      mode: "call",
    });

    expect(result.success).toBe(true);
  });

  it("rejects a client-supplied host field", () => {
    const result = roomBody.safeParse({
      name: "Team video call",
      mode: "call",
      host: userId,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid room ID", () => {
    expect(objectId.safeParse("invalid-id").success).toBe(false);
    expect(roomEvent.safeParse({ roomId: "invalid-id" }).success).toBe(
      false,
    );
  });

  it("rejects attempts to supply another user's identity", () => {
    const result = roomEvent.safeParse({
      roomId: userId,
      userId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(result.success).toBe(false);
  });

  it("rejects empty and oversized chat messages", () => {
    for (const message of ["", "   ", "x".repeat(1001)]) {
      expect(
        messageEvent.safeParse({ roomId: userId, message }).success,
      ).toBe(false);
    }
  });
});