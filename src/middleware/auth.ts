import type { RequestHandler } from "express";
import { verifyToken } from "../services/auth.js";
import { User } from "../models/user.js";
import { AppError } from "./errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export const auth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.get("authorization");
    const match = header?.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
    const token = match?.[1];

    if (!token) {
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "Bearer token required. Sign in before making this request.",
      );
    }

    const { userId } = await verifyToken(token);

    if (!(await User.exists({ _id: userId }))) {
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "User does not exist. Sign in again.",
      );
    }

    req.userId = userId;
    next();
  } catch (error) {
    next(error);
  }
};