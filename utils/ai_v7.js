import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFile } from "node:fs/promises";

const AI_RESOLVER_VERSION = "v7-map-first";
const FIXED_MODEL_ID = "gemini-1.5-flash";

const REPLY_MAX_CHARS = 50;
const REPLY_TARGET_MIN = 30;
const RS_RULES_VERSION = "v0.1.9";
const KB_FILE = "knowledge_base.json";

console.log("AI module loaded.", { AI_RESOLVER_VERSION, module: "utils/ai_v7.js" });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 繁中／emoji 友善字數（以 Unicode 字元計） */
function clipReplyToMaxChars(text, max = REPLY_MAX_CHARS) {
  const t = String(text ?? "").trim();
  if (!t) return t;
  const chars = [...t];
  if (chars.length <= max) return t;
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/** .cursorrules：盡量落在 30～50 字；過短時補一句不突兀的引導 */
function ensureReplyLengthBand(text) {
  const pad = "補一下地址或時間。";
  let t = clipReplyToMaxChars(String(text ?? "").trim(), REPLY_MAX_CHARS);
  if ([...t].length >= REPLY_TARGET_MIN) return t;
  t = clipReplyToMaxChars(`${t} ${pad}`, REPLY_MAX_CHARS);
  return t || clipReplyToMaxChars("收到，請補縣市區、路名門牌與時間。", REPLY_MAX_CHARS);
}

/**
 * 依 .cursorrules：地圖優先、30～50 字、台灣派遣口語、EmotionScore、禁冗稱與誤導派車語。
 */
function buildSystemPrompt(draftJson, messageText) {
  return `
你是台灣派遣「排車調度」，口語像現場調度：簡短、清楚、不機械。禁用「親愛的顧客」等冗稱。

【回覆長度（強制）】
- reply 全文字數（含標點）必須在 ${REPLY_TARGET_MIN}～${REPLY_MAX_CHARS} 字之間；能更短更好，絕對不可超過 ${REPLY_MAX_CHARS} 字。

【年份規則（強制）】
- 當前年份為 2026 年，所有未註明年份的日期（如 5/7）一律視為 2026 年。

【地址絕對嚴謹（司機保護，強制）】
- 你必須判斷上車地址是否包含「行政區」(例如：板橋區、中山區、汐止區)。只寫路名（例如：中正路）一律視為不合格。
- 禁止通靈補地址、禁止猜區域。若只有路名，你必須追問：
  「請問是哪一個區的[路名]呢？為了避免司機跑錯，再麻煩提供一下喔！🥰」
- 在「地址含行政區」與「時間具體」同時成立前，嚴禁說已派車/已安排司機/司機要到了等誤導語。

【機場與里程計費（口徑固定）】
- 嚴禁只看到「機場」關鍵字就當成機場接送，必須先判斷為「交通請求/叫車意圖」才可套用機場定額。
- 機場定額（示例）：台北市多數區域 $1000、汐止 $1200、林口 $700。若區域不明，先追問區域再報價。
- 一般叫車里程計費：起步 $50，每公里 $20，4 公里內低消 $130（不知道公里數時就用這句說明，不要亂算總額）。

【等待費與特殊加價（強制）】
- 等待費：司機抵達後緩衝 5 分鐘，超過後每分鐘 5 元。客人問起時 reply 必須包含：「1分鐘都是5元喲🥰」。
- 暫時下車：若客人要求暫下/中途下車，不適用緩衝，立即以每分鐘 5 元開始計費（同樣要帶「1分鐘都是5元喲🥰」）。
- 特殊需求：指定「休旅車」或「雙B」加收 $100；兩者同時存在不疊加（只收一次 $100）。

【EmotionScore（0～100，整數）】
- 依本則訊息判斷乘客情緒負荷：著急、重複催促、髒話、恐懼、抱怨等 → 分數偏高；平穩敘述地址／時間 → 偏低。
- 疑似酒醉、意識不清、語無倫次、情緒失控 → emotion_score 至少 70。
- 一般略急 → 約 35～55。
- 冷靜明確 → 0～25。
- 你必須輸出欄位 emotion_score（數字）。若 emotion_score ≥ 40，reply 內須含**一句極短安撫**（例如：先別急／我這邊幫你看），且仍須符合字數上限。

【Map-First】
- 以司機用導航能否在台灣精準到點思考；不依門牌數字大小否決。
- pickup_verified=true 僅當地圖語境下地址真實可定位；模糊、重名、缺縣市區 → false，並用固定句型追問：「請問是在哪個縣市區的 [路名] 呢？」（[路名] 代入客人說的路）。
- 地圖上不存在 → false，簡短請對方改門牌或補路口。
- time_clear：時間具體可派車且寫入 draft.time 才 true；pickup_verified=false 則 time_clear 必 false。

【發送門檻對齊】
- pickup_verified 與 time_clear 尚未同時 true 時，reply 嚴禁「已安排司機」「幫你安排司機」「司機來了」「派車完成」等誤導；禁貼整段「❤️‍🔥加速派車格式」或表格式條列。

【draft】
- 合併草稿；下車可空。pickup 寫成方便搜尋的完整中文（含縣市區或明顯地標）。

目前已知草稿（JSON）：
${draftJson}

客人本則訊息：
${JSON.stringify(String(messageText ?? ""))}

只輸出 JSON（無 markdown），格式：
{
  "ride_related": true|false,
  "emotion_score": 0,
  "reply": "",
  "pickup_verified": true|false,
  "time_clear": true|false,
  "is_fake": true|false,
  "ride_timestamp": "ISO-8601" | null,
  "needs_admin_pricing": true|false,
  "price": number | null,
  "route_key": "" ,
  "draft": {
    "date": "",
    "time": "",
    "pickup": "",
    "dropoff": "",
    "passengers": "",
    "vehicle_request_type": "",
    "fare_surcharge": 0,
    "estimated_fare_text": ""
  },
  "missing": []
}
`.trim();
}

function normalizeRouteKey(pickup, dropoff) {
  return `${String(pickup ?? "").trim()} → ${String(dropoff ?? "").trim()}`;
}

let KB_CACHE = null;
async function loadKnowledgeBase() {
  if (KB_CACHE) return KB_CACHE;
  try {
    const raw = await readFile(KB_FILE, "utf8");
    const obj = JSON.parse(raw);
    const routes = obj?.routes && typeof obj.routes === "object" ? obj.routes : {};
    const airport_flat_rates = obj?.airport_flat_rates && typeof obj.airport_flat_rates === "object"
      ? obj.airport_flat_rates
      : null;
    KB_CACHE = { routes, airport_flat_rates };
    return KB_CACHE;
  } catch {
    KB_CACHE = { routes: {}, airport_flat_rates: null };
    return KB_CACHE;
  }
}

async function lookupKnowledgePrice(pickup, dropoff) {
  const key = normalizeRouteKey(pickup, dropoff);
  if (!key || !String(pickup ?? "").trim() || !String(dropoff ?? "").trim()) return null;
  const kb = await loadKnowledgeBase();
  const v = kb.routes?.[key];
  const price = typeof v === "number" ? v : Number(v?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { route_key: key, price: Math.round(price) };
}

function looksLikeFakeDriverNote(messageText) {
  const t = String(messageText ?? "");
  return /(假資|派主|機器人)/.test(t);
}

function looksLikePricingQuestion(messageText) {
  const t = String(messageText ?? "");
  return /(多少錢|幾錢|車資|費用|報價|怎麼算|多少算)/.test(t);
}

function forcedCurrentYear() {
  // 需求：缺年份時強制補上系統當前年份 2026
  // 避免不同部署環境年份/時區造成 timer 失效。
  return 2026;
}

function normalizeRideTimestampYearTo2026(ts) {
  const s = String(ts ?? "").trim();
  if (!s) return null;
  if (/^(2024|2025)-/.test(s)) return s.replace(/^(2024|2025)-/, "2026-");
  return s;
}

function parseRideTimestampString(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // ISO already
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const ms = Date.parse(s);
    const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    return normalizeRideTimestampYearTo2026(iso);
  }

  // 21號凌晨12點 / 21號半夜1點
  const cd = s.match(/^(\d{1,2})\s*號\s*(凌晨|半夜)\s*(\d{1,2})\s*點(?:\s*(\d{1,2})\s*分)?\s*$/);
  if (cd) {
    const now = new Date();
    const year = forcedCurrentYear();
    const month = now.getMonth() + 1; // no month provided → assume current month
    const day = Number(cd[1]);
    const hourRaw = Number(cd[3]);
    const minute = cd[4] ? Number(cd[4]) : 0;
    const hour = hourRaw === 12 ? 0 : hourRaw; // 凌晨/半夜12點 = 00:00
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(dt.getTime()) ? normalizeRideTimestampYearTo2026(dt.toISOString()) : null;
  }

  // 05/07 凌晨12點 / 5/7 半夜1點
  const md = s.match(
    /^(\d{1,2})[\/\-](\d{1,2})\s*(凌晨|半夜)\s*(\d{1,2})\s*點(?:\s*(\d{1,2})\s*分)?\s*$/
  );
  if (md) {
    const year = forcedCurrentYear();
    const month = Number(md[1]);
    const day = Number(md[2]);
    const hourRaw = Number(md[4]);
    const minute = md[5] ? Number(md[5]) : 0;
    const hour = hourRaw === 12 ? 0 : hourRaw;
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(dt.getTime()) ? normalizeRideTimestampYearTo2026(dt.toISOString()) : null;
  }

  // 今天/明天 HH:mm
  const rel = s.match(/^(今天|明天)\s*(\d{1,2})(?::(\d{2}))?\s*$/);
  if (rel) {
    const baseYear = forcedCurrentYear();
    const now = new Date();
    let year = baseYear;
    let month = now.getMonth() + 1;
    let day = now.getDate();
    if (rel[1] === "明天") {
      const d = new Date(baseYear, now.getMonth(), now.getDate() + 1);
      year = d.getFullYear();
      month = d.getMonth() + 1;
      day = d.getDate();
    }
    const hour = Number(rel[2]);
    const minute = rel[3] ? Number(rel[3]) : 0;
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(dt.getTime()) ? normalizeRideTimestampYearTo2026(dt.toISOString()) : null;
  }

  // 今天/明天 凌晨/半夜 12點(30分)
  const relNight = s.match(
    /^(今天|明天)\s*(凌晨|半夜)\s*(\d{1,2})\s*點(?:\s*(\d{1,2})\s*分)?\s*$/
  );
  if (relNight) {
    const baseYear = forcedCurrentYear();
    const now = new Date();
    let base = new Date(baseYear, now.getMonth(), now.getDate());
    if (relNight[1] === "明天") base = new Date(baseYear, now.getMonth(), now.getDate() + 1);
    const hourRaw = Number(relNight[3]);
    const minute = relNight[4] ? Number(relNight[4]) : 0;
    const hour = hourRaw === 12 ? 0 : hourRaw;
    const dt = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
    return Number.isFinite(dt.getTime()) ? normalizeRideTimestampYearTo2026(dt.toISOString()) : null;
  }

  // 05/07 14:30 or 5/7 1430
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2})(?::(\d{2}))?\s*$/);
  if (m) {
    const year = forcedCurrentYear();
    const month = Number(m[1]);
    const day = Number(m[2]);
    const hour = Number(m[3]);
    const minute = m[4] ? Number(m[4]) : 0;
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    return Number.isFinite(dt.getTime()) ? normalizeRideTimestampYearTo2026(dt.toISOString()) : null;
  }

  return null;
}

function parseRideTimestampFromDraft({ date, time }) {
  const d = String(date ?? "").trim();
  const t = String(time ?? "").trim();
  if (!d || !t) return null;

  // Accept patterns like: 2026-05-07, 2026/05/07, 5/7, 05/07
  const dm = d.match(/^(?:(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})|(\d{1,2})[\/\-](\d{1,2}))$/);
  const tm = t.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!dm || !tm) return null;

  const year = dm[1] ? Number(dm[1]) : forcedCurrentYear();
  const month = dm[2] ? Number(dm[2]) : Number(dm[4]);
  const day = dm[3] ? Number(dm[3]) : Number(dm[5]);
  const hour = Number(tm[1]);
  const minute = tm[2] ? Number(tm[2]) : 0;
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;

  const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (!Number.isFinite(dt.getTime())) return null;
  return normalizeRideTimestampYearTo2026(dt.toISOString());
}

function detectVehicleRequestType(messageText) {
  const t = String(messageText ?? "");
  if (!t.trim()) return "";

  const hasSuv = /(休旅|SUV|休旅車)/i.test(t);
  const hasDoubleB = /(雙\s*B|BMW|賓士|Benz|Mercedes)/i.test(t);
  const hasHighEnd = /(高級車|豪華車|高檔車)/.test(t);
  const hasSpecified = /(指定|要.+車|要.+款|要.+型)/.test(t);

  // 指定費：只要是指定車種而非隨機派發，一律 +100（不疊加）
  if (hasSuv && hasDoubleB) return "suv_double_b";
  if (hasSuv) return "suv";
  if (hasDoubleB) return "double_b";
  if (hasHighEnd || hasSpecified) return "specified";
  return "";
}

function vehicleTypeLabel(vehicle_request_type) {
  if (vehicle_request_type === "suv") return "休旅";
  if (vehicle_request_type === "double_b") return "雙B";
  if (vehicle_request_type === "suv_double_b") return "休旅/雙B";
  if (vehicle_request_type === "specified") return "指定車種";
  return "";
}

function vehicleTypeSurcharge(vehicle_request_type) {
  if (!vehicle_request_type) return 0;
  return 100;
}

function parsePassengersHint(messageText, draftPassengers) {
  const t = String(messageText ?? "");
  const dp = String(draftPassengers ?? "").trim();
  const m =
    t.match(/(\d+)\s*人/) ||
    t.match(/人數[:：]?\s*(\d+)/) ||
    t.match(/共\s*(\d+)\s*人/);
  const n1 = m ? Number(m[1]) : NaN;
  if (Number.isFinite(n1) && n1 > 0) return Math.round(n1);
  const n2 = Number(dp);
  if (Number.isFinite(n2) && n2 > 0) return Math.round(n2);
  return null;
}

function overloadSurchargeByPassengers(passengers, seatType) {
  const p = Number(passengers);
  if (!Number.isFinite(p) || p <= 0) return 0;

  const seat = Number(String(seatType ?? "").trim());
  const baseCap = Number.isFinite(seat) && seat >= 7 ? 6 : 4;

  if (p <= baseCap) return 0;
  return (p - baseCap) * 100;
}

function ensureSurchargeQuestionInReply(reply, vehicle_request_type) {
  if (!vehicle_request_type) return reply;

  const label = vehicleTypeLabel(vehicle_request_type);
  const surcharge = vehicleTypeSurcharge(vehicle_request_type);
  const hasAsk =
    /加價\s*\d+/.test(reply) ||
    /加\s*\d+/.test(reply) ||
    /多\s*\d+/.test(reply) ||
    /接受\s*\d+/.test(reply);

  if (hasAsk) return reply;

  const ask = `另外${label ? `要${label}` : "指定車"}加價${surcharge}可嗎？`;
  return `${String(reply ?? "").trim()} ${ask}`.trim();
}

function hasAdminDistrict(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // 勿用 \\b：中文「板橋區文化路」中「區」後接漢字時 \\b 不成立，會誤判成無行政區。
  return /[^\s，,]{1,12}(區|鄉|鎮)/.test(t);
}

function extractRoadName(text) {
  const t = String(text ?? "");
  const m = t.match(/([^\s，,]{2,12}(路|街|大道|巷|弄))/);
  return m?.[1] || "";
}

function isOnlyRoadWithoutDistrict(pickup) {
  const t = String(pickup ?? "").trim();
  if (!t) return false;
  // 已有區／鄉／鎮／市：視為帶行政或縣市語境，不當成「只有路名」。
  if (/(區|鄉|鎮|市)/.test(t)) return false;
  const hasRoad = /(路|街|大道|巷|弄)/.test(t);
  if (!hasRoad) return false;
  return !hasAdminDistrict(t);
}

function isAirportRideIntent(messageText) {
  const t = String(messageText ?? "");
  if (!/機場/.test(t)) return false;
  return /(去|到|送|接|載|搭|前往|從|出發)/.test(t);
}

function estimateAirportFlatFare(pickup) {
  // Back-compat fallback: keep previous behavior if KB missing
  const p = String(pickup ?? "");
  if (/汐止/.test(p)) return 1200;
  if (/林口/.test(p)) return 700;
  if (/台北市/.test(p)) return 1000;
  return 1000;
}

function isTaoyuanAirportMentioned(text) {
  const t = String(text ?? "");
  return /(桃機|桃園機場|機場)/.test(t);
}

function normalizeDistrictHint(text) {
  const t = String(text ?? "");
  const candidates = [
    "信義",
    "大安",
    "松山",
    "中正",
    "中山",
    "大同",
    "北投",
    "萬華",
    "南港",
    "內湖",
    "文山",
    "板橋",
    "三重",
    "蘆洲",
    "土城",
    "中和",
    "永和",
    "新店",
    "淡水",
    "汐止",
    "林口",
    "桃園區",
    "蘆竹",
    "基隆七堵"
  ];
  for (const c of candidates) {
    if (t.includes(c)) return c;
    if (t.includes(`${c}區`)) return c;
  }
  return "";
}

async function estimateAirportFlatFareByKb({ pickup, messageText, dropoff }) {
  // Use knowledge_base.json airport_flat_rates if available.
  // Only applies when intent is airport ride and destination mentions airport.
  if (!isTaoyuanAirportMentioned(dropoff || messageText)) return null;

  const district = normalizeDistrictHint(pickup) || normalizeDistrictHint(messageText);
  if (!district) return null;

  const kb = await loadKnowledgeBase();
  const table = kb?.airport_flat_rates?.to_taoyuan_airport;
  if (!table) return null;

  function findInGroup(group) {
    if (!group || typeof group !== "object") return null;
    for (const [priceStr, arr] of Object.entries(group)) {
      if (!Array.isArray(arr)) continue;
      if (arr.some((x) => String(x) === district)) return Number(priceStr);
    }
    return null;
  }

  const match =
    findInGroup(table?.taipei_city) ??
    findInGroup(table?.new_taipei_city) ??
    findInGroup(table?.taoyuan_keelung) ??
    null;
  return Number.isFinite(match) ? match : null;
}

function extractJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? s;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(candidate.slice(first, last + 1));
  } catch {
    return null;
  }
}

function dedupeModelIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const m = String(id ?? "").trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

function isGeminiModelNotFoundError(err) {
  const status = err?.status ?? err?.cause?.status;
  if (status === 404) return true;
  const msg = String(err?.message ?? err ?? "");
  return /\b404\b|not found|ListModels/i.test(msg);
}

/**
 * 依序嘗試 apiVersion（v1 → v1beta）與多個模型 ID；避免單一模型在專案/區域下架造成整條解析 404。
 * 可設 GEMINI_MODEL 覆寫為鏈上第一順位。
 */
async function generateContentWithGeminiFallback(apiKey, prompt) {
  const envOverride = (process.env.GEMINI_MODEL || "").trim();
  const modelIds = dedupeModelIds([
    envOverride,
    FIXED_MODEL_ID,
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash"
  ]);
  const apiVersions = ["v1", "v1beta"];

  let lastErr = null;
  for (const apiVersion of apiVersions) {
    const genAI = new GoogleGenerativeAI(apiKey, { apiVersion });
    for (const modelId of modelIds) {
      try {
        const model = genAI.getGenerativeModel({ model: modelId }, { apiVersion });
        const res = await model.generateContent(prompt);
        if (modelId !== FIXED_MODEL_ID) {
          console.warn("[AI] Gemini model fallback:", { apiVersion, modelId });
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (!isGeminiModelNotFoundError(err)) throw err;
      }
    }
  }
  throw lastErr ?? new Error("Gemini: no working model for this API key");
}

/**
 * @param {string} messageText
 * @param {{ draft?: Record<string,string> }} [options]
 * @returns {Promise<{
 *   ride_related: boolean,
 *   emotion_score: number,
 *   reply: string,
 *   pickup_verified: boolean,
 *   time_clear: boolean,
 *   draft: { date: string, time: string, pickup: string, dropoff: string, passengers: string },
 *   missing: string[]
 * } | null>}
 */
export async function parseOrderFromText(messageText, options = {}) {
  try {
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      console.error("Missing GEMINI_API_KEY");
      return null;
    }

    const prevDraft = options.draft || {};
    const vehicle_request_type_hint = detectVehicleRequestType(messageText);
    const draftJson = JSON.stringify(
      {
        date: prevDraft.date || "",
        time: prevDraft.time || "",
        pickup: prevDraft.pickup || "",
        dropoff: prevDraft.dropoff || "",
        passengers: prevDraft.passengers || "",
        vehicle_request_type: prevDraft.vehicle_request_type || "",
        fare_surcharge: Number(prevDraft.fare_surcharge) || 0,
        estimated_fare_text: prevDraft.estimated_fare_text || ""
      },
      null,
      0
    );

    const systemPrompt = buildSystemPrompt(draftJson, messageText);

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await generateContentWithGeminiFallback(apiKey, systemPrompt);
        const raw = res?.response?.text?.() ?? "";
        const obj = extractJsonObject(raw);
        if (!obj || typeof obj !== "object") throw new Error("AI output invalid");

          const draft = {
            date: String(obj.draft?.date ?? "").trim(),
            time: String(obj.draft?.time ?? "").trim(),
            pickup: String(obj.draft?.pickup ?? "").trim(),
            dropoff: String(obj.draft?.dropoff ?? "").trim(),
            passengers: String(obj.draft?.passengers ?? "").trim(),
            vehicle_request_type: String(obj.draft?.vehicle_request_type ?? "").trim(),
            fare_surcharge: Number(obj.draft?.fare_surcharge ?? 0),
            estimated_fare_text: String(obj.draft?.estimated_fare_text ?? "").trim()
          };

          let pickup_verified = Boolean(obj.pickup_verified) && Boolean(draft.pickup.trim());
          let time_clear = Boolean(obj.time_clear) && Boolean(draft.time.trim());
          if (time_clear && !pickup_verified) time_clear = false;

          // ===== 地址絕對嚴謹（司機保護） =====
          // 只要像「中正路」這種沒有行政區，就算 AI 說 verified 也一律打回追問。
          if (pickup_verified && !hasAdminDistrict(draft.pickup)) {
            pickup_verified = false;
          }
          if (pickup_verified && isOnlyRoadWithoutDistrict(draft.pickup)) {
            pickup_verified = false;
          }
          if (!pickup_verified) time_clear = false;

          // ===== 特殊需求（休旅/雙B） =====
          const allowedVehicleTypes = new Set(["", "suv", "double_b", "suv_double_b", "specified"]);
          if (!allowedVehicleTypes.has(draft.vehicle_request_type)) {
            draft.vehicle_request_type = "";
          }

          draft.fare_surcharge = Number.isFinite(draft.fare_surcharge)
            ? Math.max(0, Math.min(100, Math.round(draft.fare_surcharge)))
            : 0;

          if (vehicle_request_type_hint) {
            draft.vehicle_request_type = vehicle_request_type_hint;
            draft.fare_surcharge = vehicleTypeSurcharge(vehicle_request_type_hint);
          } else if (!draft.vehicle_request_type) {
            draft.fare_surcharge = 0;
          } else {
            draft.fare_surcharge = vehicleTypeSurcharge(draft.vehicle_request_type);
          }

          // v0.5.0：加人費（超載準則）
          // 5座：基準4人，第5人+100；6座：基準5人，第6人+100；7座以上：基準6人，第7人起每多1人+100
          const passengersHint = parsePassengersHint(messageText, draft.passengers);
          const overloadSurcharge = overloadSurchargeByPassengers(passengersHint, "");

          const rawScore = Number(obj.emotion_score);
          const emotion_score = Number.isFinite(rawScore)
            ? Math.min(100, Math.max(0, Math.round(rawScore)))
            : 0;

          let reply =
            String(obj.reply ?? "").trim() ||
            "收到，請補縣市區、路名門牌，再加希望時間，謝謝。";

          // 若只有路名（無行政區），強制使用固定追問句（司機保護，禁止通靈）
          // 若 pickup 已含區／鄉／鎮／市，不可覆寫 AI 原 reply（避免復讀錯誤追問）。
          const pickupHasAdminMarker = /(區|鄉|鎮|市)/.test(String(draft.pickup ?? ""));
          if (isOnlyRoadWithoutDistrict(draft.pickup) && !pickupHasAdminMarker) {
            const road = extractRoadName(draft.pickup) || extractRoadName(messageText) || "這條路";
            reply = `請問是哪一個區的${road}呢？為了避免司機跑錯，再麻煩提供一下喔！🥰`;
          }

          // ===== 預計車資口徑（派單欄位用） =====
          if (isAirportRideIntent(messageText) && Boolean(obj.ride_related)) {
            if (pickup_verified) {
              const kbFlat = await estimateAirportFlatFareByKb({
                pickup: draft.pickup,
                messageText,
                dropoff: draft.dropoff
              });
              if (Number.isFinite(kbFlat)) {
                draft.estimated_fare_text = `機場定額 $${kbFlat}`;
              } else {
                // 查無定額 → 改用最短里程估價（起步50+每公里20）
                const est = await getGoogleShortestRouteEstimate({
                  origin: draft.pickup,
                  destination: draft.dropoff || messageText
                });
                if (est?.km) {
                  const calc = Math.round(50 + 20 * Number(est.km));
                  draft.estimated_fare_text = `最短${est.km}km 估$${calc}`;
                } else {
                  const flatFallback = estimateAirportFlatFare(draft.pickup);
                  draft.estimated_fare_text = `機場定額 $${flatFallback}`;
                }
              }
            } else {
              draft.estimated_fare_text = "機場定額需看上車區域(請補行政區)";
            }
          } else if (Boolean(obj.ride_related)) {
            draft.estimated_fare_text = "起步$50＋$20/公里（4公里內低消$130）";
          }

          // v0.5.0：等待費備註（AI 報價 draft 需備註）
          draft.estimated_fare_text = `${draft.estimated_fare_text}；等候5分後$5/分`;

          // ===== v0.3.0：假資偵測 + ride_timestamp + 未建檔報價攔截 =====
          const is_fake = looksLikeFakeDriverNote(messageText) || Boolean(obj.is_fake);

          const ride_timestamp =
            (typeof obj.ride_timestamp === "string" && obj.ride_timestamp.includes("T"))
              ? normalizeRideTimestampYearTo2026(String(obj.ride_timestamp).trim())
              : normalizeRideTimestampYearTo2026(parseRideTimestampString(obj.ride_timestamp)) ||
                normalizeRideTimestampYearTo2026(parseRideTimestampFromDraft(draft));

          const route_key = normalizeRouteKey(draft.pickup, draft.dropoff);
          let needs_admin_pricing = Boolean(obj.needs_admin_pricing);
          let price = obj.price == null ? null : Number(obj.price);

          if (looksLikePricingQuestion(messageText) && pickup_verified && String(draft.dropoff ?? "").trim()) {
            const kbHit = await lookupKnowledgePrice(draft.pickup, draft.dropoff);
            if (kbHit) {
              needs_admin_pricing = false;
              price = kbHit.price;
            } else {
              // 查無內建價目 → 改用 Google 最短里程估價（起步50+每公里20）
              const est = await getGoogleShortestRouteEstimate({
                origin: draft.pickup,
                destination: draft.dropoff
              });
              if (est?.km) {
                needs_admin_pricing = false;
                price = Math.round(50 + 20 * Number(est.km));
              } else {
                needs_admin_pricing = true;
                price = null;
              }
            }
          }

          // v0.5.0：AI 在解析時必須把加價反映在 price 與 draft
          const totalSurcharge = Math.max(0, (draft.fare_surcharge || 0) + (overloadSurcharge || 0));
          if (Number.isFinite(price) && price != null) {
            price = Math.round(Number(price) + totalSurcharge);
          }
          draft.estimated_fare_text = `${draft.estimated_fare_text}；加價+$${totalSurcharge}`;

          reply = ensureSurchargeQuestionInReply(reply, draft.vehicle_request_type);
          reply = ensureReplyLengthBand(reply);

          return {
            ride_related: Boolean(obj.ride_related),
            emotion_score,
            reply,
            pickup_verified,
            time_clear,
            is_fake,
            ride_timestamp: normalizeRideTimestampYearTo2026(ride_timestamp) || null,
            needs_admin_pricing,
            price: Number.isFinite(price) ? Math.round(price) : null,
            route_key,
            draft,
            missing: Array.isArray(obj.missing) ? obj.missing.map((x) => String(x)) : []
          };
      } catch (err) {
        lastErr = err;
        const status = err?.status;
        if (status === 503 || status === 429) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        break;
      }
    }

    throw lastErr || new Error("AI failed");
  } catch (err) {
    console.error("[AI Error]", err?.message || err);
    return null;
  }
}

// =====================================================================================
// Rs 雙北板規 v0.1.9：司機群「喊單/強姦/狀態機/計費核對」規則（供 server.js 呼叫）
// =====================================================================================

/** @typedef {"reservation"|"instant"} RsOrderTiming */

function nowMs() {
  return Date.now();
}

function minutesBetweenMs(a, b) {
  return Math.max(0, Math.round((b - a) / 60000));
}

function parseIntSafe(v) {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function isMultipleOf5(n) {
  return Number.isFinite(n) && n % 5 === 0;
}

/**
 * 解析司機喊單訊息
 * - 預約單：允許喊「準」
 * - 即時單：允許喊數字分鐘（需為 5 的倍數）
 */
export function parseRsDriverBid(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return { kind: "unknown" };

  if (/^準$/.test(raw)) {
    return { kind: "ready" };
  }

  // 支援「信義10」「新店 15」「我10」等：取最後一段數字
  const m = raw.match(/(\d{1,3})\s*$/);
  if (m) {
    const minutes = parseIntSafe(m[1]);
    if (minutes == null) return { kind: "unknown" };
    return { kind: "minutes", minutes };
  }

  return { kind: "unknown" };
}

export function validateRsBid({ timing, bid }) {
  if (timing === "reservation") {
    if (bid.kind === "ready") return { ok: true };
    if (bid.kind === "minutes") {
      if (!isMultipleOf5(bid.minutes)) {
        return { ok: false, reason: "板規：喊單時間要 5 的倍數（例如 10/15/20），你這個不算喔。" };
      }
      return { ok: true };
    }
    return { ok: false, reason: "板規：預約單請喊「準」或 5 的倍數分鐘（例如 10/15）。" };
  }

  // instant
  if (bid.kind === "minutes") {
    if (!isMultipleOf5(bid.minutes)) {
      return { ok: false, reason: "板規：喊單時間要 5 的倍數（例如 10/15/20），你這個不算喔。" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "板規：即時單請直接喊分鐘（5 的倍數，例如 10/15/20）。" };
}

/**
 * @typedef {{
 *  driverUserId: string,
 *  createdAtMs: number,
 *  kind: "ready"|"minutes",
 *  minutes?: number
 * }} RsBid
 */

/**
 * 選出目前「得標」司機（不含派單員標記）
 * - reservation：有喊「準」者優先，若多位都「準」，以最早為準
 * - instant：分鐘越小越優先；同分以最早為準（後喊者可走「強姦」流程）
 */
export function pickRsLeadingBid({ timing, bids }) {
  const list = Array.isArray(bids) ? bids.slice() : [];
  if (!list.length) return null;

  if (timing === "reservation") {
    const ready = list.filter((b) => b.kind === "ready");
    if (ready.length) {
      ready.sort((a, b) => a.createdAtMs - b.createdAtMs);
      return ready[0];
    }
  }

  const minutesBids = list.filter((b) => b.kind === "minutes" && Number.isFinite(b.minutes));
  if (!minutesBids.length) return null;
  minutesBids.sort((a, b) => (a.minutes ?? 9999) - (b.minutes ?? 9999) || a.createdAtMs - b.createdAtMs);
  return minutesBids[0];
}

/**
 * 同分強姦判定：
 * - 若尚未標記：同分後喊者可「強姦」取代領先者
 * - 若已標記：只有派出後 1 分鐘內（尚方寶劍窗口）才允許同分強姦
 */
export function canRsRapeTie({
  timing,
  leadingBid,
  challengerBid,
  dispatcherMarkedAtMs,
  assignedAtMs
}) {
  if (!leadingBid || !challengerBid) return false;
  if (timing !== "instant") return false;
  if (leadingBid.kind !== "minutes" || challengerBid.kind !== "minutes") return false;
  if ((leadingBid.minutes ?? null) !== (challengerBid.minutes ?? null)) return false;
  if (challengerBid.createdAtMs <= leadingBid.createdAtMs) return false;

  if (!dispatcherMarkedAtMs) return true;

  if (!assignedAtMs) return false;
  return nowMs() - assignedAtMs <= 60_000;
}

export function parseRsDispatcherMark(text) {
  const t = String(text ?? "");
  if (!t.includes("@")) return null;
  // 簡化：只要有 @ 就視為派單員已標記（細節由 server.js 對應到哪位司機）
  return { kind: "dispatcher_marked" };
}

export function parseRsStateSignal(text) {
  const t = String(text ?? "").trim();
  if (!t) return { kind: "unknown" };
  if (t.includes("到")) return { kind: "arrived" };
  if (t.includes("客上")) return { kind: "onboard" };

  const m = t.match(/客下\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/);
  if (m) {
    return { kind: "dropoff", km: Number(m[1]), fare: Number(m[2]) };
  }
  return { kind: "unknown" };
}

export function rsFareExpectedBy52(km) {
  const k = Number(km);
  if (!Number.isFinite(k) || k < 0) return null;
  const raw = 50 + 20 * k;
  return Math.max(130, Math.round(raw));
}

export function rsFareBy52FromMeters(distanceMeters) {
  const m = Number(distanceMeters);
  if (!Number.isFinite(m) || m <= 0) return null;
  const km = m / 1000;
  return { km: Number(km.toFixed(1)), fare: rsFareExpectedBy52(km) };
}

export function rsCheckOvercharge({ km, fare }) {
  const expected = rsFareExpectedBy52(km);
  if (expected == null) return { ok: true, expected: null };
  const f = Number(fare);
  if (!Number.isFinite(f) || f <= 0) return { ok: true, expected };
  if (f > expected) return { ok: false, expected, diff: Math.round(f - expected) };
  return { ok: true, expected, diff: 0 };
}

/**
 * v0.2.0 最短里程估價（Google Directions）
 * 需要環境變數 GOOGLE_MAPS_API_KEY
 */
export async function getGoogleShortestRouteEstimate({ origin, destination }) {
  const key = String(process.env.MAPS_API_KEY ?? process.env.GOOGLE_MAPS_API_KEY ?? "").trim();
  if (!key) return null;
  const o = String(origin ?? "").trim();
  const d = String(destination ?? "").trim();
  if (!o || !d) return null;

  const url =
    "https://maps.googleapis.com/maps/api/directions/json" +
    `?origin=${encodeURIComponent(o)}` +
    `&destination=${encodeURIComponent(d)}` +
    "&mode=driving&region=tw&language=zh-TW" +
    `&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const meters = data?.routes?.[0]?.legs?.[0]?.distance?.value;
    const metersNum = Number(meters);
    const est = rsFareBy52FromMeters(metersNum);
    if (!est?.fare) return null;
    return {
      distance_meters: Math.round(metersNum),
      km: est.km,
      fare: est.fare
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Penalty Tracker：
 * - 強姦成功但「遲到」：以最終車資 3 成賠給被搶單司機
 * - 遲到定義（簡化）：實際「到」的耗時 > 喊單分鐘（即時單）視為遲到
 */
export function createPenaltyTracker() {
  const records = new Map();

  function key(orderId) {
    return String(orderId ?? "");
  }

  return {
    version: RS_RULES_VERSION,

    onRapeSuccess({ orderId, fromDriverUserId, toDriverUserId, bidMinutes, assignedAtMs }) {
      if (!orderId || !fromDriverUserId || !toDriverUserId) return;
      records.set(key(orderId), {
        orderId,
        fromDriverUserId,
        toDriverUserId,
        bidMinutes: Number(bidMinutes) || null,
        assignedAtMs: Number(assignedAtMs) || nowMs(),
        arrivedAtMs: null,
        fare: null
      });
    },

    onArrived({ orderId, arrivedAtMs }) {
      const r = records.get(key(orderId));
      if (!r) return;
      r.arrivedAtMs = Number(arrivedAtMs) || nowMs();
    },

    onFareKnown({ orderId, fare }) {
      const r = records.get(key(orderId));
      if (!r) return;
      r.fare = Number(fare);
    },

    computeCompensation({ orderId }) {
      const r = records.get(key(orderId));
      if (!r) return null;
      if (!Number.isFinite(r.fare) || r.fare <= 0) return null;
      if (!r.arrivedAtMs || !r.assignedAtMs) return null;
      if (!Number.isFinite(r.bidMinutes) || r.bidMinutes <= 0) return null;

      const elapsedMin = minutesBetweenMs(r.assignedAtMs, r.arrivedAtMs);
      if (elapsedMin <= r.bidMinutes) return null;

      return {
        orderId: r.orderId,
        fromDriverUserId: r.fromDriverUserId,
        toDriverUserId: r.toDriverUserId,
        lateByMinutes: elapsedMin - r.bidMinutes,
        compensation: Math.round(r.fare * 0.3)
      };
    }
  };
}
