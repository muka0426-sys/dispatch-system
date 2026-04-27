import mongoose from "mongoose";

const DriverSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    lineUserId: { type: String, required: true, unique: true, index: true },
    active: { type: Boolean, default: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ["available", "busy", "offline"],
      default: "available",
      index: true
    },
    lastAssignedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

DriverSchema.index({ active: 1, status: 1, lastAssignedAt: 1 });

export default mongoose.model("Driver", DriverSchema);
