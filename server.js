import "dotenv/config";
import express from "express";
import { pushText } from "./utils/line.js";
import { parseOrderFromText } from "./utils/ai_v7.js";

console.log("[boot] server.js", {
  npm_package_version: process.env.npm_package_version ?? "(run via npm start to populate)",
  railwayGitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? "(unset)",
  railwayGitBranch: process.env.RAILWAY_GIT_BRANCH ?? "(unset)",
  cwd: process.cwd()
});

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== 狀態 =====
/*
status:
waiting → matched → arrived → onboard → done
*/
let orders = [];
let nextOrderSeq = 1;
let pendingDriver = {};

// user state (memory)
// idle | filling_form | waiting_dispatch
const users = {};

// 防重複
const handledEvents = new Set();

const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// ========================
app.post("/webhook", (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) handleEvent(event);
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

        await reply(replyToken, "已派你出發 🚗");

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
      const matchedOrder = getDriverOrderByStatus(userId, "matched");
      if (matchedOrder && text.includes("到")) {
        matchedOrder.status = "arrived";

        await reply(replyToken, "已通知客人");

        await pushText(
          matchedOrder.customerId,
`📍 司機已抵達，請準備上車`
        );

        return;
      }

      // ===== 上車 =====
      const arrivedOrder = getDriverOrderByStatus(userId, "arrived");
      if (arrivedOrder && text.includes("上")) {
        arrivedOrder.status = "onboard";

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
    // 🧑 客人（真人邏輯）
    // =========================
    if (sourceType === "user") {
      const state = getUserState(userId);
      const hasCarKeyword = text.includes("叫車") || text.includes("車");
      const activeOrder = getActiveOrder(userId);

      if (text.includes("取消")) {
        deleteOrderByCustomer(userId);
        clearDispatchDraft(userId);
        setUserState(userId, "idle");
        await reply(replyToken, "已取消訂單");
        return;
      }

      if (activeOrder || state === "waiting_dispatch") {
        await reply(replyToken, "你目前已有進行中訂單，若要重新叫車請先輸入「取消」");
        return;
      }

      const prevDraft = getDispatchDraft(userId);
      const ai = await parseOrderFromText(text, { draft: prevDraft });

      let merged = prevDraft;
      if (ai) {
        merged = mergeDispatchDraft(prevDraft, ai.draft);
        setDispatchDraft(userId, merged);
      }

      const pickupBlockReason = pickupEmptyBlockReason(merged.pickup);
      const effectivePickupVerified =
        Boolean(ai?.pickup_verified) && !pickupBlockReason && Boolean(merged.pickup?.trim());
      const effectiveTimeClear =
        Boolean(ai?.time_clear) &&
        serverTimeLooksConcrete(merged.time) &&
        Boolean(merged.time?.trim());

      const driverReady =
        Boolean(ai) && effectivePickupVerified && effectiveTimeClear;

      if (driverReady) {
        const finalBlock = buildAcceleratedDispatchFormat(merged);
        const safeLead = stripDispatchMisleadingPhrases(ai.reply);
        const customerMsg = [safeLead, finalBlock].filter(Boolean).join("\n\n");
        await reply(replyToken, customerMsg);

        const form = draftToRideForm(merged, finalBlock);
        const order = createOrder(userId, form);
        clearDispatchDraft(userId);
        setUserState(userId, "waiting_dispatch", { orderId: order.orderId });

        await pushText(DRIVER_GROUP_ID, finalBlock);
        return;
      }

      if (state === "filling_form") {
        const legacyForm = parseRideForm(text);
        if (legacyForm) {
          const legacyDraft = legacyFormToDispatchDraft(legacyForm);
          const mergedFromLegacy = mergeDispatchDraft(merged, legacyDraft);
          setDispatchDraft(userId, mergedFromLegacy);
          await reply(
            replyToken,
            "已讀取您貼上的欄位。接下來仍須由調度依「地圖可定位」方式確認上車點，以及時間是否具體；**兩項都確認完成前，不會對司機群發送任何訊息**。請直接回覆要補充或確認的內容。"
          );
          return;
        }
      }

      if (ai) {
        await reply(replyToken, sanitizeNonDispatchReply(ai.reply));
        if (text.includes("叫車") && getUserState(userId) === "idle") {
          setUserState(userId, "filling_form");
        }
        return;
      }

      if (hasCarKeyword) {
        if (text.includes("叫車")) {
          setUserState(userId, "filling_form");
          await reply(
            replyToken,
`❤️‍🔥加速派車格式❤️‍🔥

日期：
時間：
上車：
下車：
人數：`
          );
          return;
        }
        await reply(replyToken, "調度連線忙碌，請稍後再試；或直接回覆「從哪裡到哪裡、時間、人數」。");
        return;
      }

      return;
    }

  } catch (err) {
    console.error("❌ error:", err);
  }
}

function createOrderId() {
  const id = `RS${String(nextOrderSeq).padStart(4, "0")}`;
  nextOrderSeq += 1;
  return id;
}

function createOrder(customerId, form) {
  const orderId = createOrderId();
  const newOrder = {
    orderId,
    status: "waiting",
    customerId,
    address: form.pickup,
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
  orders.push(newOrder);
  return newOrder;
}

function getActiveOrder(customerId) {
  const activeStatuses = new Set(["waiting", "matched", "arrived"]);
  for (let i = orders.length - 1; i >= 0; i -= 1) {
    const order = orders[i];
    if (order.customerId === customerId && activeStatuses.has(order.status)) {
      return order;
    }
  }
  return null;
}

function getNextWaitingOrder() {
  return orders.find((order) => order.status === "waiting");
}

function getWaitingOrderByPendingDriver(driverUserId) {
  return orders.find((order) => {
    const pending = pendingDriver[order.orderId];
    return order.status === "waiting" && pending && pending.userId === driverUserId;
  });
}

function getDriverOrderByStatus(driverUserId, status) {
  return orders.find((order) => order.driverId === driverUserId && order.status === status);
}

function isRideForm(text) {
  return /上車[:：]/.test(text) && /時間[:：]/.test(text);
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

  if (!pickup || !time) return null;

  return {
    pickup,
    dropoff: dropoff || "",
    time,
    date: date || "",
    passengers: passengers || "",
    rawText: text
  };
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

function getDispatchDraft(userId) {
  const d = users[userId]?.dispatchDraft;
  if (!d || typeof d !== "object") {
    return { date: "", time: "", pickup: "", dropoff: "", passengers: "" };
  }
  return {
    date: String(d.date ?? "").trim(),
    time: String(d.time ?? "").trim(),
    pickup: String(d.pickup ?? "").trim(),
    dropoff: String(d.dropoff ?? "").trim(),
    passengers: String(d.passengers ?? "").trim()
  };
}

function setDispatchDraft(userId, draft) {
  setUserState(userId, getUserState(userId), { dispatchDraft: draft });
}

function clearDispatchDraft(userId) {
  if (!users[userId]) return;
  delete users[userId].dispatchDraft;
}

function mergeDispatchDraft(base, patch) {
  const keys = ["date", "time", "pickup", "dropoff", "passengers"];
  const out = { ...base };
  for (const k of keys) {
    const v = patch?.[k];
    if (v != null && String(v).trim()) out[k] = String(v).trim();
  }
  return out;
}

/** 僅擋「完全沒有上車文字」；地址真偽一律交給 AI 以地圖／導航思維判斷 pickup_verified。 */
function pickupEmptyBlockReason(pickup) {
  if (!String(pickup ?? "").trim()) return "缺少上車地址";
  return null;
}

function serverTimeLooksConcrete(time) {
  const t = String(time ?? "").trim();
  if (t.length < 2) return false;
  if (
    /待會|等等|稍後|不確定|隨時|儘快|越快越好|看一下|再說|晚點|等等看|不曉得|不知道|可能|大概|應該|之後|有空|方便時/.test(
      t
    )
  ) {
    return false;
  }
  if (/\d/.test(t)) return true;
  if (/現在|立刻|馬上|立即|當下|隨時可走/.test(t)) return true;
  return false;
}

function stripDispatchMisleadingPhrases(text) {
  let t = String(text ?? "").trim();
  if (!t) return "";
  const banned = [
    "幫你安排司機",
    "幫您安排司機",
    "幫你安排",
    "幫您安排",
    "已為您安排司機",
    "已為你安排司機",
    "已安排司機",
    "已安排 司機",
    "司機正在來",
    "司機馬上到",
    "派車完成",
    "已派車",
    "已送出派單"
  ];
  for (const b of banned) {
    if (t.includes(b)) t = t.split(b).join("");
  }
  t = t.replace(/❤️‍🔥加速派車格式❤️‍🔥[\s\S]*/g, "").trim();
  return t.replace(/\s{2,}/g, " ").trim();
}

function sanitizeNonDispatchReply(text) {
  let t = stripDispatchMisleadingPhrases(text);
  t = t.replace(/❤️‍🔥加速派車格式❤️‍🔥[\s\S]*/g, "").trim();
  if (!t || t.length < 4) {
    return "為確認可派車，請提供完整上車地址（縣市區＋路街門牌或明確地標）以及具體載客時間；若地址有疑義我會再向您核對，謝謝。";
  }
  return t;
}

function displayDispatchField(v) {
  const s = String(v ?? "").trim();
  return s || "未提供";
}

function buildAcceleratedDispatchFormat(d) {
  return `❤️‍🔥加速派車格式❤️‍🔥

日期：${displayDispatchField(d.date)}
時間：${displayDispatchField(d.time)}
上車：${displayDispatchField(d.pickup)}
下車：${displayDispatchField(d.dropoff)}
人數：${displayDispatchField(d.passengers)}`;
}

function draftToRideForm(d, rawText) {
  const pickup = String(d.pickup ?? "").trim();
  const time = String(d.time ?? "").trim();
  const dropoff = String(d.dropoff ?? "").trim();
  const date = String(d.date ?? "").trim();
  const passengers = String(d.passengers ?? "").trim();
  return {
    pickup,
    dropoff: dropoff || "未提供",
    time,
    date: date || null,
    passengers: passengers || null,
    rawText
  };
}

function legacyFormToDispatchDraft(form) {
  return {
    date: String(form.date ?? "").trim(),
    time: String(form.time ?? "").trim(),
    pickup: String(form.pickup ?? "").trim(),
    dropoff: String(form.dropoff ?? "").trim(),
    passengers: String(form.passengers ?? "").trim()
  };
}

// ========================
async function reply(token, text) {
  try {
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: token,
        messages: [{ type: "text", text }]
      })
    });
  } catch (err) {
    console.error("❌ reply error:", err);
  }
}

// ========================
app.listen(PORT, () => {
  console.log("🚀 running on", PORT);
});