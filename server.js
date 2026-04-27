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

// ✅ 搶單核心狀態
let currentOrder = null;
const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";

// ✅ Railway root
app.get("/", (_req, res) => {
  res.send("ok");
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * 🔥 LINE webhook
 */
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
    // 🧑 客人（私聊）
    // =========================
    if (sourceType === "user") {

      // 秒回
      try {
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            replyToken,
            messages: [
              {
                type: "text",
                text: "我有收到你的訊息"
              }
            ]
          })
        });
      } catch (err) {
        console.error("❌ LINE 回覆失敗:", err);
      }

      // 👉 建立訂單
      if (text.includes("叫車")) {

        currentOrder = {
          status: "waiting",
          customerId: userId,
          bids: []
        };

        await pushText(userId, "已送出叫車，正在找司機...");
        await pushText(DRIVER_GROUP_ID, "🚕 新訂單：請輸入『地點 + 時間』搶單（例：三重 10）");
      }

      // queue（保留）
      if (userId && text) {
        const now = new Date().toISOString();
        try {
          await db.insertJob({
            id: crypto.randomUUID(),
            type: "line_message",
            status: "pending",
            attempts: 0,
            max_attempts: WORKER_MAX_ATTEMPTS,
            next_run_at: null,
            locked_at: null,
            lock_id: null,
            source_user_id: userId,
            source_message_text: text,
            raw_event: event,
            result: null,
            error_message: null,
            error_stack: null,
            created_at: now,
            updated_at: now
          });
        } catch (err) {
          console.error("❌ enqueue error:", err);
        }
      }
    }

    // =========================
    // 🚕 司機（群組）
    // =========================
    if (sourceType === "group") {

      if (event.source.groupId !== DRIVER_GROUP_ID) continue;
      if (!currentOrder || currentOrder.status !== "waiting") continue;

      // 👉 抓時間
      const match = text.match(/(\d+)/);
      if (!match) continue;

      const time = parseInt(match[1], 10);

      console.log("🟡 偵測喊單:", { text, time, userId });

      // ❗避免重複喊
      const exists = currentOrder.bids.find(b => b.userId === userId);
      if (exists) return;

      currentOrder.bids.push({
        userId,
        time,
        text,
        ts: Date.now()
      });

      console.log("📊 bids:", currentOrder.bids);

      // 👉 測試版：2人就決定
      if (currentOrder.bids.length >= 2) {

        const winner = currentOrder.bids.reduce((min, b) => {
          return b.time < min.time ? b : min;
        });

        currentOrder.status = "taken";
        currentOrder.driverId = winner.userId;

        console.log("🏆 得標:", winner);

        // 👉 @中獎司機
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            replyToken,
            messages: [
              {
                type: "text",
                text: "@司機 出發",
                mention: {
                  mentionees: [
                    {
                      index: 0,
                      length: 3,
                      userId: winner.userId
                    }
                  ]
                }
              }
            ]
          })
        });

        await pushText(currentOrder.customerId, "🚗 已幫你找到司機！");
      }
    }
  }

  res.sendStatus(200);
});

/**
 * 以下保留（未來用）
 */
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