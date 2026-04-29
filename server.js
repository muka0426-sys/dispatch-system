import "dotenv/config";
import express from "express";
import { pushText } from "./utils/line.js";

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
      const activeOrder = getActiveOrder(userId);
      if (!activeOrder) {
        if (text.includes("叫車") || text.includes("你好") || text.length <= 3) {
          await reply(replyToken, "請輸入上車地址");
          return;
        }

        // 👉 建單（只要有地址）
        const orderId = createOrderId();
        const newOrder = {
          orderId,
          status: "waiting",
          customerId: userId,
          address: text,
          createdAt: Date.now(),
          driverId: null,
          driverEta: null
        };
        orders.push(newOrder);

        await reply(replyToken, "幫你安排司機中");

        // 👉 丟司機群（只會一次）
        await pushText(
          DRIVER_GROUP_ID,
`🔥 RS 訂單

🆔 ${orderId}
📍 ${text}

👉 請喊：信義10`
        );

        return;
      }

      await reply(replyToken, "已在安排中");
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