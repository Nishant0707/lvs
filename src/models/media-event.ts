import { Schema, model } from "mongoose";
const schema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    roomName: { type: String, index: true },
    identity: String,
    participantSid: String,
    occurredAt: Date,
    receivedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
export const MediaEvent = model("MediaEvent", schema);
