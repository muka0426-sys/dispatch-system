import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import line from "@line/bot-sdk";

const app = express();

const PORT = process.env.PORT || 3000;

// ========================
// Env
// ========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) console.error("❌ Missing env: SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) console.error("❌ Missing env: SUPABASE_SERVICE_ROLE_KEY");

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

if (!LINE_CHANNEL_ACCESS_TOKEN) console.error("❌ Missing env: LINE_CHANNEL_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) console.error("❌ Missing env: LINE_CHANNEL_SECRET");

// ========================
// Clients
// ========================
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false }
      })
    : null;

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: LINE_CHANNEL_SECRET || ""
};

const lineClient =
  LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET ? new line.Client(lineConfig) : null;

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========================
// Webhook: /webhook
// ========================
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  res.sendStatus(200);
  const events = req.body?.events || [];
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error("❌ handleEvent error:", err);
    }
  }
});

async function handleEvent(event) {
  if (!event?.replyToken) return;
  if (event.type !== "message") return;
  if (event.message?.type !== "text") return;

  const text = (event.message.text || "").trim();
  if (!text.includes("叫車")) return;

  await replyText(event.replyToken, "系統連線正常，正在檢查 DB");
  await checkDbConnection();
}

async function checkDbConnection() {
  if (!supabase) return false;
  const { error } = await supabase.from("orders").select("order_id").limit(1);
  return !error;
}

async function replyText(replyToken, text) {
  if (!lineClient) return;
  await lineClient.replyMessage(replyToken, { type: "text", text });
}

app.listen(PORT, () => {
  console.log("🚀 running on", PORT);
});