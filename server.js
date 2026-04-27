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

// ✅ Railway 必須要有 root
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
    if (event.type === "message") {
      const replyToken = event.replyToken;
      const userId = event.source?.userId;
      const text = event.message?.text;

      // ✅ 秒回（關鍵）
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

      // queue
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
  }

  res.sendStatus(200);
});

/**
 * 派單邏輯
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
    console.error("🔥 AI錯誤:", err.message);

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

  const driver = await pickAvailableDriver();

  if (!driver) {
    await pushText(userId, "目前沒有可用司機");
    return;
  }

  await pushText(userId, "已派單成功");
}

async function takeOneJobAtomically() {
  return await db.claimOneJob();
}

/**
 * ✅ 穩定 worker
 */
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

/**
 * 主程式
 */
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
