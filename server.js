import "dotenv/config";
import express from "express";
import { pushText } from "./utils/line.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== 狀態 =====
let currentOrder = null;
/*
status:
idle → waiting → matched → arrived → onboard → done
*/

let pendingDriver = null;

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
      if (!currentOrder) return;

      // ===== 喊單 =====
      const bidMatch = text.match(/(.+?)(\d+)/);

      if (currentOrder.status === "waiting" && bidMatch && !pendingDriver) {

        const time = bidMatch[2];

        pendingDriver = {
          userId,
          time
        };

        await reply(replyToken, `司機${time}分(抵達)\n請貼車卡`);
        return;
      }

      // ===== 車卡 =====
      if (currentOrder.status === "waiting" && pendingDriver && pendingDriver.userId === userId) {

        currentOrder.status = "matched";

        await reply(replyToken, "已派你出發 🚗");

        await pushText(
          currentOrder.customerId,
`🚗 已為您安排司機

司機${pendingDriver.time}分抵達`
        );

        // 👉 再補車卡（第二則）
        await pushText(currentOrder.customerId, text);

        return;
      }

      // ===== 到點 =====
      if (currentOrder.status === "matched" && text.includes("到")) {

        currentOrder.status = "arrived";

        await reply(replyToken, "已通知客人");

        await pushText(
          currentOrder.customerId,
`📍 司機已抵達，請準備上車`
        );

        return;
      }

      // ===== 上車 =====
      if (currentOrder.status === "arrived" && text.includes("上")) {

        currentOrder.status = "onboard";

        await pushText(
          currentOrder.customerId,
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

      // 👉 沒訂單
      if (!currentOrder || currentOrder.status === "done") {

        // 問候 / 無效
        if (text.length <= 3 || text.includes("你好") || text.includes("叫車")) {
          await reply(replyToken,
`您好 👋
請問哪裡需要車呢？

請直接輸入上車地點
例如：
信義區松山路123號`);
          return;
        }

        // 👉 建單（只要有地址）
        currentOrder = {
          status: "waiting",
          customerId: userId,
          address: text
        };

        pendingDriver = null;

        await reply(replyToken, "好的，幫您安排司機中 🚕");

        // 👉 丟司機群（只會一次）
        await pushText(
          DRIVER_GROUP_ID,
`🔥 RS 訂單

📍 ${text}

👉 請喊：信義10`
        );

        return;
      }

      // 👉 已在叫車
      if (currentOrder.status === "waiting") {
        await reply(replyToken, "已在幫您安排司機，請稍等 🚕");
        return;
      }

      // 👉 已派車
      if (currentOrder.status === "matched") {
        await reply(replyToken, "司機正在前往中 🚗");
        return;
      }

      // 👉 已完成
      if (currentOrder.status === "onboard") {
        await reply(replyToken, "祝您旅途愉快 🙏");
        return;
      }
    }

  } catch (err) {
    console.error("❌ error:", err);
  }
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