import "dotenv/config";
import crypto from "crypto";
import express from "express";
import { pushText } from "./utils/line.js";
import { parseOrderFromText } from "./utils/ai.js";
import { createSupabase } from "./storage/supabase.js";

const PORT = process.env.PORT || 3000;

const WORKER_POLL_MS = Math.max(200, Number(process.env.WORKER_POLL_MS || 800));
const WORKER_MAX_ATTEMPTS = Math.max(1, Number(process.env.WORKER_MAX_ATTEMPTS || 3));

const db = createSupabase();

const app = express();
app.use(express.json({ limit: "1mb" }));

// ✅ 狀態
let currentOrder = null;
let pendingDriver = null; // 🔥 等車卡用

const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";

// ========================
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// ========================
app.post("/webhook", async (req, res) => {
  console.log("🔥 收到 LINE:", JSON.stringify(req.body));

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const replyToken = event.replyToken;
    const userId = event.source?.userId;
    const text = event.message.text.trim();
    const sourceType = event.source?.type;

    // =========================
    // 🧑 客人
    // =========================
    if (sourceType === "user") {

      // 秒回
      await reply(replyToken, "已收到 👍");

      // 👉 直接當地址
      currentOrder = {
        status: "waiting",
        customerId: userId,
        address: text
      };

      pendingDriver = null;

      await pushText(
        DRIVER_GROUP_ID,
        `🚕 新訂單\n📍 ${text}\n\n👉 請標記BOT喊單（例：信義10）`
      );
    }

    // =========================
    // 🚕 司機群
    // =========================
    if (sourceType === "group") {

      if (event.source.groupId !== DRIVER_GROUP_ID) continue;
      if (!currentOrder || currentOrder.status !== "waiting") continue;

      // 🔥 第一段：喊單（信義10）
      const match = text.match(/(.+?)(\d+)/);

      if (match && !pendingDriver) {

        const area = match[1];
        const time = match[2];

        pendingDriver = {
          userId,
          area,
          time
        };

        console.log("🟡 收到喊單:", pendingDriver);

        await reply(replyToken, `已收到 ${area}${time}，請貼車卡`);

        continue;
      }

      // 🔥 第二段：車卡
      if (pendingDriver && pendingDriver.userId === userId) {

        currentOrder.status = "taken";
        currentOrder.driverId = userId;

        console.log("🚗 車卡:", text);

        // 👉 群組回覆
        await reply(replyToken, "已派你出發 🚗");

        // 👉 🔥 把整段車卡轉發給客人
        await pushText(
          currentOrder.customerId,
          `🚗 已為您安排司機\n\n${text}`
        );

        pendingDriver = null;
      }
    }
  }

  res.sendStatus(200);
});

// ========================
async function reply(token, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken: token,
      messages: [{ type: "text", text }]
    })
  });
}

// ========================
async function pickAvailableDriver() {
  return await db.pickAvailableDriver();
}

async function markJobFailed(jobId, err) {
  const message = err instanceof Error ? err.message : String(err);
  await db.updateJobById(jobId, {
    status: "failed",
    error_message: message,
    updated_at: new Date().toISOString()
  });
}

async function processJob(job) {
  const userId = job.source_user_id;
  const messageText = job.source_message_text;

  let parsed;

  try {
    parsed = await parseOrderFromText(messageText);
  } catch (err) {
    parsed = {
      from: "測試起點",
      to: "測試終點",
      passengers: 1,
      note: ""
    };
  }

  const now = new Date().toISOString();

  await db.insertOrder({
    id: crypto.randomUUID(),
    user_id: userId,
    from_loc: parsed.from,
    to_loc: parsed.to,
    passengers: parsed.passengers,
    note: parsed.note || "",
    driver_id: null,
    status: "created",
    created_at: now,
    updated_at: now
  });
}

async function takeOneJobAtomically() {
  return await db.claimOneJob();
}

function startWorker() {
  setInterval(async () => {
    try {
      const job = await takeOneJobAtomically();
      if (!job) return;

      try {
        await processJob(job);
        await db.updateJobById(job.id, { status: "done" });
      } catch (err) {
        await markJobFailed(job.id, err);
      }

    } catch (err) {
      console.error("❌ worker error:", err);
    }
  }, WORKER_POLL_MS);
}

async function main() {
  try {
    await db.ping();
    console.log("✅ Connected to Supabase");
  } catch (err) {
    console.error("❌ Supabase 連線失敗:", err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on ${PORT}`);
  });

  startWorker();
}

main().catch((err) => {
  console.error("[fatal]", err);
});