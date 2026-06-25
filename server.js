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
  finalizeCustomerFareReply,
  looksLikePricingQuestion,
  classifyPendingQuoteReplyWithAi
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
/** v0.7.17：司機主群無待接單時的報班紀錄（記憶體，供稽核／除錯） */
const driverAdminCheckins = [];
const abnormalChargingDrivers = new Map(); // driverUserId -> { count, lastAtMs }
const activeAlarms = new Map(); // key(orderId) -> timeoutId

// user state (memory)
// idle | filling_form | waiting_dispatch
const MAX_CONVERSATION_TURNS = 16;
const users = {};

// 防重複
const handledEvents = new Set();

const DRIVER_GROUP_ID = (process.env.DRIVER_GROUP_ID || "C0227c4e4d8988002cfcd6527a43d3ad3").trim();
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

function googleMapsApiKey() {
  return String(
    process.env.Maps_API_KEY ??
      process.env.MAPS_API_KEY ??
      process.env.GOOGLE_MAPS_API_KEY ??
      ""
  ).trim();
}

function sanitizePickupAddressForMaps(pickup) {
  let s = String(pickup ?? "").trim();
  if (!s) return "";

  s = s
    .replace(/[（(][^()（）]*[）)]/g, " ")
    .replace(/❤️‍🔥加速派車格式❤️‍🔥[\s\S]*/g, " ")
    .replace(/^(上車|地址|地點|位置|pickup)\s*[:：]\s*/i, "")
    .replace(/(我要叫車|要叫車|叫車|幫我叫車|幫我派車|派車|上車在|我在|人在|從|出發|附近|旁邊|旁|門口|這邊)/g, " ")
    .replace(/(麻煩|謝謝|謝啦|可以嗎|可以|幫忙|請問|請|喔|哦|啦|啊|～|~)/g, " ")
    .replace(/[，,。！!？?；;]+/g, " ")
    .replace(/\s+/g, "");

  return s;
}

function normalizeTaiwanAddressChars(s) {
  return String(s ?? "")
    .replace(/\u81fa/g, "\u53f0")
    .trim();
}

function pickAddressComponent(components, typeName) {
  if (!Array.isArray(components)) return "";
  for (const c of components) {
    if ((c.types || []).includes(typeName)) {
      return normalizeTaiwanAddressChars(String(c.long_name || c.short_name || "").trim());
    }
  }
  return "";
}

/**
 * v0.7.17：僅用 address_components 組短地址（縣市＋區＋路＋門牌），禁止直接使用未處理的 formatted_address。
 */
function buildShortTaiwanStreetFromComponents(components) {
  if (!Array.isArray(components) || !components.length) return "";
  const a1 = pickAddressComponent(components, "administrative_area_level_1");
  const a2 =
    pickAddressComponent(components, "administrative_area_level_2") ||
    pickAddressComponent(components, "administrative_area_level_3") ||
    pickAddressComponent(components, "locality") ||
    pickAddressComponent(components, "sublocality_level_1");
  const route = pickAddressComponent(components, "route");
  const sn = pickAddressComponent(components, "street_number");
  let s = `${a1}${a2}${route}`;
  if (sn) s += `${sn}號`;
  return s.replace(/\s+/g, "").trim();
}

/**
 * v0.7.17：無法精準組件解析時，用 Regex 清洗 formatted_address（郵遞區號、台灣、村里鄰、號後贅詞）。
 */
function cleanFormattedAddressFallback(formatted) {
  let s = normalizeTaiwanAddressChars(String(formatted ?? "").trim());
  s = s.replace(/^\d{3}\s*-?\s*\d{3}\s*/, "");
  s = s.replace(/^\d{5,8}\s*/, "");
  s = s.replace(/^台灣\s*|^臺灣\s*/, "");
  s = s.replace(/台灣|臺灣/g, "");
  s = s.replace(/[\u4e00-\u9fff]{2,5}里(?:[\u4e00-\u9fff]{1,4}鄰)?(?=[\u4e00-\u9fff]{0,12}(?:路|街|段|巷|弄))/g, "");
  s = s.replace(/\s+/g, "");
  s = s.replace(/(號)(?![之樓弄巷\d\-\.Ff])([^\d，,。；;／/\s].*)$/u, "$1");
  return s.trim();
}

function shortenGeocodeDisplayAddress(best) {
  const formatted = String(best?.formatted_address ?? "").trim();
  const fromParts = buildShortTaiwanStreetFromComponents(best?.address_components);
  if (fromParts && /(路|街|段|巷|弄)/.test(fromParts) && fromParts.length >= 6) return fromParts;
  const fb = cleanFormattedAddressFallback(formatted);
  return fb || normalizeTaiwanAddressChars(formatted);
}

async function verifyPickupAddressWithGoogleMaps(pickup) {
  // [CRITICAL] 嚴禁移除或繞過此 Google Maps 驗證邏輯。
  // 所有極速盲派完整派車卡都必須先通過此函式確認地址存在且夠明確。
  const address = sanitizePickupAddressForMaps(pickup);
  console.log(`[MAP_DEBUG] 送往驗證的地址字串：${address}`);
  if (!address) return { ok: false, reason: "empty" };

  const key = googleMapsApiKey();
  if (!key) {
    console.error("[Maps Verify] Missing Maps_API_KEY/MAPS_API_KEY/GOOGLE_MAPS_API_KEY");
    return { ok: false, reason: "missing_api_key" };
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(address)}` +
    "&region=tw&language=zh-TW" +
    `&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = await res.json();
    if (data?.status !== "OK") {
      console.log("[MAP_DEBUG] Google Maps 非 OK 回傳：", JSON.stringify(data));
      return { ok: false, reason: data?.status || "not_ok" };
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    // v0.7.14：絕對信任 Google 導航結果。只要 status=OK 且有第一筆結果，不再自行過濾 location_type/types/partial_match。
    const best = results[0];
    if (!best) {
      console.log("[MAP_DEBUG] Google Maps OK 但無 results：", JSON.stringify(data));
      return { ok: false, reason: "ok_no_results" };
    }
    const cleanAddr = shortenGeocodeDisplayAddress(best);
    return {
      ok: true,
      formatted_address: cleanAddr || String(best.formatted_address ?? address).trim(),
      place_id: String(best.place_id ?? "").trim(),
      location: best.geometry?.location ?? null,
      types: best.types || []
    };
  } catch (e) {
    console.error("[Maps Verify]", e?.message || e);
    return { ok: false, reason: "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
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
    version: "0.7.21",
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
  const safeMerged = forceDispatchDraftToday(merged);
  const mergedDateRaw = String(safeMerged.date ?? "").trim();
  const persistDateYmd = mergedDateRaw
    ? orderBookingYmd({ date: mergedDateRaw, rideTimestampMs: null, createdAt: Date.now() }) || todayYmdTaipei()
    : String(order.date ?? "").trim() || todayYmdTaipei();
  order.date = persistDateYmd;
  const safeFinalBlock = forceDispatchBlockToday(buildAcceleratedDispatchFormat(safeMerged), persistDateYmd);
  const lockedFinalBlock =
    hasDispatchCardSent(order) && String(order.formText ?? "").trim()
      ? forceDispatchBlockToday(order.formText, persistDateYmd)
      : safeFinalBlock;
  alarmsDb.waiting_dispatches = alarmsDb.waiting_dispatches || {};
  alarmsDb.waiting_dispatches[order.orderId] = {
    orderId: order.orderId,
    customerId: order.customerId,
    pickup: String(order.pickup ?? ""),
    dropoff: String(order.dropoff ?? ""),
    date: persistDateYmd,
    time: String(order.time ?? ""),
    estimated_fare_text: String(safeMerged.estimated_fare_text ?? ""),
    finalBlock: lockedFinalBlock,
    dispatchCardSent: Boolean(order.dispatchCardSent),
    dispatchCardSentAtMs: order.dispatchCardSentAtMs ?? null,
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

function getLatestCustomerOrder(customerId) {
  const cid = String(customerId ?? "");
  if (!cid) return null;
  for (let i = orders.length - 1; i >= 0; i -= 1) {
    const order = orders[i];
    if (order.customerId === cid) return order;
  }
  return null;
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

    const adminGid = (process.env.ADMIN_GROUP_ID || "").trim();
    // v0.7.17：司機主群物理分流（最前）：禁止進入客群 AI／假資警報／叫車補全流程
    if (sourceType === "group" && adminGid && event.source?.groupId === adminGid) {
      console.log("[ADMIN_DRIVER][v0.7.17]", event.source?.groupId, text);
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
        if (isAbnormalBossPrice({ amount, baselineFare: req.baselineFare }) && req.confirmAmount !== amount) {
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
        await replyOnceToCustomer(
          req.customerId,
          `收到，這趟先估$${Math.round(amount)}左右，可以嗎？要的話回我時間。`
        );
        return;
      }
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
      await processDriverFleetGroupMessage(event, replyToken, userId, text, { allowIdleCheckin: true });
      return;
    }

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

    const isDriverFleetLineGroup = sourceType === "group" && event.source?.groupId === DRIVER_GROUP_ID;
    // 司機 LINE 群不走乘客叫車前置 AI（主群已於最前 return）
    const skipPassengerAiPreparse = isDriverFleetLineGroup;

    // v0.3.6 審查修復：AI 解析只做一次，任何來源都不被 group return 擋掉
    let aiResult = null;
    if (shouldParseAi && !skipPassengerAiPreparse) {
      console.log("[AI] parseOrderFromText() input:", text);
      const currentDateTime = new Date();
      aiResult = await parseOrderFromText(text, {
        draft: { date: "", time: "", pickup: "", dropoff: "", passengers: "" },
        now: currentDateTime
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
      if (event.source.groupId === DRIVER_GROUP_ID) {
        await processDriverFleetGroupMessage(event, replyToken, userId, text, { allowIdleCheckin: false });
      }
      return;
    }

    // =========================
    // 🧑 客人（真人邏輯）
    // =========================
    if (sourceType === "user") {
      const state = getUserState(userId);
      const hasCarKeyword = text.includes("叫車") || text.includes("車");

      // ===== 最小安全版：客人取消攔截器 V3.6（必須在 appendConversationTurn 前）=====
      {
        // 只建立取消判斷用影子字串，不污染原始 text
        const cancelProbe = String(text ?? "")
          .trim()
          .toLowerCase()
          .replace(/[\s\r\n\t　]+/g, "")
          .replace(/[，。！？、,.!?；;：:「」『』（）()【】\[\]《》<>／\/\\\-＿_~～…·•]/g, "");

        const isCancelNegatedOrQuestion =
          cancelProbe.includes("不要取消") ||
          cancelProbe.includes("不要幫我取消") ||
          cancelProbe.includes("我不是要取消") ||
          cancelProbe.includes("取消了嗎") ||
          cancelProbe.includes("可以取消嗎") ||
          cancelProbe.includes("可不可以取消") ||
          cancelProbe.includes("能取消嗎") ||
          cancelProbe.includes("別幫我取消") ||
          cancelProbe.includes("別取消") ||
          cancelProbe.includes("先別取消") ||
          cancelProbe.includes("是不是取消了") ||
          cancelProbe.includes("剛剛是不是取消了") ||
          cancelProbe.includes("取消費") ||
          cancelProbe.includes("取消規則") ||
          cancelProbe.includes("取消會怎樣") ||
          cancelProbe.includes("取消要錢嗎") ||
          cancelProbe.includes("不用幫我取消") ||
          cancelProbe.includes("不用取消") ||
          cancelProbe.includes("如果取消") ||
          cancelProbe.includes("怎麼取消");

        const isExplicitCancel =
          cancelProbe.includes("幫我取消") ||
          cancelProbe.includes("不叫了") ||
          cancelProbe.includes("不用了") ||
          cancelProbe.includes("那算了") ||
          cancelProbe.includes("算了") ||
          cancelProbe.includes("先不用") ||
          cancelProbe.includes("不坐了") ||
          cancelProbe === "取消" ||
          cancelProbe.endsWith("取消");

        if (isExplicitCancel && !isCancelNegatedOrQuestion) {
          const active = getActiveOrder(userId) || getLatestCustomerOrder(userId);
          const status = String(active?.status ?? "").toLowerCase();

          // 沒有任何訂單：阻斷取消進 AI，清理客人端暫存
          if (!active) {
            clearDispatchDraft(userId);
            clearPendingDispatchConfirmation(userId);
            clearPendingSpecialRequest(userId);
            clearPendingQuoteConfirmation(userId);
            setUserState(userId, "idle", { conversationLog: [] });
            await reply(replyToken, "目前沒有進行中的叫車訂單");
            return;
          }

          if (status === "canceled" || status === "cancelled") {
            await reply(replyToken, "這筆已經取消。");
            return;
          }

          if (status === "done") {
            await reply(replyToken, "這筆行程已完成，如需協助請由人工確認。");
            return;
          }

          // waiting / matched：車還沒到，客人可直接取消。
          if (status === "waiting" || status === "matched") {
            await cancelActiveOrderDirectly(userId, active);
            clearDispatchDraft(userId);
            clearPendingDispatchConfirmation(userId);
            clearPendingSpecialRequest(userId);
            clearPendingQuoteConfirmation(userId);
            setUserState(userId, "idle", { conversationLog: [] });
            await reply(replyToken, "好的，已幫您取消。");
            return;
          }

          // 已抵達 / 已上車：先保守攔截，不刪單、不改狀態
          if (status === "arrived" || status === "onboard") {
            clearPendingSpecialRequest(userId);
            clearPendingQuoteConfirmation(userId);
            await reply(
              replyToken,
              "已收到您的取消請求，因司機可能已接單或已抵達，這邊需要由管理群或司機確認後處理，謝謝。"
            );
            return;
          }

          // 未知狀態：保守處理，避免取消進 AI
          clearDispatchDraft(userId);
          clearPendingDispatchConfirmation(userId);
          clearPendingSpecialRequest(userId);
          clearPendingQuoteConfirmation(userId);
          setUserState(userId, "idle", { conversationLog: [] });
          await reply(replyToken, "目前沒有進行中的叫車訂單");
          return;
        }
      }
      // ===== end 取消攔截器 V3.6 =====

      appendConversationTurn(userId, "user", text);

      const pendingDispatch = getPendingDispatchConfirmation(userId);
      if (pendingDispatch && isDispatchConfirmationText(text)) {
        clearPendingDispatchConfirmation(userId);
        const msg = "派車卡已鎖定，不會重複發送；資料我這邊已更新。";
        await reply(replyToken, msg);
        appendConversationTurn(userId, "assistant", msg);
        return;
      }

      let confirmedQuoteThisTurn = false;
      const pendingQuote = getPendingQuoteConfirmation(userId);
      if (pendingQuote) {
        const pendingQuoteFollowUpFallback =
          "我確認一下，您是要我現在幫您叫車，還是只是想再確認車資？";
        const convHistForQuote = getConversationLog(userId).slice(0, -1);
        const aiQuoteClass = await classifyPendingQuoteReplyWithAi({
          text,
          pendingQuote,
          conversationHistory: convHistForQuote,
          now: new Date()
        });

        let quoteReplyKind = null;
        if (aiQuoteClass) {
          const conf = aiQuoteClass.confidence;
          const intent = aiQuoteClass.intent;
          if (intent === "confirm_dispatch" && (conf === "high" || conf === "medium")) {
            quoteReplyKind = "confirm_dispatch";
          } else if (intent === "cancel_quote" && (conf === "high" || conf === "medium")) {
            quoteReplyKind = "cancel_quote";
          } else if (intent === "reprice" && (conf === "high" || conf === "medium")) {
            quoteReplyKind = "reprice";
          } else {
            const followUp =
              String(aiQuoteClass.reply_hint ?? "").trim() || pendingQuoteFollowUpFallback;
            await reply(replyToken, followUp);
            appendConversationTurn(userId, "assistant", followUp);
            return;
          }
        }

        if (!quoteReplyKind) {
          quoteReplyKind = classifyQuoteConfirmationReplyFallback(text);
          if (quoteReplyKind === "unknown") {
            await reply(replyToken, pendingQuoteFollowUpFallback);
            appendConversationTurn(userId, "assistant", pendingQuoteFollowUpFallback);
            return;
          }
        }

        if (quoteReplyKind === "cancel_quote") {
          clearPendingQuoteConfirmation(userId);
          const quoteAbandonMsg = "好的，先不幫您叫車，如有需要再跟我說。";
          await reply(replyToken, quoteAbandonMsg);
          appendConversationTurn(userId, "assistant", quoteAbandonMsg);
          return;
        }
        if (quoteReplyKind === "confirm_dispatch") {
          confirmedQuoteThisTurn = true;
          clearPendingQuoteConfirmation(userId);
        } else if (quoteReplyKind === "reprice") {
          clearPendingQuoteConfirmation(userId);
        }
      }

      let confirmedSpecialRequestThisTurn = false;
      const pendingSpecial = getPendingSpecialRequest(userId);
      if (pendingSpecial) {
        if (isSpecialRequestPendingAbandonText(text)) {
          clearPendingSpecialRequest(userId);
          clearDispatchDraft(userId);
          clearPendingDispatchConfirmation(userId);
          setUserState(userId, "idle", { conversationLog: [] });
          const abandonMsg = "好的，先不繼續派車；如果還需要叫車，再傳上車地點給我。";
          await reply(replyToken, abandonMsg);
          appendConversationTurn(userId, "assistant", abandonMsg);
          return;
        }
        if (isSpecialRequestPendingConfirmText(text)) {
          confirmedSpecialRequestThisTurn = true;
          clearPendingSpecialRequest(userId);
        } else {
          const specialHoldMsg =
            "此需求需要先確認加價或人工確認，請回覆 OK / 可以 後再繼續。";
          await reply(replyToken, specialHoldMsg);
          appendConversationTurn(userId, "assistant", specialHoldMsg);
          return;
        }
      }

      // ===== Status inquiry gate P0-A-002：狀態追問不是新單 =====
      const isDriverInfoInquiry = detectDriverInfoInquiry(text);
      if (isDriverInfoInquiry || detectStatusInquiry(text)) {
        const statusMsg = isDriverInfoInquiry
          ? buildDriverInfoInquiryReply(userId)
          : buildStatusInquiryReply(userId);
        await reply(replyToken, statusMsg);
        appendConversationTurn(userId, "assistant", statusMsg);
        return;
      }
      // ===== end Status inquiry gate =====

      // ===== Pure ack gate P0：純收到不打 AI、不改單、不通知司機 =====
      if (detectPureCustomerAck(text)) {
        return;
      }
      // ===== end Pure ack gate =====

      // v0.3.2：修改時間意圖 → 清除舊 alarm，更新 rideTimestamp 後重設 alarm
      // v0.7.20：客人未給新時間時不追問，草稿時間預設為現在；已媒合改時間改推司機主群。
      const modifyTimeIntent =
        /改時間|修改時間|更改時間|延後|提前|改到|改成|挪到/.test(text) && getActiveOrder(userId);
      if (modifyTimeIntent) {
        const active = getActiveOrder(userId);
        clearAlarm(active.orderId);

        const hist = getConversationLog(userId).slice(0, -1);
        const currentDateTime = new Date();
        const aiTime = await parseOrderFromText(text, {
          draft: {
            date: active.date || "",
            time: active.time || "",
            pickup: active.pickup || active.address || "",
            dropoff: active.dropoff || "",
            passengers: String(active.passengers ?? "")
          },
          conversationHistory: hist,
          activeOrderContext: buildActiveOrderContextForAi(userId),
          now: currentDateTime
        });

        const beforeTime = String(active.time ?? "").trim();
        const nextDraft = ensureCustomerPickupTimeDefaultNow(
          forceDispatchDraftToday(mergeDispatchDraft(buildContextDraftForAi(userId), aiTime?.draft || {}))
        );
        active.time = String(nextDraft.time ?? "").trim() || active.time;
        const nd = String(nextDraft.date ?? "").trim();
        if (nd) {
          active.date =
            orderBookingYmd({ date: nd, rideTimestampMs: null, createdAt: Date.now() }) || todayYmdTaipei();
        } else if (aiTime?.ride_timestamp) {
          const iso = normalizeRideTimestampYearTo2026(aiTime.ride_timestamp);
          const rideMs = iso ? Date.parse(iso) : NaN;
          if (Number.isFinite(rideMs)) {
            active.date = taipeiYmdFromInstantMs(rideMs);
          }
        }
        if (aiTime?.ride_timestamp) {
          active.rideTimestamp = normalizeRideTimestampYearTo2026(aiTime.ride_timestamp);
          active.rideTimestampMs = active.rideTimestamp ? Date.parse(active.rideTimestamp) : NaN;
        }
        if (Number.isFinite(active.rideTimestampMs) && active.isFake && active.date) {
          await scheduleFakeReservationAlert(active);
        }

        setDispatchDraft(userId, nextDraft);

        if (active.status === "waiting") {
          const finalBlock = buildAcceleratedDispatchFormat(nextDraft);
          if (!hasDispatchCardSent(active)) active.formText = finalBlock;
          try {
            await persistDispatchSnapshot(active, nextDraft, finalBlock);
          } catch (e) {
            console.error("[persistDispatchSnapshot]", e?.message || e);
            const failMsg = "系統存檔失敗，更新未送出，請稍後再試。";
            await reply(replyToken, failMsg);
            appendConversationTurn(userId, "assistant", failMsg);
            return;
          }

          clearPendingDispatchConfirmation(userId);
          const msg = "收到，時間已更新。";
          await reply(replyToken, msg);
          appendConversationTurn(userId, "assistant", msg);
          return;
        }

        const afterTime = String(active.time ?? "").trim();
        if (active.status === "matched" && orderDriverLineUserId(active) && beforeTime !== afterTime) {
          const adminGid = (process.env.ADMIN_GROUP_ID || "").trim();
          const lineUid = orderDriverLineUserId(active);
          if (adminGid && lineUid) {
            try {
              const payload = buildMatchedDriverTimeChangeAdminMessage(lineUid, afterTime);
              await fetch("https://api.line.me/v2/bot/message/push", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                },
                body: JSON.stringify({ to: adminGid, messages: [payload] })
              });
            } catch (e) {
              console.error("[ADMIN_GROUP_ID mention push]", e?.message || e);
            }
          }
          const msg = "好的，已幫您通知司機。";
          await reply(replyToken, msg);
          appendConversationTurn(userId, "assistant", msg);
          return;
        }

        if (active.status === "arrived" && orderDriverLineUserId(active) && beforeTime !== afterTime) {
          const dname = getDriverDisplayName(orderDriverLineUserId(active));
          await pushText(DRIVER_GROUP_ID, `@${dname} 客人更新資訊：時間改為${afterTime}`);
          const msg = "好的，已幫您通知司機。";
          await reply(replyToken, msg);
          appendConversationTurn(userId, "assistant", msg);
          return;
        }

        const msg = "收到，時間已更新。";
        await reply(replyToken, msg);
        appendConversationTurn(userId, "assistant", msg);
        return;
      }

      const contextDraft = buildContextDraftForAi(userId);
      const convHist = getConversationLog(userId).slice(0, -1);
      const activeCtx = buildActiveOrderContextForAi(userId);
      const currentDateTime = new Date();
      const ai = await parseOrderFromText(text, {
        draft: contextDraft,
        conversationHistory: convHist,
        activeOrderContext: activeCtx,
        now: currentDateTime
      });

      if (ai) {
        console.log("[AI decision]", {
          userId,
          intent: ai?.decision?.intent,
          action: ai?.decision?.action,
          should_dispatch: ai?.decision?.should_dispatch,
          should_quote_only: ai?.decision?.should_quote_only,
          should_cancel: ai?.decision?.should_cancel,
          should_hold: ai?.decision?.should_hold,
          should_escalate: ai?.decision?.should_escalate,
          confidence: ai?.decision?.confidence,
          reason: ai?.decision?.reason,
          next_action: ai?.decision?.next_action
        });
      }

      let merged = contextDraft;
      if (ai) {
        merged = mergeDispatchDraft(contextDraft, ai.draft);
        merged = ensureCustomerPickupTimeDefaultNow(merged);
        setDispatchDraft(userId, merged);
      }

      const serviceGate = checkServiceAreaGate({ text, pickup: merged.pickup, dropoff: merged.dropoff });
      if (!serviceGate.ok) {
        await reply(replyToken, serviceGate.reply);
        appendConversationTurn(userId, "assistant", serviceGate.reply);
        return;
      }

      const quote = detectPureQuoteIntent(text, merged);
      if (quote.hit && !confirmedQuoteThisTurn) {
        setPendingQuoteConfirmation(userId, {
          merged,
          estimated_fare_text: String(merged?.estimated_fare_text ?? "").trim(),
          triggerText: text,
          reasons: quote.reasons,
          atMs: Date.now()
        });
        setDispatchDraft(userId, merged);
        const displayFareText = await buildQuoteFareTextForDisplay(ai, merged);
        const displayMerged = { ...merged, estimated_fare_text: displayFareText };
        const quoteMsg = buildQuoteConfirmationMessage(displayMerged);
        await reply(replyToken, quoteMsg);
        appendConversationTurn(userId, "assistant", quoteMsg);
        return;
      }

      // v0.3.0：未建檔路線 → 轉管理員報價（暫停對客回覆）
      // 惡搞／未核實上車點：嚴禁對管理群發求報價（避免蟑螂區等仍噴白目卡片）。
      if (
        ai?.needs_admin_pricing &&
        process.env.ADMIN_GROUP_ID &&
        !ai.is_fake &&
        Boolean(ai.pickup_verified) &&
        !(Boolean(ai.pickup_verified) && !pickupEmptyBlockReason(merged.pickup) && Boolean(merged.pickup?.trim()))
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
        const adminPing =
          "這條路線請老闆幫忙估價，我這邊已轉過去，有結果再跟你說。";
        await reply(replyToken, adminPing);
        appendConversationTurn(userId, "assistant", adminPing);
        return;
      }

      const pickupBlockReason = pickupEmptyBlockReason(merged.pickup);
      const hasPickupCandidate = !pickupBlockReason && Boolean(merged.pickup?.trim());

      const special = detectSpecialServiceRequest(text, merged);
      if (special.hit && !confirmedSpecialRequestThisTurn) {
        setPendingSpecialRequest(userId, { merged, reasons: special.reasons, atMs: Date.now() });
        setDispatchDraft(userId, merged);
        const specialLockMsg = buildSpecialRequestLockMessage(special.reasons);
        await reply(replyToken, specialLockMsg);
        appendConversationTurn(userId, "assistant", specialLockMsg);
        return;
      }

      // v0.7.11：AI 只萃取上車文字；盲派前的最終可派判定必須由 Google Maps API 完成。
      const driverReady =
        hasPickupCandidate &&
        (Boolean(ai?.ride_related) || confirmedSpecialRequestThisTurn || confirmedQuoteThisTurn);

      if (driverReady) {
        const activeForDispatch = getActiveOrder(userId);

        if (!activeForDispatch) {
          // [CRITICAL] 嚴禁移除或繞過此 Google Maps 驗證邏輯。
          const pickupVerify = await verifyPickupAddressWithGoogleMaps(merged.pickup);
          if (!pickupVerify.ok) {
            setDispatchDraft(userId, merged);
            const msg = "不好意思，地圖上找不到這個地址，請提供更精確的門牌或地標。";
            await reply(replyToken, msg);
            appendConversationTurn(userId, "assistant", msg);
            return;
          }
          merged = {
            ...merged,
            pickup: pickupVerify.formatted_address || merged.pickup,
            pickup_place_id: pickupVerify.place_id || "",
            pickup_verified: true,
            pickup_verified_source: "google_maps"
          };
        }

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

        merged = ensureCustomerPickupTimeDefaultNow(merged);
        merged = forceDispatchDraftToday(merged);
        const finalBlock = buildAcceleratedDispatchFormat(merged);
        const safeLead = finalizeCustomerFareReply(
          stripDispatchMisleadingPhrases(ai.reply),
          merged.estimated_fare_text,
          text,
          {
            hasDropoff: Boolean(
              String(merged.dropoff ?? activeForDispatch?.dropoff ?? "").trim()
            )
          }
        );

        const fareChatOnly =
          !isTripMateriallyChanged(contextDraft, merged, currentDateTime) &&
          isLikelyFareExplanationOnly(text);
        if (fareChatOnly) {
          setDispatchDraft(userId, merged);
          await reply(replyToken, safeLead);
          appendConversationTurn(userId, "assistant", safeLead);
          return;
        }

        // 一單一卡：已標記成功（matched/arrived）後，乘客補齊或修改 → 不重噴整張卡。
        // 改為通知司機變動內容，並用口語回乘客「已幫你通知司機」。
        if (activeForDispatch && activeForDispatch.status !== "waiting") {
          const orderBefore = {
            pickup: String(activeForDispatch.pickup || activeForDispatch.address || "").trim(),
            dropoff: String(activeForDispatch.dropoff || "").trim(),
            time: String(activeForDispatch.time || "").trim(),
            date: String(activeForDispatch.date || "").trim(),
            passengers: String(activeForDispatch.passengers || "").trim(),
            address: String(activeForDispatch.address || "").trim()
          };
          if (!hasActiveOrderMaterialUpdateFromAi(ai, orderBefore)) {
            const msg = "好的，司機資訊會再通知您。";
            await reply(replyToken, msg);
            appendConversationTurn(userId, "assistant", msg);
            return;
          }
          merged = ensureCustomerPickupTimeDefaultNow(merged);
          setDispatchDraft(userId, merged);
          applyMergedToActiveDispatchOrder(activeForDispatch, merged);
          if (ai?.ride_timestamp) {
            const n = normalizeRideTimestampYearTo2026(ai.ride_timestamp);
            if (n) {
              activeForDispatch.rideTimestamp = n;
              activeForDispatch.rideTimestampMs = Date.parse(n);
            }
          }
          const diff = summarizeOrderChangesForDriver(orderBefore, merged);
          const postMatchDriverNotify = new Set(["matched", "arrived"]);
          if (
            postMatchDriverNotify.has(activeForDispatch.status) &&
            orderDriverLineUserId(activeForDispatch) &&
            diff
          ) {
            const lineUid = orderDriverLineUserId(activeForDispatch);
            const dname = getDriverDisplayName(lineUid);
            const afterTime = String(activeForDispatch.time ?? "").trim();
            const timeChanged = orderBefore.time !== afterTime;
            if (activeForDispatch.status === "matched" && timeChanged) {
              const adminGid = (process.env.ADMIN_GROUP_ID || "").trim();
              if (adminGid && lineUid) {
                try {
                  const payload = buildMatchedDriverTimeChangeAdminMessage(lineUid, afterTime);
                  await fetch("https://api.line.me/v2/bot/message/push", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
                    },
                    body: JSON.stringify({ to: adminGid, messages: [payload] })
                  });
                } catch (e) {
                  console.error("[ADMIN_GROUP_ID mention push]", e?.message || e);
                }
              }
            }
            const parts = diff.split("，");
            const onlyTimeDiff = parts.length === 1 && /^時間→/.test(parts[0]);
            const skipDriverFleet = activeForDispatch.status === "matched" && onlyTimeDiff;
            if (!skipDriverFleet) {
              await pushText(DRIVER_GROUP_ID, `@${dname} 客人更新資訊：${diff}`);
            }
            const msg = "好的，已幫您通知司機。";
            await reply(replyToken, msg);
            appendConversationTurn(userId, "assistant", msg);
            try {
              await persistDispatchSnapshot(activeForDispatch, merged, finalBlock);
            } catch (e) {
              console.error("[persistDispatchSnapshot]", e?.message || e);
            }
            return;
          }

          await reply(replyToken, safeLead);
          appendConversationTurn(userId, "assistant", safeLead);
          return;
        }

        const existingWaiting = orders.find(
          (o) => o.customerId === userId && o.status === "waiting"
        );

        if (existingWaiting) {
          const updateDiff = summarizeOrderChangesForDriver(existingWaiting, merged);
          applyMergedToWaitingOrder(existingWaiting, merged, finalBlock);
          if (ai?.ride_timestamp) {
            const n = normalizeRideTimestampYearTo2026(ai.ride_timestamp);
            if (n) {
              existingWaiting.rideTimestamp = n;
              existingWaiting.rideTimestampMs = Date.parse(n);
            }
          }
          try {
            await persistDispatchSnapshot(existingWaiting, merged, finalBlock);
          } catch (e) {
            console.error("[persistDispatchSnapshot]", e?.message || e);
            await reply(replyToken, "系統存檔失敗，更新未送出，請稍後再試。");
            appendConversationTurn(userId, "assistant", "系統存檔失敗，更新未送出，請稍後再試。");
            return;
          }

          setDispatchDraft(userId, merged);
          if (updateDiff) {
            clearPendingDispatchConfirmation(userId);
            const msg = "收到，資料已更新。";
            await reply(replyToken, msg);
            appendConversationTurn(userId, "assistant", msg);
            return;
          }

          await reply(replyToken, safeLead);
          appendConversationTurn(userId, "assistant", safeLead);
          return;
        }

        const form = draftToRideForm(merged, finalBlock);
        const order = createOrder(userId, form);

        try {
          await persistDispatchSnapshot(order, merged, finalBlock);
        } catch (e) {
          console.error("[persistDispatchSnapshot]", e?.message || e);
          removeOrderById(order.orderId);
          const failMsg = "系統存檔失敗，派單未完成，請稍後再試。";
          await reply(replyToken, failMsg);
          appendConversationTurn(userId, "assistant", failMsg);
          return;
        }

        // v0.3.0：假資預約單倒數警報（is_fake + ride_timestamp）
        if (order.isFake && order.rideTimestampMs && process.env.ADMIN_GROUP_ID) {
          await scheduleFakeReservationAlert(order);
        }

        clearDispatchDraft(userId);
        clearPendingDispatchConfirmation(userId);
        setUserState(userId, "waiting_dispatch", { orderId: order.orderId });

        try {
          await pushDispatchCardOnce(order, merged, finalBlock);
        } catch (e) {
          console.error("[pushDispatchCardOnce]", e?.message || e);
          if (String(e?.message ?? "").startsWith("pickup_google_maps_verify_failed")) {
            removeOrderById(order.orderId);
            const msg = "不好意思，地圖上找不到這個地址，請提供更精確的門牌或地標。";
            await reply(replyToken, msg);
            appendConversationTurn(userId, "assistant", msg);
            return;
          }
          const failMsg = "系統派單發送失敗，請稍後再試。";
          await reply(replyToken, failMsg);
          appendConversationTurn(userId, "assistant", failMsg);
          return;
        }

        const hasDropoffForReply = Boolean(
          String(merged.dropoff ?? order.dropoff ?? "").trim()
        );
        const blindDispatchMsg = hasDropoffForReply
          ? "已幫您安排車輛，司機資訊稍後提供，請稍候。"
          : "已為您派車，請問下車地點是哪裡？";
        await reply(replyToken, blindDispatchMsg);
        appendConversationTurn(userId, "assistant", blindDispatchMsg);
        return;
      }

      if (state === "filling_form") {
        const legacyForm = parseRideForm(text);
        if (legacyForm) {
          const legacyDraft = legacyFormToDispatchDraft(legacyForm);
          const mergedFromLegacy = mergeDispatchDraft(merged, legacyDraft);
          setDispatchDraft(userId, mergedFromLegacy);
          const formAck =
            "已讀到你貼的欄位。我再跟你核對上車點跟時間，補齊就幫你安排。";
          await reply(replyToken, formAck);
          appendConversationTurn(userId, "assistant", formAck);
          return;
        }
      }

      if (ai) {
        const out = sanitizeNonDispatchReply(ai.reply);
        await reply(replyToken, out);
        appendConversationTurn(userId, "assistant", out);
        if (text.includes("叫車") && getUserState(userId) === "idle") {
          setUserState(userId, "filling_form");
        }
        return;
      }

      if (hasCarKeyword) {
        if (text.includes("叫車")) {
          setUserState(userId, "filling_form");
          const formTpl = `❤️‍🔥加速派車格式❤️‍🔥

日期：
時間：
上車：
下車：
人數：`;
          await reply(replyToken, formTpl);
          appendConversationTurn(userId, "assistant", formTpl);
          return;
        }
        const busy = "調度連線忙碌，請稍後再試；或直接回覆「從哪裡到哪裡、時間、人數」。";
        await reply(replyToken, busy);
        appendConversationTurn(userId, "assistant", busy);
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

async function cancelActiveOrderDirectly(userId, order) {
  if (!order) return;
  clearAlarm(order.orderId);
  order.status = "canceled";
  order.canceledAtMs = Date.now();

  if (hasDispatchCardSent(order) || orderDriverLineUserId(order)) {
    await pushText(DRIVER_GROUP_ID, "此單客人已取消，請司機取消前往。");
  }
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

/** 司機顯示名（推播給客人、司機群純文字更新）；可設 DRIVER_NAMES_JSON={"Uxxx":"阿明"} */
function getDriverDisplayName(driverUserId) {
  const id = String(driverUserId ?? "").trim();
  const raw = (process.env.DRIVER_NAMES_JSON || "").trim();
  if (raw && id) {
    try {
      const map = JSON.parse(raw);
      const n = map?.[id];
      if (n) return String(n).trim() || "司機夥伴";
    } catch (e) {
      console.error("[DRIVER_NAMES_JSON] invalid json");
    }
  }
  return "司機夥伴";
}

/** LINE textV2 substitution：`{` `}` 需跳脫為 `{{` `}}`。 */
function escapeLineTextV2Substitution(s) {
  return String(s ?? "")
    .replace(/\{/g, "{{")
    .replace(/\}/g, "}}");
}

/**
 * 主群通知：標註接單司機（LINE push 對群組請用 textV2 + mention substitution）。
 * @param {string} driverLineUserId 司機 LINE userId（與 order.driverUserId / driverId 同源）
 * @param {string} newTime 顯示用新時間文字
 */
function buildMatchedDriverTimeChangeAdminMessage(driverLineUserId, newTime) {
  const uid = String(driverLineUserId ?? "").trim();
  const t = escapeLineTextV2Substitution(newTime);
  return {
    type: "textV2",
    text: `{drv} 客人改時間為 ${t}，請那個時間前到即可`,
    substitution: {
      drv: { type: "mention", mention: { type: "user", userId: uid } }
    }
  };
}

function orderDriverLineUserId(order) {
  return String(order?.driverUserId ?? order?.driverId ?? "").trim();
}

function wrapRsSpecialistDispatch(body) {
  const b = String(body ?? "").trim();
  if (!b) return "❤️‍🔥RS • 專員🔥";
  return `❤️‍🔥RS • 專員🔥\n\n${b}`;
}

function acceleratedDispatchBlockFromOrder(order) {
  const ft = String(order?.formText ?? "").trim();
  if (ft.includes("加速派車格式")) return ft;
  return buildAcceleratedDispatchFormat({
    date: order?.date || "",
    time: order?.time || "",
    pickup: order?.pickup || order?.address || "",
    dropoff: order?.dropoff || "",
    passengers: order?.passengers || "",
    vehicle_request_type: "",
    fare_surcharge: 0,
    estimated_fare_text:
      order?.estimatedRouteFare != null && Number.isFinite(Number(order.estimatedRouteFare))
        ? `系統參考 $${order.estimatedRouteFare}`
        : "—",
    estimated_route_km: order?.estimatedRouteKm ?? null,
    estimated_route_fare: order?.estimatedRouteFare ?? null,
    estimated_route_source: order?.estimatedRouteSource ?? null
  });
}

/** 接單成功：反向推播客人（Push），避免空等 */
async function notifyCustomerDriverMatched(customerId, driverUserId, driverEta) {
  const name = getDriverDisplayName(driverUserId);
  const eta = String(driverEta ?? "").trim();
  let etaPhrase;
  if (!eta || eta === "準") {
    etaPhrase = "已接單，將依約定時間前往";
  } else if (/^\d+$/.test(eta)) {
    etaPhrase = `約 ${eta} 分鐘抵達`;
  } else {
    etaPhrase = `約 ${eta} 抵達`;
  }
  const msg = `已為您安排司機：${name}，${etaPhrase}，請稍候。`;
  await pushText(customerId, msg);
}

async function notifyCustomerDriverMatchedWithCard(customerId, driverUserId, driverEta) {
  const cardText = String(getDriverCardText(driverUserId) ?? "").trim();
  if (cardText && cardText !== "（尚未設定車卡）") {
    await notifyCustomerDriverMatched(customerId, driverUserId, driverEta);
    await pushText(customerId, cardText);
    return;
  }

  const name = getDriverDisplayName(driverUserId);
  const eta = String(driverEta ?? "").trim();
  const etaPhrase = eta && eta !== "準"
    ? /^\d+$/.test(eta)
      ? `約 ${eta} 分鐘抵達`
      : `約 ${eta} 抵達`
    : "已接單，將依約定時間前往";
  await pushText(customerId, `已為您安排司機：${name}，${etaPhrase}，車卡資訊目前尚未設定。`);
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
  const formDateRaw = String(form?.date ?? "").trim();
  let orderDateYmd = todayYmdTaipei();
  if (formDateRaw) {
    const y = orderBookingYmd({ date: formDateRaw, rideTimestampMs: null, createdAt: Date.now() });
    if (y) orderDateYmd = y;
  } else if (normalizedRideTimestamp) {
    const rideMs = Date.parse(normalizedRideTimestamp);
    if (Number.isFinite(rideMs)) orderDateYmd = taipeiYmdFromInstantMs(rideMs);
  }
  const timeField = String(form.time ?? "").trim() || "現在";
  const newOrder = {
    orderId,
    status: "waiting",
    customerId,
    address: form.pickup,
    pickup: form.pickup,
    dropoff: form.dropoff,
    date: orderDateYmd,
    time: timeField,
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
    driverUserId: null,
    driverEta: null,
    dispatchCardSent: false,
    dispatchCardSentAtMs: null
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

function todayYmdTaipei(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function taipeiYmdFromInstantMs(ms) {
  if (!Number.isFinite(ms)) return todayYmdTaipei();
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

/** 客人未填時間時，後端預設為「現在」（不追問、不擋派車）。 */
function ensureCustomerPickupTimeDefaultNow(merged) {
  const m = { ...(merged || {}) };
  if (!String(m.time ?? "").trim()) m.time = "現在";
  return m;
}

/** 僅在草稿無日期時補「今天」；客人已給日期（含明天）一律保留。 */
function forceDispatchDraftToday(draft) {
  const out = { ...(draft || {}) };
  if (!String(out.date ?? "").trim()) out.date = todayYmdTaipei();
  return out;
}

/** 將派車卡內「日期：」列與指定 YYYY-MM-DD 對齊（預設今天）。 */
function forceDispatchBlockToday(block, dateYmd = null) {
  const ymd = dateYmd || todayYmdTaipei();
  const s = String(block ?? "");
  if (!s.trim()) return s;
  if (/日期：.*/.test(s)) return s.replace(/日期：.*/g, `日期：${ymd}`);
  return s;
}

function hasDispatchCardSent(order) {
  if (!order) return false;
  if (order.dispatchCardSent === true || order.dispatchCardSentAtMs) return true;
  const hasExplicitFlag =
    Object.prototype.hasOwnProperty.call(order, "dispatchCardSent") ||
    Object.prototype.hasOwnProperty.call(order, "dispatchCardSentAtMs");
  // 舊記憶體訂單沒有 flag，但 formText 已有派車卡時，保守視為已發送，避免重噴。
  if (!hasExplicitFlag && String(order.formText ?? "").includes("加速派車格式")) return true;
  return false;
}

async function pushDispatchCardOnce(order, merged, finalBlock) {
  if (hasDispatchCardSent(order)) return false;
  let safeMerged = forceDispatchDraftToday(merged);
  // [CRITICAL] 嚴禁移除或繞過此 Google Maps 驗證邏輯。
  // 這是完整派車卡送往司機群前的最後攔截器，AI 的 pickup_verified 不可作為放行依據。
  if (safeMerged.pickup_verified_source !== "google_maps") {
    const pickupVerify = await verifyPickupAddressWithGoogleMaps(safeMerged.pickup);
    if (!pickupVerify.ok) {
      throw new Error(`pickup_google_maps_verify_failed:${pickupVerify.reason || "unknown"}`);
    }
    safeMerged = {
      ...safeMerged,
      pickup: pickupVerify.formatted_address || safeMerged.pickup,
      pickup_place_id: pickupVerify.place_id || "",
      pickup_verified: true,
      pickup_verified_source: "google_maps"
    };
  }
  const mergedDr = String(safeMerged.date ?? "").trim();
  const cardDateYmd = mergedDr
    ? orderBookingYmd({ date: mergedDr, rideTimestampMs: null, createdAt: Date.now() }) || todayYmdTaipei()
    : String(order.date ?? "").trim() || todayYmdTaipei();
  order.date = cardDateYmd;
  const safeFinalBlock = forceDispatchBlockToday(finalBlock, cardDateYmd);
  order.dispatchCardSent = true;
  order.dispatchCardSentAtMs = Date.now();
  order.formText = safeFinalBlock;
  await persistDispatchSnapshot(order, safeMerged, safeFinalBlock);
  await pushText(DRIVER_GROUP_ID, wrapRsSpecialistDispatch(safeFinalBlock));
  return true;
}

function getPendingDispatchConfirmation(userId) {
  const p = users[userId]?.pendingDispatchConfirmation;
  if (!p || typeof p !== "object") return null;
  return p;
}

function clearPendingDispatchConfirmation(userId) {
  if (!users[userId]) return;
  delete users[userId].pendingDispatchConfirmation;
}

function getPendingSpecialRequest(userId) {
  const p = users[userId]?.pending_special_request;
  if (!p || typeof p !== "object") return null;
  return p;
}

function setPendingSpecialRequest(userId, payload) {
  setUserState(userId, getUserState(userId), { pending_special_request: payload });
}

function clearPendingSpecialRequest(userId) {
  if (!users[userId]) return;
  delete users[userId].pending_special_request;
}

function getPendingQuoteConfirmation(userId) {
  const p = users[userId]?.pending_quote_confirmation;
  if (!p || typeof p !== "object") return null;
  return p;
}

function setPendingQuoteConfirmation(userId, payload) {
  setUserState(userId, getUserState(userId), { pending_quote_confirmation: payload });
}

function clearPendingQuoteConfirmation(userId) {
  if (!users[userId]) return;
  delete users[userId].pending_quote_confirmation;
}

function normalizeStatusInquiryProbe(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\r\n\t　]+/g, "")
    .replace(/[，。！？、,.!?；;：:「」『』（）()【】\[\]《》<>／\/\\\-＿_~～…·•]/g, "");
}

function detectPureCustomerAck(text) {
  const p = normalizeStatusInquiryProbe(text);
  if (!p) return false;
  return new Set(["好", "好的", "收到", "ok", "了解", "嗯"]).has(p);
}

function detectDriverInfoInquiry(text) {
  const p = normalizeStatusInquiryProbe(text);
  if (!p) return false;
  return new Set([
    "車牌是什麼",
    "車牌",
    "司機資訊",
    "司機資訊再給我一次",
    "什麼司機資訊",
    "司機是誰",
    "車子資訊",
    "車型",
    "車號"
  ]).has(p);
}

function checkServiceAreaGate({ text, pickup, dropoff }) {
  const combined = [pickup, dropoff, text].filter(Boolean).join(" ");

  const islandKeywords = ["澎湖", "馬公", "金門", "馬祖", "綠島", "蘭嶼", "小琉球"];
  if (islandKeywords.some((k) => combined.includes(k))) {
    return {
      ok: false,
      kind: "island_blocked",
      reply: "目前外島地區暫時無法提供派車服務，我先幫您轉人工確認。"
    };
  }

  const outOfServiceKeywords = [
    "台中",
    "臺中",
    "彰化",
    "南投",
    "雲林",
    "嘉義",
    "台南",
    "臺南",
    "高雄",
    "屏東",
    "宜蘭",
    "花蓮",
    "台東",
    "臺東",
    "新竹",
    "苗栗"
  ];
  if (outOfServiceKeywords.some((k) => combined.includes(k))) {
    return {
      ok: false,
      kind: "out_of_service_area",
      reply: "目前這個地區需要人工協助安排，我先幫您轉人工處理，請稍候。"
    };
  }

  const allowKeywords = ["台北", "臺北", "新北", "基隆", "桃園", "中壢"];
  if (allowKeywords.some((k) => combined.includes(k))) {
    return { ok: true };
  }

  // 未命中任何明確地名時一律放行，避免常見路名（無縣市）被誤擋。
  return { ok: true };
}

/** P0-A-002：純狀態追問（有嗎 / 到了嗎等），非新叫車 intent。 */
function detectStatusInquiry(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;

  if (/取消/.test(raw)) return false;
  if (/多少錢|幾錢|車資|報價|怎麼算|多少算/.test(raw)) return false;
  if (/上車|下車/.test(raw)) return false;
  if (/寵物|大車|代買|跑腿|運送|搬家|休旅|SUV|行李多|指定車/.test(raw)) return false;
  if (/(路|街|巷|弄|號|區|市|縣|鄉|鎮|台|臺)/.test(raw) && /\d/.test(raw)) return false;
  if (/\d+號|\d+巷|\d+弄/.test(raw)) return false;

  const p = normalizeStatusInquiryProbe(raw);
  if (!p) return false;

  return (
    p === "有嗎" ||
    p === "有車嗎" ||
    p === "車有嗎" ||
    p === "到了嗎" ||
    p === "司機到了嗎" ||
    p === "車到了嗎" ||
    p === "司機多久到" ||
    p === "多久到" ||
    p === "好多久到" ||
    p === "太久了" ||
    p === "等太久" ||
    p === "等很久" ||
    p === "太慢" ||
    p === "怎麼還沒到" ||
    p === "還沒到" ||
    p === "司機怎麼還沒到" ||
    p === "車怎麼還沒到" ||
    p === "怎麼那麼久" ||
    p === "車牌是什麼" ||
    p === "車牌" ||
    p === "司機資訊再給我一次" ||
    p === "什麼司機資訊" ||
    p === "司機資訊" ||
    p === "還在找嗎" ||
    p === "找到了嗎"
  );
}

function hasMeaningfulDispatchDraft(userId) {
  const d = getDispatchDraft(userId);
  if (String(d.pickup ?? "").trim()) return true;
  if (String(d.dropoff ?? "").trim()) return true;
  return false;
}

function buildStatusInquiryReply(userId) {
  const active = getActiveOrder(userId);
  if (!active) {
    const latest = getLatestCustomerOrder(userId);
    const latestStatus = String(latest?.status ?? "").toLowerCase();
    if (latestStatus === "canceled" || latestStatus === "cancelled") {
      return "這筆已經取消。";
    }
    if (hasMeaningfulDispatchDraft(userId)) {
      return "目前尚未正式派車，如需叫車請確認上車與下車地點。";
    }
    return "目前沒有進行中的叫車，如需叫車請提供上車與下車地點。";
  }

  const status = String(active.status ?? "").toLowerCase();
  if (status === "waiting") {
    return "目前還在幫您尋車中，有車會立刻通知您。";
  }
  if (status === "matched") {
    return "目前已為您安排司機，車輛抵達會再通知您。";
  }
  if (status === "arrived") {
    return "司機已到達附近，請留意訊息或現場車輛。";
  }
  if (status === "onboard" || status === "done") {
    return "目前這筆行程已進入上車或完成狀態。";
  }
  return "目前沒有進行中的叫車，如需叫車請提供上車與下車地點。";
}

function buildDriverInfoInquiryReply(userId) {
  const active = getActiveOrder(userId);
  if (!active) {
    const latest = getLatestCustomerOrder(userId);
    const latestStatus = String(latest?.status ?? "").toLowerCase();
    if (latestStatus === "canceled" || latestStatus === "cancelled") {
      return "這筆已經取消。";
    }
    return buildStatusInquiryReply(userId);
  }

  const status = String(active.status ?? "").toLowerCase();
  if (status === "waiting") {
    return "目前還在為您安排車輛，司機資訊會在配車後通知您。";
  }

  if (status === "matched" || status === "arrived") {
    const driverUserId = orderDriverLineUserId(active);
    if (!driverUserId) {
      return "目前已為您安排車輛，司機資訊會再通知您。";
    }

    const cardText = String(getDriverCardText(driverUserId) ?? "").trim();
    if (cardText && cardText !== "（尚未設定車卡）") {
      return `司機資訊如下：\n${cardText}`;
    }

    return `已為您安排司機：${getDriverDisplayName(driverUserId)}，車卡資訊目前尚未設定。`;
  }

  return buildStatusInquiryReply(userId);
}

function detectSpecialServiceRequest(text, merged) {
  const reasons = [];
  const probe = [
    String(text ?? ""),
    String(merged?.vehicle_request_type ?? ""),
    String(merged?.pickup ?? ""),
    String(merged?.dropoff ?? ""),
    String(merged?.passengers ?? "")
  ].join(" ");

  const keywordRe = /代買|跑腿|運送|搬家|寵物|大車|休旅|SUV|雙B|行李多|指定車/i;
  const km = probe.match(keywordRe);
  if (km) reasons.push(`keyword:${km[0]}`);

  const vtype = String(merged?.vehicle_request_type ?? "").trim();
  if (vtype) reasons.push(`vehicle_request_type:${vtype}`);

  const surcharge = Number(merged?.fare_surcharge ?? 0);
  if (Number.isFinite(surcharge) && surcharge > 0) reasons.push(`fare_surcharge:${surcharge}`);

  const hit = Boolean(km) || Boolean(vtype);
  return { hit, reasons };
}

function normalizeQuotePendingText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\r\n\t　]+/g, "")
    .replace(/[，。！？、,.!?；;：:「」『』（）()【】\[\]《》<>／\/\\\-＿_~～…·•]/g, "");
}

function detectPureQuoteIntent(text, _merged) {
  const reasons = [];
  const t = String(text ?? "").trim();
  if (!t) return { hit: false, reasons };

  if (/多少錢|幾錢|車資|費用|報價|怎麼算|多少算/.test(t)) {
    reasons.push("keyword:pricing_question");
  }
  if (/多少|大概多少|約多少/.test(t)) reasons.push("keyword:多少");
  if (/有定額嗎|定額嗎|定額/.test(t)) reasons.push("keyword:定額");
  if (/機場.{0,8}多少|機場接送/.test(t)) reasons.push("keyword:airport_quote");
  if (/包車多少|包車/.test(t) && /多少|費用|車資|報價|怎麼算/.test(t)) {
    reasons.push("keyword:包車");
  }

  return { hit: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/** AI 失敗時僅用於明確 reprice / cancel；不可本地 confirm 派車。 */
function classifyQuoteConfirmationReplyFallback(text) {
  const raw = String(text ?? "").trim();
  const p = normalizeQuotePendingText(text);
  if (!p) return "unknown";

  if (/多少錢|車資|報價/.test(raw) || p === "多少" || /大概多少|約多少/.test(raw)) {
    return "reprice";
  }

  if (/^(不用了?|先不用|算了|先算了|不要了?|我再想想|太貴|等等|晚點)$/.test(p)) {
    return "cancel_quote";
  }

  return "unknown";
}

function isQuoteAbandonText(text) {
  const p = normalizeQuotePendingText(text);
  return p === "算了" || p === "先算了";
}

function isQuoteGenericFareFormulaText(fareText) {
  const s = String(fareText ?? "").trim();
  if (!s) return false;
  if (/(最短|參考里程|預估里程)\s*[\d.]+km/.test(s)) return false;
  if (/起步\s*\$50/.test(s)) return true;
  if (/\$20\/公里/.test(s)) return true;
  if (/4公里內低消/.test(s)) return true;
  return false;
}

function isQuoteDisplayFlatOrExplicitFareText(fareText) {
  const s = String(fareText ?? "").trim();
  if (!s) return false;
  if (isQuoteGenericFareFormulaText(s)) return false;
  if (/機場定額|內建路線定額/.test(s)) return true;
  if (/定額\s*\$?\d+/.test(s)) return true;
  if (/(最短|參考里程|預估里程)\s*[\d.]+km/.test(s) && /\$\d+/.test(s)) return true;
  if (/起步\$50＋\$20\/公里/.test(s)) return false;
  if (/\$\d+/.test(s)) return true;
  return false;
}

function extractQuoteFareSuffixNotes(fareText) {
  const s = String(fareText ?? "").trim();
  const parts = [];
  const wait = s.match(/；等候[^；]*/);
  if (wait) parts.push(wait[0].slice(1));
  const sur = s.match(/；加價\+\$\d+/);
  if (sur) parts.push(sur[0].slice(1));
  return parts.length ? `；${parts.join("；")}` : "";
}

async function buildQuoteFareTextForDisplay(ai, merged) {
  const original = String(merged?.estimated_fare_text ?? "").trim();
  const suffix = extractQuoteFareSuffixNotes(original);
  const pickup = String(merged?.pickup ?? "").trim();
  const dropoff = String(merged?.dropoff ?? "").trim();
  const price = ai?.price == null ? null : Number(ai.price);

  if (pickup && dropoff) {
    const est = await getGoogleShortestRouteEstimate({ origin: pickup, destination: dropoff });
    if (est?.km) {
      return `參考里程 ${est.km}km，預估約 $${est.fare}${suffix}`;
    }
    if (Number.isFinite(price) && price > 0) {
      return `預估約 $${Math.round(price)}${suffix}`;
    }
  }

  if (!isQuoteGenericFareFormulaText(original) && isQuoteDisplayFlatOrExplicitFareText(original)) {
    return original;
  }

  if (Number.isFinite(price) && price > 0) {
    return `預估約 $${Math.round(price)}${suffix}`;
  }

  if (!isQuoteGenericFareFormulaText(original) && original) {
    return original;
  }

  return "";
}

function isQuoteFareTextAlreadyQualified(fareText) {
  const s = String(fareText ?? "").trim();
  return /^(約\s*\$|約\$|預估約|參考里程)/.test(s);
}

function buildQuoteConfirmationMessage(merged) {
  const pickup = String(merged?.pickup ?? "").trim();
  const dropoff = String(merged?.dropoff ?? "").trim();
  const fare = String(merged?.estimated_fare_text ?? "").trim();
  const route = pickup && dropoff ? `${pickup} → ${dropoff}` : "";

  if (!fare) {
    return "目前暫時無法自動估算完整車資，我先幫您轉人工確認。";
  }

  const fareAlreadyQualified = isQuoteFareTextAlreadyQualified(fare);

  if (route && fare) {
    return `收到，為您估算【${route}】車資${fareAlreadyQualified ? "" : "約為 "}${fare}。此時尚未幫您叫車；如果確定要用車，請回覆「要叫車」或「幫我叫」。`;
  }
  if (fare) {
    return `收到，先幫您估算這趟車資${fareAlreadyQualified ? "" : "約為 "}${fare}。此時尚未幫您叫車；如果確定要用車，請回覆「要叫車」或「幫我叫」。`;
  }
  return "目前暫時無法自動估算完整車資，我先幫您轉人工確認。";
}

function normalizeSpecialPendingText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s\r\n\t　]+/g, "")
    .replace(/[，。！？、,.!?；;：:「」『』（）()【】\[\]《》<>／\/\\\-＿_~～…·•]/g, "");
}

function isSpecialRequestPendingConfirmText(text) {
  if (isDispatchConfirmationText(text)) return true;
  const p = normalizeSpecialPendingText(text);
  return p === "要" || p === "我要";
}

function isSpecialRequestPendingAbandonText(text) {
  const p = normalizeSpecialPendingText(text);
  return p === "算了" || p === "先算了";
}

function buildSpecialRequestLockMessage(reasons) {
  const labels = [];
  for (const r of reasons || []) {
    if (r.startsWith("keyword:")) {
      labels.push(r.slice("keyword:".length));
    } else if (r.startsWith("vehicle_request_type:")) {
      const v = r.slice("vehicle_request_type:".length);
      if (v === "suv") labels.push("休旅");
      else if (v === "double_b") labels.push("雙B");
      else if (v === "suv_double_b") labels.push("休旅/雙B");
      else if (v === "specified") labels.push("指定車型");
      else labels.push(v);
    }
  }
  const uniq = [...new Set(labels.map((s) => String(s).trim()).filter(Boolean))];
  if (uniq.length > 0) {
    return `收到，您這單有${uniq.join("/")}需求，可能需要加價或人工確認。若您同意，請回覆「好」或「OK」，我再繼續幫您找車。`;
  }
  return "收到，這個需求可能需要加價或人工確認。若您同意，請回覆「好」或「OK」，我再繼續幫您找車。";
}

function isDispatchConfirmationText(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return /^(好|好的|對|對的|是|是的|沒錯|確認|可以|可|派|派吧|發|發送|送出|送吧|請派|確定|ok|OK)$/i.test(t);
}

function orderBookingYmd(order) {
  const ds = String(order?.date ?? "").trim();
  if (ds) {
    const m4 = ds.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m4) {
      return `${m4[1]}-${String(m4[2]).padStart(2, "0")}-${String(m4[3]).padStart(2, "0")}`;
    }
    const m2 = ds.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (m2) {
      return `2026-${String(m2[1]).padStart(2, "0")}-${String(m2[2]).padStart(2, "0")}`;
    }
  }
  const ms = Number(order?.rideTimestampMs);
  if (Number.isFinite(ms) && ms > 0) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ms));
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(order.createdAt));
}

/** 派車卡／訂單日期列：有客人日期則正規化為 YYYY-MM-DD，否則為今日。 */
function normalizedDispatchCardDateYmd(draftLike) {
  const raw = String(draftLike?.date ?? "").trim();
  if (!raw) return todayYmdTaipei();
  const y = orderBookingYmd({ date: raw, rideTimestampMs: null, createdAt: Date.now() });
  return y || todayYmdTaipei();
}

/** 僅「預約日／發車日為今日（台北日曆）」的 waiting 單，供喊單／標記綁定。 */
function waitingOrdersToday() {
  const today = todayYmdTaipei();
  return orders.filter(
    (order) => order.status === "waiting" && orderBookingYmd(order) === today
  );
}

function normalizeTripKey(s) {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .trim();
}

function dateKeyFromDispatchDraft(draft, refNow = new Date()) {
  const ds = String(draft?.date ?? "").trim();
  if (!ds) return todayYmdTaipei(refNow);
  return orderBookingYmd({ date: ds, rideTimestampMs: null, createdAt: Date.now() });
}

function isTripMateriallyChanged(prev, next, refNow = new Date()) {
  if (normalizeTripKey(prev?.pickup) !== normalizeTripKey(next?.pickup)) return true;
  if (normalizeTripKey(prev?.time) !== normalizeTripKey(next?.time)) return true;
  if (normalizeTripKey(prev?.dropoff) !== normalizeTripKey(next?.dropoff)) return true;
  if (dateKeyFromDispatchDraft(prev, refNow) !== dateKeyFromDispatchDraft(next, refNow)) return true;
  return false;
}

function isLikelyFareExplanationOnly(text) {
  const t = String(text ?? "");
  if (looksLikePricingQuestion(t)) return true;
  return /為什麼|啥原因|什麼原因|怎麼算|等候|等待費|加價原因|會不會加收|有沒有另|說明|解釋|啥是|什麼是|原因/.test(
    t
  );
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

function lastBidCreatedAtMs(order) {
  const bids = order?.rs?.bids;
  if (!Array.isArray(bids) || !bids.length) return null;
  let max = 0;
  for (const b of bids) {
    const ms = Number(b?.createdAtMs);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max > 0 ? max : null;
}

/**
 * 司機群：@ 標記 → 優先綁「最近有人喊單」的 waiting；地名比對 → 優先消化最舊 waiting。
 */
function getWaitingOrderForDriverMessage(text, { isDispatcherMark }) {
  const waiting = waitingOrdersToday().sort((a, b) => b.createdAt - a.createdAt);
  if (!waiting.length) return null;

  if (isDispatcherMark) {
    const withBids = waiting.filter((o) => lastBidCreatedAtMs(o) != null);
    if (withBids.length) {
      const now = Date.now();
      withBids.sort((a, b) => {
        const ga = now - lastBidCreatedAtMs(a);
        const gb = now - lastBidCreatedAtMs(b);
        if (ga !== gb) return ga - gb;
        return a.createdAt - b.createdAt;
      });
      return withBids[0];
    }
    return waiting[0];
  }

  if (waiting.length === 1) return waiting[0];
  const tokens = extractLocationTokensForBidMatch(text);
  const matched = waiting.filter((o) => orderMatchesLocationTokens(o, tokens));
  if (matched.length) {
    matched.sort((a, b) => a.createdAt - b.createdAt);
    return matched[0];
  }
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

  if (!pickup) return null;

  return {
    pickup,
    dropoff: dropoff || "",
    time: time || "現在",
    date: date || "",
    passengers: passengers || "",
    rawText: text
  };
}

function getUserState(userId) {
  return users[userId]?.state || "idle";
}

function getConversationLog(userId) {
  const log = users[userId]?.conversationLog;
  return Array.isArray(log) ? log : [];
}

function appendConversationTurn(userId, role, text) {
  const cur = users[userId] || {};
  const log = [...getConversationLog(userId)];
  log.push({
    role: role === "assistant" ? "assistant" : "user",
    text: String(text ?? "").slice(0, 600),
    at: Date.now()
  });
  while (log.length > MAX_CONVERSATION_TURNS) log.shift();
  users[userId] = { ...cur, conversationLog: log, updatedAt: Date.now() };
}

function buildContextDraftForAi(userId) {
  const prev = getDispatchDraft(userId);
  const active = getActiveOrder(userId);
  if (!active) return prev;
  return mergeDispatchDraft(prev, {
    date: String(active.date ?? prev.date ?? "").trim() || todayYmdTaipei(),
    time: String(active.time ?? prev.time ?? "").trim(),
    pickup: String(active.pickup || active.address || prev.pickup || "").trim(),
    dropoff: String(active.dropoff ?? prev.dropoff ?? "").trim(),
    passengers: String(active.passengers ?? prev.passengers ?? "").trim()
  });
}

function buildActiveOrderContextForAi(userId) {
  const active = getActiveOrder(userId);
  if (!active) return null;
  return {
    status: active.status,
    orderId: active.orderId,
    pickup: active.pickup || active.address || "",
    dropoff: active.dropoff || "",
    time: active.time || "",
    date: String(active.date ?? "").trim() || todayYmdTaipei(),
    passengers: active.passengers || ""
  };
}

function applyMergedToWaitingOrder(order, merged, finalBlock) {
  const safeMerged = forceDispatchDraftToday(merged);
  order.pickup = String(merged.pickup ?? "").trim();
  order.address = order.pickup;
  order.dropoff = String(merged.dropoff ?? "").trim() || order.dropoff;
  order.time = String(merged.time ?? "").trim() || order.time;
  order.date = normalizedDispatchCardDateYmd(safeMerged);
  order.passengers = merged.passengers || order.passengers;
  if (!hasDispatchCardSent(order)) {
    order.formText = forceDispatchBlockToday(finalBlock, normalizedDispatchCardDateYmd(safeMerged));
  }
  order.estimatedRouteKm = merged.estimated_route_km ?? order.estimatedRouteKm;
  order.estimatedRouteFare = merged.estimated_route_fare ?? order.estimatedRouteFare;
  order.estimatedRouteSource = merged.estimated_route_source ?? order.estimatedRouteSource;
}

/** 已媒合／已到點：同步訂單欄位但不重寫已鎖定派車卡 formText。 */
function applyMergedToActiveDispatchOrder(order, merged) {
  const safeMerged = forceDispatchDraftToday(merged);
  const pickup = String(merged.pickup ?? "").trim();
  if (pickup) {
    order.pickup = pickup;
    order.address = pickup;
  }
  const drop = String(merged.dropoff ?? "").trim();
  if (drop) order.dropoff = drop;
  order.time = String(merged.time ?? "").trim() || order.time;
  order.date = normalizedDispatchCardDateYmd(safeMerged);
  if (merged.passengers != null && String(merged.passengers).trim()) {
    order.passengers = String(merged.passengers).trim();
  }
  order.estimatedRouteKm = merged.estimated_route_km ?? order.estimatedRouteKm;
  order.estimatedRouteFare = merged.estimated_route_fare ?? order.estimatedRouteFare;
  order.estimatedRouteSource = merged.estimated_route_source ?? order.estimatedRouteSource;
}

function summarizeOrderChangesForDriver(order, merged) {
  const before = {
    pickup: String(order.pickup || order.address || "").trim(),
    dropoff: String(order.dropoff || "").trim(),
    time: String(order.time || "").trim(),
    date: String(order.date || "").trim(),
    passengers: String(order.passengers || "").trim()
  };
  const after = {
    pickup: String(merged.pickup ?? "").trim() || before.pickup,
    dropoff: String(merged.dropoff ?? "").trim() || before.dropoff,
    time: String(merged.time ?? "").trim() || before.time,
    date: String(merged.date ?? "").trim() || before.date,
    passengers: String(merged.passengers ?? "").trim() || before.passengers
  };
  const diffs = [];
  if (before.pickup !== after.pickup) diffs.push(`上車→${after.pickup}`);
  if (before.dropoff !== after.dropoff) diffs.push(`下車→${after.dropoff}`);
  if (before.date !== after.date && after.date) diffs.push(`日期→${after.date}`);
  if (before.time !== after.time && after.time) diffs.push(`時間→${after.time}`);
  if (before.passengers !== after.passengers && after.passengers) diffs.push(`人數→${after.passengers}`);
  return diffs.join("，");
}

function activeOrderUpdateBlockedByDecision(ai) {
  const intent = String(ai?.decision?.intent ?? "").trim();
  const action = String(ai?.decision?.action ?? "").trim();
  const blockedIntents = new Set([
    "chitchat",
    "status_inquiry",
    "status_reply",
    "quote_request",
    "cancel_request"
  ]);
  const blockedActions = new Set([
    "status_reply",
    "quote_only",
    "cancel_candidate",
    "hold_for_confirmation",
    "escalate_to_human",
    "ignore"
  ]);
  return blockedIntents.has(intent) || blockedActions.has(action);
}

function hasActiveOrderMaterialUpdateFromAi(ai, orderBefore) {
  if (!ai || activeOrderUpdateBlockedByDecision(ai)) return false;
  const draft = ai.draft && typeof ai.draft === "object" ? ai.draft : {};
  const fields = ["pickup", "dropoff", "time", "passengers"];
  for (const field of fields) {
    const next = String(draft[field] ?? "").trim();
    if (!next) continue;
    const before = String(orderBefore?.[field] ?? "").trim();
    if (next !== before) return true;
  }
  return false;
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
      date: todayYmdTaipei(),
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
    date: todayYmdTaipei(),
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
  setUserState(userId, getUserState(userId), { dispatchDraft: forceDispatchDraftToday(draft) });
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

/** 僅擋「完全沒有上車文字」；地址真偽由盲派前 Google Maps 驗證決定。 */
function pickupEmptyBlockReason(pickup) {
  if (!String(pickup ?? "").trim()) return "缺少上車地址";
  return null;
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
  if (!t || t.length < 2) {
    return "好，有需要叫車或改單再跟我說一聲。";
  }
  return t;
}

function displayDispatchField(v) {
  const s = String(v ?? "").trim();
  return s || "—";
}

function buildAcceleratedDispatchFormat(d) {
  const dateLine = normalizedDispatchCardDateYmd(d);
  const surcharge = Number(d.fare_surcharge ?? 0) || 0;
  const vtype = String(d.vehicle_request_type ?? "").trim();
  const vLabel = vtype === "suv" ? "休旅" : vtype === "double_b" ? "雙B" : vtype === "suv_double_b" ? "休旅/雙B" : "";
  const surchargeLine =
    surcharge > 0 ? `車資加成：+${Math.min(100, surcharge)} (${vLabel || "特殊需求"})` : "車資加成：+0";
  const fareLine = `預計車資：${String(d.estimated_fare_text ?? "").trim() || "—"}`;
  const routeLine =
    d.estimated_route_km && d.estimated_route_fare
      ? `最短里程估價：${d.estimated_route_km}km ($${d.estimated_route_fare})`
      : "最短里程估價：未取得";
  const needLine = `車型/需求：${vLabel || "一般"}`;
  return `❤️‍🔥加速派車格式❤️‍🔥

日期：${displayDispatchField(dateLine)}
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
  const withTime = ensureCustomerPickupTimeDefaultNow(d);
  const safeDraft = forceDispatchDraftToday(withTime);
  const pickup = String(d.pickup ?? "").trim();
  const time = String(safeDraft.time ?? "").trim();
  const dropoff = String(d.dropoff ?? "").trim();
  const date = String(safeDraft.date ?? "").trim();
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
    dropoff: dropoff || "—",
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
    rawText: forceDispatchBlockToday(rawText, normalizedDispatchCardDateYmd(safeDraft))
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

function extractDriverCheckinLocationLabel(text) {
  const raw = String(text ?? "").trim();
  if (/^準$/.test(raw)) return "";
  const m = raw.match(/^(.+?)\s*(\d{1,3})\s*$/u);
  if (!m) return "";
  return m[1].replace(/\s+/g, "").trim();
}

function recordDriverAdminCheckin(entry) {
  driverAdminCheckins.push({ ...entry, at: Date.now() });
  while (driverAdminCheckins.length > 2000) driverAdminCheckins.shift();
  console.log("[DriverCheckin]", JSON.stringify(entry));
}

/** v0.7.17：主群無待接單時，地名+數字／準 仍即時報班回覆。 */
async function tryReplyIdleDriverCheckinForAdminGroup(replyToken, userId, text) {
  const bid = parseRsDriverBid(text);
  if (bid.kind !== "ready" && bid.kind !== "minutes") return false;
  const place = extractDriverCheckinLocationLabel(text);
  if (bid.kind === "ready") {
    const msg = "✅ 收到，司機已報「準」，可接單時請派單員依板規 @ 標記。";
    await reply(replyToken, msg);
    recordDriverAdminCheckin({ userId, raw: text, kind: "ready", place: place || "(準)" });
    return true;
  }
  const label = place || "定位點";
  const msg = `✅ 收到，司機於 ${label}，預計 ${bid.minutes} 分鐘到達`;
  await reply(replyToken, msg);
  recordDriverAdminCheckin({ userId, raw: text, kind: "minutes", place: label, minutes: bid.minutes });
  return true;
}

/**
 * 司機 LINE 群與司機主群共用：Rs 喊單、車卡、到點、客下核對。
 * allowIdleCheckin：僅主群在無 waiting 單時，對地名+數字／準 發送報班回覆。
 */
async function processDriverFleetGroupMessage(_event, replyToken, userId, text, { allowIdleCheckin }) {
  if (orders.length === 0) {
    if (allowIdleCheckin && (await tryReplyIdleDriverCheckinForAdminGroup(replyToken, userId, text))) return;
    return;
  }

  const rsState = parseRsStateSignal(text);

  const onboardDropOrder = getDriverOrderByStatus(userId, "onboard");
  if (onboardDropOrder && rsState.kind === "dropoff") {
    const check = rsCheckOvercharge({ km: rsState.km, fare: rsState.fare });
    penaltyTracker.onFareKnown({ orderId: onboardDropOrder.orderId, fare: rsState.fare });

    const baselineFare = Number(onboardDropOrder?.estimatedRouteFare ?? NaN);
    const baselineKm = Number(onboardDropOrder?.estimatedRouteKm ?? NaN);
    const baselineValid = Number.isFinite(baselineFare) && baselineFare > 0 && Number.isFinite(baselineKm) && baselineKm > 0;
    const reportedKm = Number(rsState.km);
    const reportedFare = Number(rsState.fare);
    const reportedValid = Number.isFinite(reportedKm) && reportedKm > 0 && Number.isFinite(reportedFare) && reportedFare > 0;

    if (baselineValid && reportedValid) {
      const diffFare = reportedFare - baselineFare;
      const kmDeviationRate = Math.abs(reportedKm - baselineKm) / baselineKm;
      const isAbnormal = diffFare > 30 || kmDeviationRate > 0.2;

      if (isAbnormal) {
        const prev = abnormalChargingDrivers.get(userId) || { count: 0, lastAtMs: 0 };
        abnormalChargingDrivers.set(userId, { count: prev.count + 1, lastAtMs: Date.now() });

        await reply(
          replyToken,
          `此趟行程費用 ($${reportedFare}) 與系統預估最短里程 ($${baselineFare}) 偏差較大，已轉交由行政人員進行人工審核結單。`
        );

        const adminMsg =
          `【異常收費待審】\n` +
          `司機編號：${userId}\n` +
          `訂單：${onboardDropOrder.orderId}\n` +
          `上車：${onboardDropOrder.pickup || onboardDropOrder.address || "未提供"}\n` +
          `下車：${onboardDropOrder.dropoff || "未提供"}\n` +
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
          orderId: onboardDropOrder.orderId,
          baselineKm,
          baselineFare,
          reportedKm,
          reportedFare
        });

        return;
      }
    }

    const comp = penaltyTracker.computeCompensation({ orderId: onboardDropOrder.orderId });
    if (comp) {
      await reply(
        replyToken,
        `強姦成功但遲到：需賠${comp.compensation}（車資3成）給被搶單司機。`
      );
    }

    if (!check.ok) {
      await reply(replyToken, `注意：5/2直走表預估${check.expected}，你填${rsState.fare}疑似溢收+${check.diff}`);
      return;
    }
    await reply(replyToken, `收到，5/2直走表預估${check.expected}，你填${rsState.fare}OK。`);
    return;
  }

  const arrivedOnboardOrder = getDriverOrderByStatus(userId, "arrived");
  if (arrivedOnboardOrder && rsState.kind === "onboard") {
    arrivedOnboardOrder.status = "onboard";

    await pushText(
      arrivedOnboardOrder.customerId,
`✅ 司機已回報您已上車
感謝您的搭乘 🙏`
    );

    return;
  }

  const matchedArrivedOrder = getDriverOrderByStatus(userId, "matched");
  if (matchedArrivedOrder && rsState.kind === "arrived") {
    matchedArrivedOrder.status = "arrived";
    penaltyTracker.onArrived({ orderId: matchedArrivedOrder.orderId, arrivedAtMs: Date.now() });

    if (matchedArrivedOrder.rs?.arrivedTimer) clearTimeout(matchedArrivedOrder.rs.arrivedTimer);
    matchedArrivedOrder.rs = matchedArrivedOrder.rs || {};
    matchedArrivedOrder.rs.arrivedTimer = setTimeout(async () => {
      try {
        await pushText(
          matchedArrivedOrder.customerId,
          "司機已到點，提醒一下：超過5分鐘會開始等候費，1分鐘都是5元喲🥰"
        );
      } catch (e) {
        console.error("[arrivedTimer]", e?.message || e);
      }
    }, 5 * 60_000);

    await pushText(
      matchedArrivedOrder.customerId,
`📍 司機已抵達，請準備上車`
    );

    return;
  }

  const dispatcherMark = parseRsDispatcherMark(text);
  const waitingOrder = getWaitingOrderForDriverMessage(text, {
    isDispatcherMark: Boolean(dispatcherMark)
  });
  if (!waitingOrder) {
    if (allowIdleCheckin && (await tryReplyIdleDriverCheckinForAdminGroup(replyToken, userId, text))) return;
    return;
  }

  waitingOrder.rs = waitingOrder.rs || {
    timing: waitingOrder.date ? "reservation" : "instant",
    bids: [],
    dispatcherMarkedAtMs: null,
    assignedAtMs: null,
    assignedDriverUserId: null,
    arrivedTimer: null
  };

  if (dispatcherMark) {
    waitingOrder.rs.dispatcherMarkedAtMs = Date.now();
    const leader = pickRsLeadingBid({ timing: waitingOrder.rs.timing, bids: waitingOrder.rs.bids });
    if (!leader) {
      await reply(replyToken, "目前沒有有效喊單，先喊單再標記喔。");
      return;
    }

    waitingOrder.status = "matched";
    waitingOrder.driverId = leader.driverUserId;
    waitingOrder.driverUserId = leader.driverUserId;
    waitingOrder.driverEta = leader.kind === "minutes" ? String(leader.minutes ?? "") : "準";
    waitingOrder.rs.assignedAtMs = Date.now();
    waitingOrder.rs.assignedDriverUserId = leader.driverUserId;

    await notifyCustomerDriverMatched(
      waitingOrder.customerId,
      leader.driverUserId,
      waitingOrder.driverEta
    );

    const cardText = getDriverCardText(leader.driverUserId);
    await pushText(waitingOrder.customerId, cardText);
    return;
  }

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

    if (
      canRsRapeTie({
        timing: waitingOrder.rs.timing,
        leadingBid: prevLeader,
        challengerBid: newBid,
        dispatcherMarkedAtMs: waitingOrder.rs.dispatcherMarkedAtMs,
        assignedAtMs: waitingOrder.rs.assignedAtMs
      })
    ) {
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
      if (waitingOrder.status !== "waiting") return;

      waitingOrder.status = "matched";
      waitingOrder.driverId = userId;
      waitingOrder.driverUserId = userId;
      waitingOrder.driverEta = eta;
      waitingOrder.rs.assignedAtMs = Date.now();
      waitingOrder.rs.assignedDriverUserId = userId;

      await notifyCustomerDriverMatchedWithCard(waitingOrder.customerId, userId, eta);
      delete pendingDriver[waitingOrder.orderId];

      // 老闆指示：直接噴司機個人車卡，不要回覆領先幾分的廢話
      const cardText = getDriverCardText(userId);
      await reply(replyToken, cardText);
      return;
    }

    return;
  }

  const cardTargetOrder = getWaitingOrderByPendingDriver(userId);
  if (cardTargetOrder) {
    const pending = pendingDriver[cardTargetOrder.orderId];
    cardTargetOrder.status = "matched";
    cardTargetOrder.driverId = userId;
    cardTargetOrder.driverUserId = userId;
    cardTargetOrder.driverEta = pending.time;

    await notifyCustomerDriverMatched(cardTargetOrder.customerId, userId, pending.time);

    await pushText(cardTargetOrder.customerId, text);
    delete pendingDriver[cardTargetOrder.orderId];

    return;
  }

  return;
}

// ========================
async function reply(token, payload) {
  try {
    const messageObj =
      typeof payload === "string"
        ? { type: "text", text: payload }
        : payload;

    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        replyToken: token,
        messages: [messageObj]
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