import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      unique: true,
    },
    passwordHash: { type: String, required: true, select: false },
    profileImage: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
export const User = model("User", schema);
