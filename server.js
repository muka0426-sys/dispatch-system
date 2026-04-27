import "dotenv/config";
import crypto from "crypto";
import express from "express";
import { pushText } from "./utils/line.js";
import { parseOrderFromText } from "./utils/ai.js";
import { createSupabase } from "./storage/supabase.js";

const PORT = Number(process.env.PORT || 3000);

const WORKER_POLL_MS = Math.max(200, Number(process.env.WORKER_POLL_MS || 800));
const WORKER_MAX_ATTEMPTS = Math.max(1, Number(process.env.WORKER_MAX_ATTEMPTS || 3));

const db = createSupabase();

const app = express();
app.use(express.json({ limit: "1mb" }));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

async function enqueueLineEvents(body) {
  const events = Array.isArray(body?.events) ? body.events : [];
  for (const ev of events) {
    const userId = ev?.source?.userId;
    const messageText = ev?.message?.type === "text" ? ev?.message?.text : null;
    if (!userId || !messageText) continue;

    const now = new Date().toISOString();
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
      source_message_text: messageText,
      raw_event: ev,
      result: null,
      error_message: null,
      error_stack: null,
      created_at: now,
      updated_at: now
    });
  }
}

/**
 * 🔥 最穩 callback（可偵錯版）
 */
app.post("/callback", async (req, res) => {
  console.log("🔥 收到 LINE:", JSON.stringify(req.body));

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type === "message") {
      const replyToken = event.replyToken;

      try {
        const r = await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
          },
          body: JSON.stringify({
            replyToken: replyToken,
            messages: [
              {
                type: "text",
                text: "我有收到你的訊息"
              }
            ]
          })
        });

        const text = await r.text();
        console.log("👉 LINE回應:", text);

      } catch (err) {
        console.error("❌ 回覆錯誤:", err);
      }
    }
  }

  res.sendStatus(200);

  // queue 照跑
  queueMicrotask(async () => {
    try {
      await enqueueLineEvents(req.body ?? {});
    } catch (err) {
      console.error("❌ enqueue error:", err);
    }
  });
});

// fallback
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
});

app.post("/webhook/", (req, res) => {
  res.sendStatus(200);
});

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
    console.error("🔥 AI錯誤（忽略）:", err.message);

    parsed = {
      from: "測試起點",
      to: "測試終點",
      passengers: 1,
      note: ""
    };
  }

  const now = new Date().toISOString();
  const order = await db.insertOrder({
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

async function workerLoop() {
  try {
    const job = await takeOneJobAtomically();

    if (!job) {
      setTimeout(workerLoop, WORKER_POLL_MS);
      return;
    }

    try {
      await processJob(job);
      await db.updateJobById(job.id, { status: "done" });
    } catch (err) {
      await markJobFailed(job.id, err);
    }
  } catch (err) {
    console.error("[worker] error:", err);
    await sleep(2000);
  } finally {
    setTimeout(workerLoop, 0);
  }
}

async function main() {
  await db.ping();
  console.log("Connected to Supabase");

  app.listen(PORT, () => {
    console.log(`[http] listening on ${PORT}`);
  });

  setTimeout(workerLoop, 0);
}

main().catch((err) => {
  console.error("[fatal]", err);
});