import { z } from "zod";
export const objectId = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, "Expected a MongoDB ObjectId")
  .transform((s) => s.toLowerCase());
export const roomBody = z
  .object({
    name: z.string().trim().min(2).max(100),
    mode: z.enum(["stream", "voice", "call"]).default("voice"),
  })
  .strict();
export const credentials = z
  .object({
    email: z.email().trim().toLowerCase().max(254),
    password: z
      .string()
      .min(10)
      .max(72)
      .refine(
        (s) => Buffer.byteLength(s, "utf8") <= 72,
        "Password must be at most 72 UTF-8 bytes",
      ),
  })
  .strict();
export const registration = credentials.extend({
  name: z.string().trim().min(2).max(80),
  profileImage: z
    .url()
    .refine((s) => s.startsWith("https://"), "HTTPS URL required")
    .optional(),
});
export const tokenBody = z
  .object({
    roomName: z.string().min(1).max(100),
    userId: objectId.optional(),
    role: z.enum(["host", "participant"]).optional(),
  })
  .strict();
export const roomEvent = z.object({ roomId: objectId }).strict();
export const messageEvent = roomEvent.extend({
  message: z.string().trim().min(1).max(1000),
});
