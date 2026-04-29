import "dotenv/config";
import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ========================
// Env & Supabase Client
// ========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
  : null;

// ===== 狀態 =====
/* status: waiting → matched → arrived → onboard → done */
let orders = [];
let nextOrderSeq = 1;
let pendingDriver = {};

// user state (memory): idle | filling_form | waiting_dispatch
const users = {};
// 防重複
const handledEvents = new Set();
// 司機群組 ID
const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========================
// Webhook
// ========================
app.post("/webhook", async (req, res) => {
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
  // 🚕 司機群
  // =========================
  if (sourceType === "group") {
    if (event.source.groupId !== DRIVER_GROUP_ID) return;
    if (orders.length === 0) return;

    // ===== 喊單 =====
    const bidMatch = text.match(/(.+?)(\d+)/);
    const waitingOrder = getNextWaitingOrder();
    if (waitingOrder && bidMatch && !pendingDriver[waitingOrder.orderId]) {
      const time = bidMatch[2];
      pendingDriver[waitingOrder.orderId] = { userId, time };
      await reply(replyToken, `司機${time}分(抵達)\n請貼車卡`);
      return;
    }

    // ===== 車卡 =====
    const cardTargetOrder = getWaitingOrderByPendingDriver(userId);
    if (cardTargetOrder) {
      const pending = pendingDriver[cardTargetOrder.orderId];
      cardTargetOrder.status = "matched";
      cardTargetOrder.driverId = userId;
      cardTargetOrder.driverEta = pending.time;

      // 同步更新 Supabase
      if (supabase) {
        await supabase.from("orders").update({
          status: "matched",
          driver_id: userId,
          driver_eta: pending.time
        }).eq("order_id", cardTargetOrder.orderId);
      }

      await reply(replyToken, "已派你出發 🚗");
      await pushText(cardTargetOrder.customerId, `🚗 已為您安排司機\n\n司機${pending.time}分抵達`);
      await pushText(cardTargetOrder.customerId, text); // 補車卡
      
      delete pendingDriver[cardTargetOrder.orderId];
      return;
    }

    // ===== 到點 =====
    const matchedOrder = getDriverOrderByStatus(userId, "matched");
    if (matchedOrder && text.includes("到")) {
      matchedOrder.status = "arrived";
      if (supabase) {
        await supabase.from("orders").update({ status: "arrived" }).eq("order_id", matchedOrder.orderId);
      }
      await reply(replyToken, "已通知客人");
      await pushText(matchedOrder.customerId, `📍 司機已抵達，請準備上車`);
      return;
    }

    // ===== 上車 =====
    const arrivedOrder = getDriverOrderByStatus(userId, "arrived");
    if (arrivedOrder && text.includes("上")) {
      arrivedOrder.status = "onboard";
      if (supabase) {
        await supabase.from("orders").update({ status: "onboard" }).eq("order_id", arrivedOrder.orderId);
      }
      await pushText(arrivedOrder.customerId, `✅ 司機已回報您已上車\n感謝您的搭乘 🙏`);
      return;
    }
    return;
  }

  // =========================
  // 🧑 客人（真人邏輯）
  // =========================
  if (sourceType === "user") {
    const state = getUserState(userId);

    if (text.includes("取消")) {
      deleteOrderByCustomer(userId);
      setUserState(userId, "idle");
      await reply(replyToken, "已取消訂單");
      return;
    }

    if (text.includes("叫車")) {
      if (getActiveOrder(userId) || state === "filling_form" || state === "waiting_dispatch") return;

      setUserState(userId, "filling_form");
      await reply(replyToken, `❤️‍🔥雙北叫車格式❤️‍🔥\n___________________\n日期：\n時間：\n上車：\n下車：\n人數：`);
      return;
    }

    if (state === "filling_form") {
      if (!text.includes("上車") || !text.includes("下車")) return;

      const form = parseRideForm(text);
      if (!form) return;

      // 建立訂單並寫入 DB
      const order = await createOrder(userId, form);
      setUserState(userId, "waiting_dispatch", { orderId: order.orderId });

      await reply(replyToken, "幫你安排司機中");
      await pushText(DRIVER_GROUP_ID, `（${order.pickup}）\n\n❤️‍🔥______R•S______❤️‍🔥\n💛5/2直2內100💛\n300回10%🧨600回15%\n🔥900回20%🔥\n♐上車:未指定走最短♐`);
      return;
    }
    return;
  }
}

// ========================
// 核心邏輯與資料庫
// ========================
function createOrderId() {
  const id = `RS${String(nextOrderSeq).padStart(4, "0")}`;
  nextOrderSeq += 1;
  return id;
}

async function createOrder(customerId, form) {
  const orderId = createOrderId();
  const newOrder = {
    orderId, status: "waiting", customerId, address: form.pickup, pickup: form.pickup, 
    dropoff: form.dropoff, date: form.date || null, time: form.time, passengers: form.passengers || null, 
    formText: form.rawText, createdAt: Date.now(), driverId: null, driverEta: null
  };
  
  orders.push(newOrder); // 寫入記憶體

  // 寫入 Supabase
  if (supabase) {
    const { error } = await supabase.from("orders").insert([{
      order_id: orderId,
      status: "waiting",
      customer_id: customerId,
      pickup: form.pickup,
      dropoff: form.dropoff,
      date: form.date,
      time: form.time,
      passengers: form.passengers,
      form_text: form.rawText
    }]);
    if (error) console.error("❌ DB Insert Error:", error);
  }
  return newOrder;
}

function getActiveOrder(customerId) {
  const activeStatuses = new Set(["waiting", "matched", "arrived"]);
  return orders.find(o => o.customerId === customerId && activeStatuses.has(o.status)) || null;
}
function getNextWaitingOrder() {
  return orders.find((o) => o.status === "waiting");
}
function getWaitingOrderByPendingDriver(driverUserId) {
  return orders.find((o) => o.status === "waiting" && pendingDriver[o.orderId]?.userId === driverUserId);
}
function getDriverOrderByStatus(driverUserId, status) {
  return orders.find((o) => o.driverId === driverUserId && o.status === status);
}
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
    data[m[1].trim()] = m[2].trim();
  }
  if (!data["上車"] || !data["下車"] || !data["時間"]) return null;
  return { pickup: data["上車"], dropoff: data["下車"], time: data["時間"], date: data["日期"], passengers: data["人數"], rawText: text };
}
function getUserState(userId) {
  return users[userId]?.state || "idle";
}
function setUserState(userId, state, data = {}) {
  users[userId] = { ...(users[userId] || {}), state, ...data, updatedAt: Date.now() };
}
function deleteOrderByCustomer(customerId) {
  const activeStatuses = new Set(["waiting", "matched", "arrived", "onboard"]);
  const idx = orders.findIndex((o) => o.customerId === customerId && activeStatuses.has(o.status));
  if (idx >= 0) orders.splice(idx, 1);
}

// ========================
// LINE API Helpers
// ========================
async function reply(token, text) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ replyToken: token, messages: [{ type: "text", text }] })
    });
  } catch (err) {
    console.error("❌ reply error:", err);
  }
}

async function pushText(to, text) {
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ to: to, messages: [{ type: "text", text }] })
    });
  } catch (err) {
    console.error("❌ push error:", err);
  }
}

app.listen(PORT, () => {
  console.log("🚀 running on", PORT);
});