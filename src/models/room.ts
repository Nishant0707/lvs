import { Schema, model } from "mongoose";
const history = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, enum: ["joined", "left", "ended"], required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);
const schema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    livekitName: { type: String, required: true, unique: true },
    host: { type: Schema.Types.ObjectId, ref: "User", required: true },
    mode: { type: String, enum: ["stream", "voice", "call"], required: true },
    status: {
      type: String,
      enum: ["active", "ended"],
      default: "active",
      required: true,
    },
    participants: [
      { type: Schema.Types.ObjectId, ref: "User", required: true },
    ],
    history: [history],
    endedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: "revision" },
);
schema.index({ status: 1, createdAt: -1, _id: -1 });
schema.index({ participants: 1, status: 1 });
export const Room = model("Room", schema);
