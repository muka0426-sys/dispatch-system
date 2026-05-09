import "dotenv/config";
import express from "express";
import { pushText } from "./utils/line.js";
import fs from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  parseOrderFromText,
  createPenaltyTracker,
  parseRsDriverBid,
  parseRsDispatcherMark,
  parseRsStateSignal,
  pickRsLeadingBid,
  validateRsBid,
  canRsRapeTie,
  rsCheckOvercharge,
  getGoogleShortestRouteEstimate,
  estimateAirportFlatFareByKb,
  finalizeCustomerFareReply
} from "./utils/ai_v7.js";

console.log("[boot] server.js", {
  npm_package_version: process.env.npm_package_version ?? "(run via npm start to populate)",
  railwayGitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? "(unset)",
  railwayGitBranch: process.env.RAILWAY_GIT_BRANCH ?? "(unset)",
  cwd: process.cwd()
});

console.log("[System] ADMIN_GROUP_ID:", process.env.ADMIN_GROUP_ID);

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
const penaltyTracker = createPenaltyTracker();
const abnormalChargingDrivers = new Map(); // driverUserId -> { count, lastAtMs }
const activeAlarms = new Map(); // key(orderId) -> timeoutId

// user state (memory)
// idle | filling_form | waiting_dispatch
const users = {};

// 防重複
const handledEvents = new Set();

const DRIVER_GROUP_ID = "C0227c4e4d8988002cfcd6527a43d3ad3";
const ADMIN_GROUP_ID = (process.env.ADMIN_GROUP_ID || "").trim(); // keep for logs; pushes must use process.env.ADMIN_GROUP_ID

const KB_FILE = "knowledge_base.json";
let knowledgeBase = { routes: {} };
const pendingAdminPricing = []; // FIFO: { route_key, pickup, dropoff, customerId, baselineKm, baselineFare, confirmAmount }

const ALARMS_DB_FILE = "alarms_db.json";
let alarmsDb = { alarms: {}, waiting_dispatches: {} };

// v0.3.5：Railway 啟動防呆（同步建立缺失 JSON 檔）
function ensureJsonFileSync(path, defaultText = "{}") {
  try {
    if (!fs.existsSync(path)) fs.writeFileSync(path, defaultText, "utf8");
  } catch (e) {
    console.error("[ensureJsonFileSync]", path, e?.message || e);
  }
}

// v0.3.6：啟動最前面就確保檔案真的存在（不要只 try-catch）
ensureJsonFileSync(KB_FILE, "{}");
ensureJsonFileSync(ALARMS_DB_FILE, "{}");
if (!fs.existsSync(KB_FILE)) fs.writeFileSync(KB_FILE, "{}", "utf8");
if (!fs.existsSync(ALARMS_DB_FILE)) fs.writeFileSync(ALARMS_DB_FILE, "{}", "utf8");

console.log("--- v0.3.6 啟動成功，警報與解析已就緒 ---");

async function ensureJsonFile(path) {
  try {
    await readFile(path, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    await writeFile(path, "{}", "utf8");
  }
}

async function loadKnowledgeBase() {
  try {
    await ensureJsonFile(KB_FILE);
    const raw = await readFile(KB_FILE, "utf8");
    const obj = JSON.parse(raw);
    knowledgeBase = { routes: obj?.routes && typeof obj.routes === "object" ? obj.routes : {} };
  } catch {
    knowledgeBase = { routes: {} };
  }
}

async function saveKnowledgeBase() {
  const out = { version: "0.3.0", routes: knowledgeBase.routes || {} };
  await writeFile(KB_FILE, JSON.stringify(out, null, 2), "utf8");
}

async function updateKnowledgeBase(route_key, amount) {
  await loadKnowledgeBase();
  knowledgeBase.routes[route_key] = Math.round(amount);
  await saveKnowledgeBase();
}

function routeKey(pickup, dropoff) {
  return `${String(pickup ?? "").trim()} → ${String(dropoff ?? "").trim()}`;
}

async function loadAlarmsDb() {
  try {
    await ensureJsonFile(ALARMS_DB_FILE);
    const raw = await readFile(ALARMS_DB_FILE, "utf8");
    const obj = JSON.parse(raw);
    alarmsDb = {
      alarms: obj?.alarms && typeof obj.alarms === "object" ? obj.alarms : {},
      waiting_dispatches:
        obj?.waiting_dispatches && typeof obj.waiting_dispatches === "object"
          ? obj.waiting_dispatches
          : {}
    };
  } catch {
    alarmsDb = { alarms: {}, waiting_dispatches: {} };
  }
}

async function saveAlarmsDb() {
  const out = {
    version: "0.7.3",
    alarms: alarmsDb.alarms || {},
    waiting_dispatches: alarmsDb.waiting_dispatches || {}
  };
  await writeFile(ALARMS_DB_FILE, JSON.stringify(out, null, 2), "utf8");
}

async function upsertAlarmRecord(record) {
  alarmsDb.alarms = alarmsDb.alarms || {};
  alarmsDb.alarms[record.key] = record;
  await saveAlarmsDb();
}

/** 派單廣播前強制持久化；失敗則不可對司機群發送格式。 */
async function persistDispatchSnapshot(order, merged, finalBlock) {
  await loadAlarmsDb();
  alarmsDb.waiting_dispatches = alarmsDb.waiting_dispatches || {};
  alarmsDb.waiting_dispatches[order.orderId] = {
    orderId: order.orderId,
    customerId: order.customerId,
    pickup: String(order.pickup ?? ""),
    dropoff: String(order.dropoff ?? ""),
    date: order.date ?? null,
    time: String(order.time ?? ""),
    estimated_fare_text: String(merged.estimated_fare_text ?? ""),
    finalBlock,
    createdAtMs: order.createdAt,
    persistedAtMs: Date.now()
  };
  await saveAlarmsDb();
}

function removeOrderById(orderId) {
  const key = String(orderId ?? "");
  if (!key) return;
  const idx = orders.findIndex((o) => o.orderId === key);
  if (idx >= 0) orders.splice(idx, 1);
}

async function deleteAlarmRecord(key) {
  if (!key) return;
  delete alarmsDb.alarms[key];
  await saveAlarmsDb();
}

function scheduleAlarmFromRecord(r) {
  const rideMs = Number(r.rideTimestampMs);
  const fireAt = rideMs - 60 * 60_000;
  const delay = fireAt - Date.now();
  if (!Number.isFinite(delay) || delay <= 0) return;
  clearAlarm(r.key);
  const t = setTimeout(async () => {
    try {
      await pushText(
        process.env.ADMIN_GROUP_ID,
        `⚠️ [假資警報] 訂單號 ${r.orderId} 發車倒數 1 小時，請立即指派真實司機！\n上車：${r.pickup}\n下車：${r.dropoff}`
      );
      clearAlarm(r.key);
      await deleteAlarmRecord(r.key);
    } catch (e) {
      console.error("[alarmTimer]", e?.message || e);
    }
  }, delay);
  activeAlarms.set(r.key, t);
}

function bootLoadAlarms() {
  (async () => {
    await loadAlarmsDb();
    const now = Date.now();
    const entries = Object.values(alarmsDb.alarms || {});
    for (const r of entries) {
      const rideMs = Number(r.rideTimestampMs);
      const fireAt = rideMs - 60 * 60_000;
      if (!Number.isFinite(rideMs) || rideMs <= now) {
        await deleteAlarmRecord(r.key);
        continue;
      }
      if (fireAt <= now) {
        await deleteAlarmRecord(r.key);
        continue;
      }
      scheduleAlarmFromRecord(r);
    }
  })().catch((e) => console.error("[bootLoadAlarms]", e?.message || e));
}

function isAbnormalBossPrice({ amount, baselineFare }) {
  const a = Number(amount);
  const b = Number(baselineFare);
  if (!Number.isFinite(a) || a <= 0) return false;
  if (!Number.isFinite(b) || b <= 0) return false;
  // 以「多打一個 0」為常見錯誤：超過 2 倍或多 300 以上都先確認
  return a > b * 2 || a - b >= 300;
}

async function replyOnceToCustomer(customerId, text) {
  await pushText(customerId, text);
}

// ========================
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

(async () => {
  try {
    await ensureJsonFile(KB_FILE);
    await ensureJsonFile(ALARMS_DB_FILE);
  } catch (e) {
    console.error("[ensureJsonFile]", e?.message || e);
  }
  bootLoadAlarms();
})();

// ========================
function webhookHandler(req, res) {
  res.sendStatus(200);
  const events = req.body.events || [];
  for (const event of events) handleEvent(event);
}

app.post("/webhook", webhookHandler);
app.post("/callback", webhookHandler);

// ========================
async function handleEvent(event) {
  let replyToken = null;
  let sourceType = null;
  try {
    if (!event.replyToken) return;

    // 防重複
    if (handledEvents.has(event.replyToken)) return;
    handledEvents.add(event.replyToken);
    setTimeout(() => handledEvents.delete(event.replyToken), 60000);

    if (event.type !== "message" || event.message.type !== "text") return;

    replyToken = event.replyToken;
    const userId = event.source?.userId;
    const text = event.message.text.trim();
    sourceType = event.source?.type;

    console.log("收到訊息來源 ID:", event.source?.groupId || event.source?.userId);
    console.log("📩", sourceType, text);

    const hasTimeKeyword =
      /(\d{1,2}[\/\-]\d{1,2}\s*\d{1,2}:\d{2})/.test(text) ||
      /(今天|明天)\s*(凌晨|半夜)?\s*\d{1,2}/.test(text) ||
      /\d{1,2}\s*號\s*(凌晨|半夜)\s*\d{1,2}\s*點/.test(text) ||
      /\d{1,2}[\/\-]\d{1,2}\s*(凌晨|半夜)\s*\d{1,2}\s*點/.test(text);

    const hasDateKeyword =
      /\d{1,2}[\/\-]\d{1,2}/.test(text) ||
      /(今天|明天|\d{1,2}\s*號)/.test(text);

    const hasAirportKeyword = /(送機|接機)/.test(text);
    const hasLocationKeyword =
      /(到|->|從|上車|下車|板橋|桃機|機場|台北|新北|區|路|街|巷|號)/.test(text);

    const shouldParseAi = (hasAirportKeyword || hasTimeKeyword || hasDateKeyword) && hasLocationKeyword;

    // v0.3.6 審查修復：AI 解析只做一次，任何來源都不被 group return 擋掉
    let aiResult = null;
    if (
      shouldParseAi &&
      !(
        sourceType === "group" &&
        process.env.ADMIN_GROUP_ID &&
        event.source?.groupId === process.env.ADMIN_GROUP_ID &&
        text.startsWith("/報價")
      )
    ) {
      console.log("[AI] parseOrderFromText() input:", text);
      aiResult = await parseOrderFromText(text, {
        draft: { date: "", time: "", pickup: "", dropoff: "", passengers: "" }
      });
      console.log("[AI] Result:", aiResult);
    }

    // =========================
    // 👮 管理員群（動態教導）
    // =========================
    // v0.3.6 審查修復：假資警報（任何來源，只要 AI 解析到 is_fake+ride_timestamp）
    if (aiResult?.is_fake && aiResult?.ride_timestamp && process.env.ADMIN_GROUP_ID) {
      const rideTimestamp = normalizeRideTimestampYearTo2026(aiResult.ride_timestamp);
      const rideMs = rideTimestamp ? Date.parse(rideTimestamp) : NaN;
      if (Number.isFinite(rideMs) && rideMs > Date.now()) {
        const remainingMs = rideMs - Date.now();
        const key = `${sourceType}_${event.source?.groupId || event.source?.userId}_${rideMs}`;
        const pickup = aiResult?.draft?.pickup || "未提供";
        const dropoff = aiResult?.draft?.dropoff || "未提供";

        console.log("[Alarm] is_fake=true, ride_timestamp:", rideTimestamp, "remainingMs:", remainingMs);

        if (remainingMs <= 60 * 60_000) {
          console.log("[Alarm] immediate push to ADMIN_GROUP_ID");
          await pushText(
            process.env.ADMIN_GROUP_ID,
            `⚠️ [假資警報] 訂單號 ${key} 發車倒數 1 小時，請立即指派真實司機！\n上車：${pickup}\n下車：${dropoff}`
          );
        } else {
          console.log("[Alarm] schedule timer + persist");
          scheduleAlarmFromRecord({
            key,
            orderId: key,
            customerId: String(event.source?.groupId || event.source?.userId || ""),
            pickup,
            dropoff,
            rideTimestampMs: rideMs,
            createdAtMs: Date.now()
          });
          upsertAlarmRecord({
            key,
            orderId: key,
            customerId: String(event.source?.groupId || event.source?.userId || ""),
            pickup,
            dropoff,
            rideTimestampMs: rideMs,
            createdAtMs: Date.now()
          }).catch((e) => console.error("[upsertAlarmRecord]", e?.message || e));
          console.log("[Timer] 成功設定假資警報，目標時間:", rideTimestamp);
        }
      }
    }

    if (sourceType === "group") {
      if (process.env.ADMIN_GROUP_ID && event.source.groupId === process.env.ADMIN_GROUP_ID) {
        if (text.startsWith("/報價")) {
          const m = text.match(/^\/報價\s+(\d+)(?:\s+(fix))?\s*$/);
          const amount = m ? Number(m[1]) : NaN;
          const isFix = Boolean(m?.[2]);
          if (!Number.isFinite(amount) || amount <= 0) {
            await reply(replyToken, "格式錯誤，請回覆：/報價 金額（例如 /報價 250）");
            return;
          }
          const req = pendingAdminPricing.shift();
          if (!req) {
            await reply(replyToken, "目前沒有待報價路線。");
            return;
          }

          // 防呆：明顯高於系統估計值 → 先要求確認
          if (isAbnormalBossPrice({ amount, baselineFare: req.baselineFare }) && req.confirmAmount !== amount) {
            // 放回隊列最前面，並記住待確認金額
            req.confirmAmount = amount;
            pendingAdminPricing.unshift(req);
            await reply(
              replyToken,
              `老闆，確認是報價 $${Math.round(amount)} 嗎？此價格高於系統估計值 $${Math.round(req.baselineFare)}。`
            );
            return;
          }

          if (isFix) {
            await updateKnowledgeBase(req.route_key, amount);
            await reply(replyToken, `已永久學習：${req.route_key} = $${Math.round(amount)}`);
          } else {
            await reply(replyToken, `已回覆一次：${req.route_key} = $${Math.round(amount)}（未存檔）`);
          }

          // 轉發回原乘客（replyOnce：只回覆一次，不影響學習）
          await replyOnceToCustomer(
            req.customerId,
            `收到，這趟先估$${Math.round(amount)}左右，可以嗎？要的話回我時間。`
          );
          return;
        }

        // v0.5.0：/遲到 指令（折扣規則）
        // 格式：/遲到 {分鐘} {原車資}
        if (text.startsWith("/遲到")) {
          const m = text.match(/^\/遲到\s+(\d+)\s+(\d+)\s*$/);
          const lateMin = m ? Number(m[1]) : NaN;
          const fare = m ? Number(m[2]) : NaN;
          if (!Number.isFinite(lateMin) || lateMin < 0 || !Number.isFinite(fare) || fare <= 0) {
            await reply(replyToken, "格式錯誤，請回覆：/遲到 分鐘 原車資（例如 /遲到 8 300）");
            return;
          }

          const ratio = lateMin <= 10 ? 0.8 : 0.6;
          const discounted = Math.round(fare * ratio);
          await reply(
            replyToken,
            `遲到補償：${lateMin}分 → ${Math.round(ratio * 100)}折，原$${fare} → $${discounted}`
          );
          return;
        }
        return;
      }

      // v0.3.6：此處不再做第二次 AI 解析；AI 已在上方 shouldParseAi 區塊統一處理
      if (event.source.groupId !== DRIVER_GROUP_ID) {
        return;
      }
      if (orders.length === 0) return;

      const dispatcherMark = parseRsDispatcherMark(text);
      const waitingOrder = getWaitingOrderForDriverMessage(text, {
        isDispatcherMark: Boolean(dispatcherMark)
      });
      if (!waitingOrder) return;

      waitingOrder.rs = waitingOrder.rs || {
        timing: waitingOrder.date ? "reservation" : "instant",
        bids: [],
        dispatcherMarkedAtMs: null,
        assignedAtMs: null,
        assignedDriverUserId: null,
        arrivedTimer: null
      };

      // ===== 派單員標記（@）→ 立刻自動噴車卡 =====
      if (dispatcherMark) {
        waitingOrder.rs.dispatcherMarkedAtMs = Date.now();
        const leader = pickRsLeadingBid({ timing: waitingOrder.rs.timing, bids: waitingOrder.rs.bids });
        if (!leader) {
          await reply(replyToken, "目前沒有有效喊單，先喊單再標記喔。");
          return;
        }

        waitingOrder.status = "matched";
        waitingOrder.driverId = leader.driverUserId;
        waitingOrder.driverEta = leader.kind === "minutes" ? String(leader.minutes ?? "") : "準";
        waitingOrder.rs.assignedAtMs = Date.now();
        waitingOrder.rs.assignedDriverUserId = leader.driverUserId;

        await reply(replyToken, "已標記，車卡我這邊直接噴。");

        await pushText(
          waitingOrder.customerId,
`🚗 已為您安排司機

司機${waitingOrder.driverEta}${waitingOrder.driverEta === "準" ? "" : "分"}抵達`
        );

        const cardText = getDriverCardText(leader.driverUserId);
        await pushText(waitingOrder.customerId, cardText);
        return;
      }

      // ===== 喊單 =====
      const bid = parseRsDriverBid(text);
      if (bid.kind === "ready" || bid.kind === "minutes") {
        const validation = validateRsBid({ timing: waitingOrder.rs.timing, bid });
        if (!validation.ok) {
          await reply(replyToken, validation.reason);
          return;
        }

        const newBid = {
          driverUserId: userId,
          createdAtMs: Date.now(),
          kind: bid.kind,
          minutes: bid.kind === "minutes" ? bid.minutes : undefined
        };

        const prevLeader = pickRsLeadingBid({ timing: waitingOrder.rs.timing, bids: waitingOrder.rs.bids });
        waitingOrder.rs.bids.push(newBid);
        const leader = pickRsLeadingBid({ timing: waitingOrder.rs.timing, bids: waitingOrder.rs.bids });

          // 同分強姦：同分後喊者可強姦取代；若已標記，僅「寶劍 1 分鐘內有效」
        if (
          canRsRapeTie({
            timing: waitingOrder.rs.timing,
            leadingBid: prevLeader,
            challengerBid: newBid,
            dispatcherMarkedAtMs: waitingOrder.rs.dispatcherMarkedAtMs,
            assignedAtMs: waitingOrder.rs.assignedAtMs
          })
        ) {
          // 以「後喊者」覆蓋為 leader（同分情境），並登記賠償追蹤
          penaltyTracker.onRapeSuccess({
            orderId: waitingOrder.orderId,
            fromDriverUserId: prevLeader?.driverUserId,
            toDriverUserId: newBid.driverUserId,
            bidMinutes: newBid.minutes,
            assignedAtMs: waitingOrder.rs.assignedAtMs || Date.now()
          });

          await reply(replyToken, "同分可強姦成立，先等派單員標記。");
          return;
        }

        if (leader && leader.driverUserId === userId) {
          const eta = leader.kind === "minutes" ? String(leader.minutes ?? "") : "準";
          pendingDriver[waitingOrder.orderId] = { userId, time: eta };
          await reply(replyToken, `目前領先：${eta}${eta === "準" ? "" : "分"}，等派單員@標記我就噴車卡。`);
          return;
        }

        await reply(replyToken, "收到，你目前不是領先喊單。");
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
        penaltyTracker.onArrived({ orderId: matchedOrder.orderId, arrivedAtMs: Date.now() });

        if (matchedOrder.rs?.arrivedTimer) clearTimeout(matchedOrder.rs.arrivedTimer);
        matchedOrder.rs = matchedOrder.rs || {};
        matchedOrder.rs.arrivedTimer = setTimeout(async () => {
          try {
            await pushText(
              matchedOrder.customerId,
              "司機已到點，提醒一下：超過5分鐘會開始等候費，1分鐘都是5元喲🥰"
            );
          } catch (e) {
            console.error("[arrivedTimer]", e?.message || e);
          }
        }, 5 * 60_000);

        await reply(replyToken, "已通知客人");

        await pushText(
          matchedOrder.customerId,
`📍 司機已抵達，請準備上車`
        );

        return;
      }

      // ===== 上車 =====
      const arrivedOrder = getDriverOrderByStatus(userId, "arrived");
      if (arrivedOrder && text.includes("客上")) {
        arrivedOrder.status = "onboard";

        await pushText(
          arrivedOrder.customerId,
`✅ 司機已回報您已上車
感謝您的搭乘 🙏`
        );

        return;
      }

      // ===== 客下 {公里}/{車資}：核對 5/2 直走表 =====
      const onboardOrder = getDriverOrderByStatus(userId, "onboard");
      const state = parseRsStateSignal(text);
      if (onboardOrder && state.kind === "dropoff") {
        const check = rsCheckOvercharge({ km: state.km, fare: state.fare });
        penaltyTracker.onFareKnown({ orderId: onboardOrder.orderId, fare: state.fare });

        // v0.2.1：結單稽核（回報金額/里程 vs Google最短預估）
        const baselineFare = Number(onboardOrder?.estimatedRouteFare ?? NaN);
        const baselineKm = Number(onboardOrder?.estimatedRouteKm ?? NaN);
        const baselineValid = Number.isFinite(baselineFare) && baselineFare > 0 && Number.isFinite(baselineKm) && baselineKm > 0;
        const reportedKm = Number(state.km);
        const reportedFare = Number(state.fare);
        const reportedValid = Number.isFinite(reportedKm) && reportedKm > 0 && Number.isFinite(reportedFare) && reportedFare > 0;

        if (baselineValid && reportedValid) {
          const diffFare = reportedFare - baselineFare;
          const kmDeviationRate = Math.abs(reportedKm - baselineKm) / baselineKm; // 0~inf
          const isAbnormal = diffFare > 30 || kmDeviationRate > 0.2;

          if (isAbnormal) {
            const prev = abnormalChargingDrivers.get(userId) || { count: 0, lastAtMs: 0 };
            abnormalChargingDrivers.set(userId, { count: prev.count + 1, lastAtMs: Date.now() });

            // 群組：真人介入（禁止肯定句）
            await reply(
              replyToken,
              `此趟行程費用 ($${reportedFare}) 與系統預估最短里程 ($${baselineFare}) 偏差較大，已轉交由行政人員進行人工審核結單。`
            );

            // 管理員群：送出整理資訊
            const adminMsg =
              `【異常收費待審】\n` +
              `司機編號：${userId}\n` +
              `訂單：${onboardOrder.orderId}\n` +
              `上車：${onboardOrder.pickup || onboardOrder.address || "未提供"}\n` +
              `下車：${onboardOrder.dropoff || "未提供"}\n` +
              `系統最短：${baselineKm}km / $${baselineFare}\n` +
              `司機回報：${reportedKm}km / $${reportedFare}\n` +
              `差額：$${Math.round(diffFare)}；里程偏差：${Math.round(kmDeviationRate * 100)}%`;
            if (process.env.ADMIN_GROUP_ID) {
              await pushText(process.env.ADMIN_GROUP_ID, adminMsg);
            } else {
              console.error("[ADMIN_GROUP_ID] unset, admin message:", adminMsg);
            }

            await appendLogicErrorLog({
              title: "司機異常收費：差額>30或里程偏差>20%（真人審核）",
              driverUserId: userId,
              orderId: onboardOrder.orderId,
              baselineKm,
              baselineFare,
              reportedKm,
              reportedFare
            });

            return;
          }
        }

        const comp = penaltyTracker.computeCompensation({ orderId: onboardOrder.orderId });
        if (comp) {
          await reply(
            replyToken,
            `強姦成功但遲到：需賠${comp.compensation}（車資3成）給被搶單司機。`
          );
        }

        if (!check.ok) {
          await reply(replyToken, `注意：5/2直走表預估${check.expected}，你填${state.fare}疑似溢收+${check.diff}`);
          return;
        }
        await reply(replyToken, `收到，5/2直走表預估${check.expected}，你填${state.fare}OK。`);
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
        clearAlarmByCustomer(userId);
        deleteOrderByCustomer(userId);
        clearDispatchDraft(userId);
        setUserState(userId, "idle");
        await reply(replyToken, "已取消訂單");
        return;
      }

      // v0.3.2：修改時間意圖 → 清除舊 alarm，更新 rideTimestamp 後重設 alarm
      const modifyTimeIntent =
        /改時間|修改時間|更改時間|延後|提前|改到|改成|挪到/.test(text) && getActiveOrder(userId);
      if (modifyTimeIntent) {
        const active = getActiveOrder(userId);
        clearAlarm(active.orderId);

        const aiTime = await parseOrderFromText(text, {
          draft: {
            date: active.date || "",
            time: active.time || "",
            pickup: active.pickup || active.address || "",
            dropoff: active.dropoff || "",
            passengers: String(active.passengers ?? "")
          }
        });

        if (aiTime?.ride_timestamp) {
          active.rideTimestamp = normalizeRideTimestampYearTo2026(aiTime.ride_timestamp);
          active.rideTimestampMs = active.rideTimestamp ? Date.parse(active.rideTimestamp) : NaN;
          if (Number.isFinite(active.rideTimestampMs) && active.isFake && active.date) {
            await scheduleFakeReservationAlert(active);
          }
          await reply(replyToken, "收到，時間已更新。");
          return;
        }

        await reply(replyToken, "收到，要改到哪天幾點呢？");
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

      // v0.3.0：未建檔路線 → 轉管理員報價（暫停對客回覆）
      // 惡搞／未核實上車點：嚴禁對管理群發求報價（避免蟑螂區等仍噴白目卡片）。
      if (
        ai?.needs_admin_pricing &&
        process.env.ADMIN_GROUP_ID &&
        !ai.is_fake &&
        Boolean(ai.pickup_verified)
      ) {
        const pickup = merged.pickup;
        const dropoff = merged.dropoff;
        const key = routeKey(pickup, dropoff);
        const est = await getGoogleShortestRouteEstimate({ origin: pickup, destination: dropoff });
        pendingAdminPricing.push({
          route_key: key,
          pickup,
          dropoff,
          customerId: userId,
          baselineKm: est?.km ?? null,
          baselineFare: est?.fare ?? null,
          confirmAmount: null
        });
        await pushText(
          process.env.ADMIN_GROUP_ID,
          `🆘 [未建檔路線求報價]\n上車：${pickup}\n下車：${dropoff}\n系統估計：${est ? `${est.km}km / $${est.fare}` : "未取得"}\n請回覆：/報價 {金額}（臨時） 或 /報價 {金額} fix（永久）`
        );
        return;
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
        // 知識庫機場定額（與 isAirportRideIntent 對齊）；避免 AI 誤走里程公式時卡片車資不符。
        const kbAirportFlat = await estimateAirportFlatFareByKb({
          pickup: merged.pickup,
          messageText: text,
          dropoff: merged.dropoff
        });
        if (kbAirportFlat != null) {
          const sur = Number(merged.fare_surcharge) || 0;
          let estLine = `機場定額 $${kbAirportFlat}；等候5分後$5/分`;
          if (sur > 0) estLine += `；加價+$${sur}`;
          merged = { ...merged, estimated_fare_text: estLine };
        }

        // v0.2.0：派單前抓 Google Map 最短里程估價（基準）
        const routeEst = await getGoogleShortestRouteEstimate({
          origin: merged.pickup,
          destination: merged.dropoff
        });
        if (routeEst) {
          merged = {
            ...merged,
            estimated_route_km: routeEst.km,
            estimated_route_fare: routeEst.fare,
            estimated_route_source: "google_shortest"
          };
        } else {
          merged = { ...merged, estimated_route_km: null, estimated_route_fare: null, estimated_route_source: null };
        }

        const finalBlock = buildAcceleratedDispatchFormat(merged);
        const safeLead = finalizeCustomerFareReply(
          stripDispatchMisleadingPhrases(ai.reply),
          merged.estimated_fare_text
        );
        const customerMsg = [safeLead, finalBlock].filter(Boolean).join("\n\n");

        const form = draftToRideForm(merged, finalBlock);
        const order = createOrder(userId, form);

        try {
          await persistDispatchSnapshot(order, merged, finalBlock);
        } catch (e) {
          console.error("[persistDispatchSnapshot]", e?.message || e);
          removeOrderById(order.orderId);
          await reply(replyToken, "系統存檔失敗，派單未完成，請稍後再試。");
          return;
        }

        // v0.3.0：假資預約單倒數警報（is_fake + ride_timestamp）
        if (order.isFake && order.rideTimestampMs && process.env.ADMIN_GROUP_ID) {
          await scheduleFakeReservationAlert(order);
        }

        clearDispatchDraft(userId);
        setUserState(userId, "waiting_dispatch", { orderId: order.orderId });

        await reply(replyToken, customerMsg);
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
    if (replyToken && sourceType === "user" && looksLikeGeminiError(err)) {
      await reply(replyToken, "調度連線忙碌中，請稍後再試");
      return;
    }
    console.error("❌ error:", err);
  }
}

async function scheduleFakeReservationAlert(order) {
  try {
    if (!order?.rideTimestampMs) return;
    clearAlarm(order.orderId);
    const fireAt = Number(order.rideTimestampMs) - 60 * 60_000;
    let delay = fireAt - Date.now();
    if (!Number.isFinite(delay)) return;

    console.log(
      "[Alarm Check] 最終發車時間:",
      order.rideTimestamp,
      "目前系統時間:",
      new Date().toISOString()
    );

    // v0.3.6：不足 60 分鐘 → 立刻警報（不等待、不 return）
    if (delay <= 0) {
      if (Number(order.rideTimestampMs) > Date.now() && process.env.ADMIN_GROUP_ID && order.isFake) {
        pushText(
          process.env.ADMIN_GROUP_ID,
          `⚠️ [假資警報] 訂單號 ${order.orderId} 發車倒數 1 小時，請立即指派真實司機！\n上車：${order.pickup}\n下車：${order.dropoff}`
        ).catch((e) => console.error("[fakeAlertImmediate]", e?.message || e));
        deleteAlarmRecord(String(order.orderId)).catch((e) => console.error("[deleteAlarmRecord]", e?.message || e));
      }
      delay = 0;
    }

    if (delay > 0) {
      if (order.fakeAlertTimer) clearTimeout(order.fakeAlertTimer);
      order.fakeAlertTimer = setTimeout(async () => {
        try {
          if (!order.isFake) return;
          await pushText(
            process.env.ADMIN_GROUP_ID,
            `⚠️ [假資警報] 訂單號 ${order.orderId} 發車倒數 1 小時，請立即指派真實司機！\n上車：${order.pickup}\n下車：${order.dropoff}`
          );
          await deleteAlarmRecord(String(order.orderId));
        } catch (e) {
          console.error("[fakeAlertTimer]", e?.message || e);
        }
      }, delay);
      activeAlarms.set(order.orderId, order.fakeAlertTimer);
      try {
        await upsertAlarmRecord({
          key: String(order.orderId),
          orderId: String(order.orderId),
          customerId: String(order.customerId),
          pickup: String(order.pickup ?? ""),
          dropoff: String(order.dropoff ?? ""),
          rideTimestampMs: Number(order.rideTimestampMs),
          createdAtMs: Date.now()
        });
      } catch (e) {
        console.error("[upsertAlarmRecord]", e?.message || e);
      }

      console.log("[Timer] 成功設定假資警報，目標時間:", order.rideTimestamp);
    }
  } catch (e) {
    console.error("[scheduleFakeReservationAlert]", e?.message || e);
  }
}

function normalizeRideTimestampYearTo2026(ts) {
  const s = String(ts ?? "").trim();
  if (!s) return null;
  if (/^(2024|2025)-/.test(s)) return s.replace(/^(2024|2025)-/, "2026-");
  return s;
}

function clearAlarm(orderId) {
  const key = String(orderId ?? "");
  if (!key) return;
  const t = activeAlarms.get(key);
  if (t) clearTimeout(t);
  activeAlarms.delete(key);
  deleteAlarmRecord(key).catch((e) => console.error("[deleteAlarmRecord]", e?.message || e));
}

function clearAlarmByCustomer(customerId) {
  const activeStatuses = new Set(["waiting", "matched", "arrived", "onboard"]);
  const order = orders.find((o) => o.customerId === customerId && activeStatuses.has(o.status));
  if (!order) return;
  clearAlarm(order.orderId);
}

function getDriverCardText(driverUserId) {
  const raw = (process.env.DRIVER_CARDS_JSON || "").trim();
  if (raw) {
    try {
      const map = JSON.parse(raw);
      const t = map?.[driverUserId];
      if (t) return String(t);
    } catch (e) {
      console.error("[DRIVER_CARDS_JSON] invalid json");
    }
  }
  return "（尚未設定車卡）";
}

async function appendLogicErrorLog({
  title,
  driverUserId,
  orderId,
  baselineKm,
  baselineFare,
  reportedKm,
  reportedFare
}) {
  try {
    const ts = new Date().toISOString();
    const lines = [
      "",
      `### ${title}`,
      `- **時間**：${ts}`,
      `- **版本/分支**：package.json@${process.env.npm_package_version ?? "0.2.0"}`,
      `- **模組/範圍**：server.js（司機結單稽核）`,
      `- **司機**：${driverUserId}`,
      `- **訂單**：${orderId}`,
      `- **Google最短預估**：${Number.isFinite(baselineKm) ? baselineKm : "?"}km / $${Number.isFinite(baselineFare) ? baselineFare : "?"}`,
      `- **司機回報**：${reportedKm}km / $${reportedFare}`,
      `- **判定**：回報金額高於預估超過 $30 → 標記「異常收費」並群內追問`,
      ""
    ].join("\n");
    await appendFile("logic_error_log.md", lines, "utf8");
  } catch (e) {
    console.error("[appendLogicErrorLog]", e?.message || e);
  }
}

function looksLikeGeminiError(err) {
  const status =
    err?.status ??
    err?.response?.status ??
    err?.response?.statusCode ??
    err?.cause?.status ??
    err?.cause?.response?.status;

  if (status === 429) return true;

  const text = `${err?.name ?? ""} ${err?.message ?? ""} ${err?.statusText ?? ""} ${err?.details ?? ""} ${err?.cause?.message ?? ""}`;
  return (
    /GoogleGenerativeAI/i.test(text) ||
    /generativelanguage\.googleapis\.com/i.test(text) ||
    /RESOURCE_EXHAUSTED/i.test(text) ||
    /\bquota\b/i.test(text) ||
    /\b429\b/.test(text)
  );
}

function createOrderId() {
  const id = `RS${String(nextOrderSeq).padStart(4, "0")}`;
  nextOrderSeq += 1;
  return id;
}

function createOrder(customerId, form) {
  const orderId = createOrderId();
  const normalizedRideTimestamp = normalizeRideTimestampYearTo2026(form.ride_timestamp);
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
    estimatedRouteKm: form.estimated_route_km ?? null,
    estimatedRouteFare: form.estimated_route_fare ?? null,
    estimatedRouteSource: form.estimated_route_source ?? null,
    isFake: Boolean(form.is_fake),
    rideTimestamp: normalizedRideTimestamp || null,
    rideTimestampMs: normalizedRideTimestamp ? Date.parse(normalizedRideTimestamp) : null,
    fakeAlertTimer: null,
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

/** 取 createdAt 最新的一筆 waiting（@ 標記、純分鐘喊單用）。 */
function getLatestWaitingOrder() {
  const waiting = orders.filter((order) => order.status === "waiting");
  if (!waiting.length) return null;
  return waiting.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
}

const DRIVER_BID_STOP_TOKENS = new Set([
  "派單員",
  "標記",
  "分鐘",
  "抵達",
  "出發",
  "目前",
  "領先",
  "收到",
  "司機",
  "有效",
  "喊單"
]);

function extractLocationTokensForBidMatch(text) {
  const t = String(text ?? "").trim();
  if (!t) return [];
  if (/^\d{1,3}\s*$/.test(t) || /^準\s*$/.test(t)) return [];
  const chunks = t.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return chunks.filter((c) => !DRIVER_BID_STOP_TOKENS.has(c));
}

function orderMatchesLocationTokens(order, tokens) {
  if (!tokens.length) return true;
  const hay = `${order.pickup || ""}${order.dropoff || ""}${order.address || ""}`;
  return tokens.some((tok) => hay.includes(tok));
}

/**
 * 司機群：@ 標記 → 永遠綁最新 waiting；喊單 → 優先比對訊息中的地名與訂單上／下車址（如：南港 ⊆ 台北市南港區）。
 */
function getWaitingOrderForDriverMessage(text, { isDispatcherMark }) {
  if (isDispatcherMark) return getLatestWaitingOrder();
  const waiting = orders
    .filter((order) => order.status === "waiting")
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!waiting.length) return null;
  if (waiting.length === 1) return waiting[0];
  const tokens = extractLocationTokensForBidMatch(text);
  const matched = waiting.filter((o) => orderMatchesLocationTokens(o, tokens));
  if (matched.length) return matched[0];
  return waiting[0];
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
  if (idx >= 0) {
    const removed = orders[idx];
    clearAlarm(removed?.orderId);
    orders.splice(idx, 1);
  }
}

function getDispatchDraft(userId) {
  const d = users[userId]?.dispatchDraft;
  if (!d || typeof d !== "object") {
    return {
      date: "",
      time: "",
      pickup: "",
      dropoff: "",
      passengers: "",
      vehicle_request_type: "",
      fare_surcharge: 0,
      estimated_fare_text: "",
      estimated_route_km: null,
      estimated_route_fare: null,
      estimated_route_source: null,
      is_fake: false,
      ride_timestamp: null
    };
  }
  return {
    date: String(d.date ?? "").trim(),
    time: String(d.time ?? "").trim(),
    pickup: String(d.pickup ?? "").trim(),
    dropoff: String(d.dropoff ?? "").trim(),
    passengers: String(d.passengers ?? "").trim(),
    vehicle_request_type: String(d.vehicle_request_type ?? "").trim(),
    fare_surcharge: Number(d.fare_surcharge ?? 0) || 0,
    estimated_fare_text: String(d.estimated_fare_text ?? "").trim(),
    estimated_route_km: d.estimated_route_km ?? null,
    estimated_route_fare: d.estimated_route_fare ?? null,
    estimated_route_source: d.estimated_route_source ?? null,
    is_fake: Boolean(d.is_fake),
    ride_timestamp: d.ride_timestamp || null
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
  const keys = [
    "date",
    "time",
    "pickup",
    "dropoff",
    "passengers",
    "vehicle_request_type",
    "fare_surcharge",
    "estimated_fare_text",
    "estimated_route_km",
    "estimated_route_fare",
    "estimated_route_source",
    "is_fake",
    "ride_timestamp"
  ];
  const out = { ...base };
  for (const k of keys) {
    const v = patch?.[k];
    if (k === "fare_surcharge") {
      if (v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[k] = Math.max(0, Math.min(100, Math.round(n)));
      continue;
    }
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
  const surcharge = Number(d.fare_surcharge ?? 0) || 0;
  const vtype = String(d.vehicle_request_type ?? "").trim();
  const vLabel = vtype === "suv" ? "休旅" : vtype === "double_b" ? "雙B" : vtype === "suv_double_b" ? "休旅/雙B" : "";
  const surchargeLine =
    surcharge > 0 ? `車資加成：+${Math.min(100, surcharge)} (${vLabel || "特殊需求"})` : "車資加成：+0";
  const fareLine = `預計車資：${String(d.estimated_fare_text ?? "").trim() || "未提供"}`;
  const routeLine =
    d.estimated_route_km && d.estimated_route_fare
      ? `最短里程估價：${d.estimated_route_km}km ($${d.estimated_route_fare})`
      : "最短里程估價：未取得";
  const needLine = `車型/需求：${vLabel || "一般"}`;
  return `❤️‍🔥加速派車格式❤️‍🔥

日期：${displayDispatchField(d.date)}
時間：${displayDispatchField(d.time)}
上車：${displayDispatchField(d.pickup)}
下車：${displayDispatchField(d.dropoff)}
人數：${displayDispatchField(d.passengers)}
${needLine}
${fareLine}
${routeLine}
${surchargeLine}`;
}

function draftToRideForm(d, rawText) {
  const pickup = String(d.pickup ?? "").trim();
  const time = String(d.time ?? "").trim();
  const dropoff = String(d.dropoff ?? "").trim();
  const date = String(d.date ?? "").trim();
  const passengers = String(d.passengers ?? "").trim();
  const vehicle_request_type = String(d.vehicle_request_type ?? "").trim();
  const fare_surcharge = Number(d.fare_surcharge ?? 0) || 0;
  const estimated_fare_text = String(d.estimated_fare_text ?? "").trim();
  const estimated_route_km = d.estimated_route_km ?? null;
  const estimated_route_fare = d.estimated_route_fare ?? null;
  const estimated_route_source = d.estimated_route_source ?? null;
  const is_fake = Boolean(d.is_fake);
  const ride_timestamp = d.ride_timestamp || null;
  return {
    pickup,
    dropoff: dropoff || "未提供",
    time,
    date: date || null,
    passengers: passengers || null,
    vehicle_request_type: vehicle_request_type || null,
    fare_surcharge: Math.max(0, Math.min(100, Math.round(fare_surcharge))) || null,
    estimated_fare_text: estimated_fare_text || null,
    estimated_route_km,
    estimated_route_fare,
    estimated_route_source,
    is_fake,
    ride_timestamp,
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