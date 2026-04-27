import mongoose from "mongoose";

const OrderSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    passengers: { type: Number, required: true, min: 1, max: 50 },
    note: { type: String, default: "" },

    driverId: { type: mongoose.Schema.Types.ObjectId, ref: "Driver", default: null },
    status: {
      type: String,
      required: true,
      enum: ["created", "assigned", "completed", "cancelled", "failed"],
      default: "created",
      index: true
    }
  },
  { timestamps: true }
);

OrderSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Order", OrderSchema);
