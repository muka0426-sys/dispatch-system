import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import line from "@line/bot-sdk";
import { parseOrderFromText } from "./utils/ai.js";

const app = express();

const PORT = process.env.PORT || 3000;

// ========================
// Env (keep stable)
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
// Constants (fixed)
// ========================
const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";

// ========================
// State (memory)
// ========================
let pendingDriver = {}; // { [orderId]: { userId, time } }

// idle | filling_form | waiting_dispatch
const users = {};

// 防重複
const handledEvents = new Set();

// local sequence (best-effort restore)
let nextOrderSeq = 1;

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========================
// Webhook: /webhook (keep)
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

// ========================
async function handleEvent(event) {
  try {
    if (!event.replyToken) return;

    // 防重複
    if (handledEvents.has(event.replyToken)) return;
    handledEvents.add(event.replyToken);
    setTimeout(() => handledEvents.delete(event.replyToken), 60000);

    if (event.type !== "message" || event.message.type !== "text") return;

    const replyToken = event.replyToken;
    const userId = event.source?.userId;
    const text = event.message.text.trim();
    const sourceType = event.source?.type;

    console.log("📩", sourceType, text);

    // =========================
    // 🚕 司機群（完全搬回邏輯）
    // =========================
    if (sourceType === "group") {
      if (event.source.groupId !== DRIVER_GROUP_ID) return;

      // ===== 喊單 =====
      const bidMatch = text.match(/(.+?)(\d+)/);
      const waitingOrder = await getNextWaitingOrder();
      if (waitingOrder && bidMatch && !pendingDriver[waitingOrder.orderId]) {
        const time = bidMatch[2];
        pendingDriver[waitingOrder.orderId] = { userId, time };
        await replyText(replyToken, `司機${time}分(抵達)\n請貼車卡`);
        return;
      }

      // ===== 車卡 =====
      const cardTargetOrder = await getWaitingOrderByPendingDriver(userId);
      if (cardTargetOrder) {
        const pending = pendingDriver[cardTargetOrder.orderId];

        await updateOrderByOrderId(cardTargetOrder.orderId, {
          status: "matched",
          driver_id: userId,
          driver_eta: pending.time
        });

        await replyText(replyToken, "已派你出發 🚗");

        await pushText(
          cardTargetOrder.customerId,
`🚗 已為您安排司機

司機${pending.time}分抵達`
        );

        // 👉 再補車卡（第二則）
        await pushText(cardTargetOrder.customerId, text);
        delete pendingDriver[cardTargetOrder.orderId];
        return;
      }

      // ===== 到點 =====
      const matchedOrder = await getDriverOrderByStatus(userId, "matched");
      if (matchedOrder && text.includes("到")) {
        await updateOrderByOrderId(matchedOrder.orderId, { status: "arrived" });

        await replyText(replyToken, "已通知客人");

        await pushText(
          matchedOrder.customerId,
`📍 司機已抵達，請準備上車`
        );

        return;
      }

      // ===== 上車 =====
      const arrivedOrder = await getDriverOrderByStatus(userId, "arrived");
      if (arrivedOrder && text.includes("上")) {
        await updateOrderByOrderId(arrivedOrder.orderId, { status: "onboard" });

        await pushText(
          arrivedOrder.customerId,
`✅ 司機已回報您已上車
感謝您的搭乘 🙏`
        );

        return;
      }

      return;
    }

    // =========================
    // 🧑 客人：AI 介入（先判斷意圖）
    // =========================
    if (sourceType === "user") {
      console.log("[AI] before parseOrderFromText", { userId, text });
      const ai = await parseOrderFromText(text);
      console.log("[AI] after parseOrderFromText", { userId, ai });

      const isValidOrder =
        ai &&
        typeof ai === "object" &&
        typeof ai.from === "string" &&
        typeof ai.to === "string" &&
        ai.from.trim() &&
        ai.to.trim() &&
        !ai.from.includes("未知") &&
        !ai.to.includes("未知") &&
        !ai.from.includes("測試") &&
        !ai.to.includes("測試");

      // AI 判斷不是叫車訊息：保持沈默
      if (!isValidOrder) return;

      const ok = await createOrderFromAi(userId, text, ai);
      if (ok) {
        await replyText(replyToken, "✅ 訂單已受理，正在媒合司機");
      } else {
        await replyText(replyToken, "❌ 訂單建立失敗，請稍後再試");
      }

      return;
    }

  } catch (err) {
    console.error("❌ error:", err);
  }
}

async function createOrderFromAi(customerId, rawText, ai) {
  try {
    if (!supabase) {
      console.error("❌ Supabase client not ready (missing env).");
      return false;
    }

    const orderId = `O${Date.now()}`;
    const payload = {
      order_id: orderId,
      status: "waiting",
      customer_id: customerId,
      pickup: String(ai?.from ?? "").trim(),
      dropoff: String(ai?.to ?? "").trim(),
      date: null,
      time: null,
      passengers: String(ai?.passengers ?? ""),
      form_text: String(rawText ?? "")
    };

    const { error } = await supabase.from("orders").insert(payload);
    if (error) {
      console.error("❌ createOrderFromAi insert error:", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("❌ createOrderFromAi error:", err);
    return false;
  }
}

// ========================
// DB functions (Supabase)
// ========================
function mapOrderRow(row) {
  return {
    orderId: row.order_id,
    status: row.status,
    customerId: row.customer_id,
    pickup: row.pickup,
    dropoff: row.dropoff,
    date: row.date ?? null,
    time: row.time,
    passengers: row.passengers ?? null,
    formText: row.form_text,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    driverId: row.driver_id ?? null,
    driverEta: row.driver_eta ?? null
  };
}

async function initOrderSeqFromDb() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("orders")
    .select("order_id,created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.order_id) return;
  const m = String(data.order_id).match(/^RS(\d{4})$/);
  if (!m) return;
  const n = Number(m[1]);
  if (Number.isFinite(n) && n >= nextOrderSeq) nextOrderSeq = n + 1;
}

function createOrderId() {
  const id = `RS${String(nextOrderSeq).padStart(4, "0")}`;
  nextOrderSeq += 1;
  return id;
}

async function createOrder(customerId, form) {
  const orderId = createOrderId();

  const payload = {
    order_id: orderId,
    status: "waiting",
    customer_id: customerId,
    pickup: form.pickup,
    dropoff: form.dropoff,
    date: form.date || null,
    time: form.time,
    passengers: form.passengers || null,
    form_text: form.rawText
  };

  if (!supabase) {
    console.error("❌ Supabase client not ready (missing env).");
    return {
      orderId,
      status: "waiting",
      customerId,
      pickup: form.pickup,
      dropoff: form.dropoff,
      date: form.date || null,
      time: form.time,
      passengers: form.passengers || null,
      formText: form.rawText,
      createdAt: Date.now(),
      driverId: null,
      driverEta: null
    };
  }

  const { data, error } = await supabase
    .from("orders")
    .insert(payload)
    .select(
      "order_id,status,customer_id,pickup,dropoff,date,time,passengers,form_text,created_at,driver_id,driver_eta"
    )
    .single();

  if (error) {
    console.error("❌ createOrder DB insert error:", error);
    return {
      orderId,
      status: "waiting",
      customerId,
      pickup: form.pickup,
      dropoff: form.dropoff,
      date: form.date || null,
      time: form.time,
      passengers: form.passengers || null,
      formText: form.rawText,
      createdAt: Date.now(),
      driverId: null,
      driverEta: null
    };
  }

  return mapOrderRow(data);
}

async function getActiveOrder(customerId) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("orders")
    .select(
      "order_id,status,customer_id,pickup,dropoff,date,time,passengers,form_text,created_at,driver_id,driver_eta"
    )
    .eq("customer_id", customerId)
    .in("status", ["waiting", "matched", "arrived"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ getActiveOrder error:", error);
    return null;
  }
  return data ? mapOrderRow(data) : null;
}

async function getNextWaitingOrder() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("orders")
    .select(
      "order_id,status,customer_id,pickup,dropoff,date,time,passengers,form_text,created_at,driver_id,driver_eta"
    )
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ getNextWaitingOrder error:", error);
    return null;
  }
  return data ? mapOrderRow(data) : null;
}

async function getWaitingOrderByPendingDriver(driverUserId) {
  if (!supabase) return null;
  const orderIds = Object.entries(pendingDriver)
    .filter(([, v]) => v?.userId === driverUserId)
    .map(([orderId]) => orderId);
  if (orderIds.length === 0) return null;

  const { data, error } = await supabase
    .from("orders")
    .select(
      "order_id,status,customer_id,pickup,dropoff,date,time,passengers,form_text,created_at,driver_id,driver_eta"
    )
    .in("order_id", orderIds)
    .eq("status", "waiting")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ getWaitingOrderByPendingDriver error:", error);
    return null;
  }
  return data ? mapOrderRow(data) : null;
}

async function getDriverOrderByStatus(driverUserId, status) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("orders")
    .select(
      "order_id,status,customer_id,pickup,dropoff,date,time,passengers,form_text,created_at,driver_id,driver_eta,updated_at"
    )
    .eq("driver_id", driverUserId)
    .eq("status", status)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ getDriverOrderByStatus error:", error);
    return null;
  }
  return data ? mapOrderRow(data) : null;
}

async function updateOrderByOrderId(orderId, patch) {
  if (!supabase) return false;
  const { error } = await supabase.from("orders").update(patch).eq("order_id", orderId);
  if (error) {
    console.error("❌ updateOrderByOrderId error:", error);
    return false;
  }
  return true;
}

async function deleteOrderByCustomer(customerId) {
  if (!supabase) return false;

  const { data, error } = await supabase
    .from("orders")
    .select("order_id,status,created_at")
    .eq("customer_id", customerId)
    .in("status", ["waiting", "matched", "arrived", "onboard"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("❌ deleteOrderByCustomer select error:", error);
    return false;
  }
  if (!data?.order_id) return false;

  const { error: delErr } = await supabase.from("orders").delete().eq("order_id", data.order_id);
  if (delErr) {
    console.error("❌ deleteOrderByCustomer delete error:", delErr);
    return false;
  }

  if (pendingDriver[data.order_id]) delete pendingDriver[data.order_id];
  return true;
}

// ========================
// Parsing
// ========================
function isRideForm(text) {
  return /時間[:：]/.test(text) && /上車[:：]/.test(text) && /下車[:：]/.test(text);
}

function parseRideForm(text) {
  if (!isRideForm(text)) return null;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const data = {};
  for (const line of lines) {
    const m = line.match(/^([^:：]+)\s*[:：]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (!value) continue;
    data[key] = value;
  }

  const pickup = data["上車"];
  const dropoff = data["下車"];
  const time = data["時間"];
  const date = data["日期"];
  const passengers = data["人數"];

  if (!pickup || !dropoff || !time) return null;

  return {
    pickup,
    dropoff,
    time,
    date,
    passengers,
    rawText: text
  };
}

// ========================
// User state (memory)
// ========================
function getUserState(userId) {
  return users[userId]?.state || "idle";
}

function setUserState(userId, state, data = {}) {
  users[userId] = { ...(users[userId] || {}), state, ...data, updatedAt: Date.now() };
}

// ========================
// LINE helpers (SDK)
// ========================
async function replyText(replyToken, text) {
  try {
    if (!lineClient) return;
    await lineClient.replyMessage(replyToken, { type: "text", text });
  } catch (err) {
    console.error("❌ LINE reply error:", err);
  }
}

async function pushText(to, text) {
  try {
    if (!lineClient) return;
    await lineClient.pushMessage(to, { type: "text", text });
  } catch (err) {
    console.error("❌ LINE push error:", err);
  }
}

app.listen(PORT, () => {
  console.log("🚀 running on", PORT);
  initOrderSeqFromDb().catch(() => {});
});
