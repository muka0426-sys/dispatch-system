import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ========================
// Env (strict)
// ========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!SUPABASE_URL) console.error("❌ Missing env: SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.error("❌ Missing env: SUPABASE_SERVICE_ROLE_KEY");
if (!LINE_CHANNEL_ACCESS_TOKEN) console.error("❌ Missing env: LINE_CHANNEL_ACCESS_TOKEN");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========================
// LINE Webhook
// ========================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];
  for (const event of events) {
    handleEvent(event).catch((err) => console.error("❌ handleEvent error:", err));
  }
});

async function handleEvent(event) {
  if (!event?.replyToken) return;
  if (event.type !== "message" || event.message?.type !== "text") return;

  const replyToken = event.replyToken;
  const userId = event.source?.userId;
  const text = (event.message.text || "").trim();

  // 1) 叫車：回覆格式
  if (text.includes("叫車")) {
    await replyText(
      replyToken,
      `❤️ 雙北叫車格式 ❤️
___________________
日期：
時間：
上車：
下車：
人數：`
    );
    return;
  }

  // 2) 表單：只要包含「上車：」就寫入 orders
  if (text.includes("上車：") || text.includes("上車:") || /上車\s*[:：]/.test(text)) {
    const orderId = `O${Date.now()}`;

    const ok = await insertOrder({
      orderId,
      customerId: userId,
      formText: text
    });

    if (ok) {
      await replyText(replyToken, "✅ 訂單已建立，正在排程司機");
    } else {
      await replyText(replyToken, "❌ 建立訂單失敗，請稍後再試");
    }
  }
}

async function insertOrder({ orderId, customerId, formText }) {
  if (!supabase) {
    console.error("❌ Supabase client not ready (missing env).");
    return false;
  }
  if (!customerId) {
    console.error("❌ Missing LINE userId.");
    return false;
  }

  // Preferred insert (as requested)
  const preferredPayload = {
    order_id: orderId,
    status: "waiting",
    form_text: formText,
    customer_id: customerId
  };

  const preferred = await supabase.from("orders").insert(preferredPayload);
  if (!preferred.error) return true;

  // Fallback for repos that still use supabase.sql schema
  const fallbackPayload = {
    id: orderId,
    user_id: customerId,
    from_loc: extractField(formText, "上車") || "未知",
    to_loc: extractField(formText, "下車") || "未知",
    passengers: parseInt(extractField(formText, "人數") || "1", 10) || 1,
    note: formText,
    status: "waiting"
  };

  const fallback = await supabase.from("orders").insert(fallbackPayload);
  if (fallback.error) {
    console.error("❌ DB insert failed:", {
      preferred: preferred.error,
      fallback: fallback.error
    });
    return false;
  }
  return true;
}

function extractField(text, key) {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*[:：]\\s*(.*)\\s*$`, "m");
  const m = text.match(re);
  return m?.[1]?.trim() || "";
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function replyText(replyToken, text) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text }]
      })
    });
  } catch (err) {
    console.error("❌ LINE reply error:", err);
  }
}

app.listen(PORT, () => {
  console.log("🚀 running on", PORT);
});