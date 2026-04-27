import mongoose from "mongoose";

const JobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, default: "line_message" },
    status: {
      type: String,
      required: true,
      enum: ["pending", "processing", "done", "failed"],
      default: "pending",
      index: true
    },
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 3 },
    nextRunAt: { type: Date, default: null, index: true },
    lockedAt: { type: Date, default: null, index: true },
    lockId: { type: String, default: null },

    source: {
      userId: { type: String, required: true, index: true },
      messageText: { type: String, required: true }
    },

    rawEvent: { type: mongoose.Schema.Types.Mixed, default: null },

    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error: {
      message: { type: String, default: null },
      stack: { type: String, default: null }
    }
  },
  { timestamps: true }
);

JobSchema.index({ status: 1, nextRunAt: 1, createdAt: 1 });

export default mongoose.model("Job", JobSchema);
