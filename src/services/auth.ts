import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { env } from "../config/env.js";
import { AppError } from "../middleware/errors.js";
const key = new TextEncoder().encode(env.JWT_SECRET);
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) =>
  bcrypt.compare(password, hash);
export const issueToken = (id: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuer("lvs-api")
    .setAudience("lvs-client")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      issuer: "lvs-api",
      audience: "lvs-client",
    });
    if (!payload.sub || !/^[a-f0-9]{24}$/.test(payload.sub) || !payload.exp)
      throw new Error("Invalid claims");
    return { userId: payload.sub, expiresAt: payload.exp * 1000 };
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid or expired token");
  }
}
