import { GoogleGenerativeAI } from "@google/generative-ai";
import { readFile } from "node:fs/promises";

const AI_RESOLVER_VERSION = "v7-map-first";
const FIXED_MODEL_ID = "gemini-1.5-flash";

const REPLY_MAX_CHARS = 50;
const REPLY_TARGET_MIN = 30;
/** 問答／解釋情境：允許較長、像真人客服（仍設上限避免洗版） */
const REPLY_MAX_CHARS_LONG = 480;
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

/** 客人是否在問事／要說明（可較長回覆）；純補地址則維持短回。 */
function guestMessageLooksLikeSubstantiveQuestion(messageText) {
  const t = String(messageText ?? "").trim();
  if (!t) return false;
  if (looksLikePricingQuestion(t)) return true;
  if (
    /\?|？|什麼|為什麼|为啥|怎麼|怎办|多少|可以嗎|能不能|行嗎|請問|會不會|有沒有|解釋|說明|差別|比較|建議|怕|擔心|會不會太小|大車|行李|寵物|搬家/.test(
      t
    )
  ) {
    return true;
  }
  if ([...t].length >= 36) return true;
  return false;
}

/**
 * 依 .cursorrules：地圖優先、30～50 字、台灣派遣口語、EmotionScore、禁冗稱與誤導派車語。
 */
function formatConversationBlockForPrompt(entries) {
  if (!Array.isArray(entries) || !entries.length) return "（尚無）";
  return entries
    .slice(-12)
    .map((e) => {
      const role = e?.role === "assistant" ? "調度" : "乘客";
      return `${role}：${String(e?.text ?? "").slice(0, 220)}`;
    })
    .join("\n");
}

function buildSystemPrompt(
  draftJson,
  messageText,
  kbFareHint = "",
  conversationBlock = "",
  activeOrderBlock = "",
  clockDateStr = "",
  clockTimeStr = ""
) {
  return `
你是台灣派遣「排車調度」，口語像現場調度：簡短、清楚、不機械。禁用「親愛的顧客」等冗稱。

【現在時間錨點（鐵律，禁止通靈）】
- 今日日期為 ${clockDateStr || "（未提供）"}，現在時間為 ${clockTimeStr || "（未提供）"}。
- 若客人本則未指定日期，draft.date 必須以「今日」為準；**嚴禁**沿用近期對話或草稿裡的舊日期（例如 05-07、去年今日）。
- 未註明年份之月/日，一律視為 2026 年。

【對話靈魂（v0.7.4，強制）】
- 你是「有經驗的真人調度」，不是填表機器人。
- ride_related=false（閒聊、找老闆、幫朋友問、與叫車無關）：用正常人語氣回，**不要**嘮叨派車欄位、**不要**在 reply 貼「❤️‍🔥加速派車格式」或表格式叫車單。
- ride_related=true：必須承接「近期對話」與「進行中訂單」上下文。乘客若只說「改去板橋」「改下車」「加停一站」等，你要能辨識是在改**同一筆**需求，並在 reply **自然口語確認改了什麼**（例：好，下車幫你改成板橋），同時把異動寫進 draft。
- 資料尚未齊備時：像真人一樣一問一答引導，**不要**在 reply 內用「未提供」填滿假格式。
- 你只能萃取乘客提供的上車地點文字；Google Maps 實體驗證由 server.js 負責。**不要**在 reply 內貼整段加速派車格式（卡片由系統在條件成立時附加）。
- 行程或加價條件變動時，reply 裡的車資說明必須與 knowledge_base 定額／estimated_fare_text 邏輯一致，不可亂報價。
- draft.pickup 非空時：你可承接該上車點文字，但**不得宣稱地圖已核實**；若仍缺資料，只能追問缺的欄位（例如下車點或時間）。

【回覆長度（v0.7.7：情境式，禁止一律罐頭）】
- **客人只在補地址／時間／人數、語句單純**：reply 維持精簡（約 ${REPLY_TARGET_MIN}～${REPLY_MAX_CHARS} 字），例如「收到，幫您派車」這類自然短句即可。
- **客人有問句、議價／加價原因、車型大小、等候費、流程疑慮等**：要像**真人客服**，口語有禮、把重點講清楚；可寫到約 ${REPLY_MAX_CHARS_LONG} 字內，**嚴禁**用千篇一律的制式句硬剪短。
- **ride_related=false** 的閒聊：自然長度即可，不必硬塞派車欄位。

【近期對話節錄（舊→新；承接語意）】
${conversationBlock || "（尚無）"}

【進行中訂單摘要（可能為空；改單語意以此為錨）】
${activeOrderBlock || "（無）"}

【年份規則（強制）】
- 當前年份為 2026 年，所有未註明年份的日期（如 5/7）一律視為 2026 年。

【加價欄位 fare_surcharge（鐵律）】
- 輸出 JSON 時 fare_surcharge **必須為 0**，除非客人本則文字**明確**出現：要大車、指定雙B、休旅車、休旅、SUV、搬家、寵物等需求。
- **嚴禁**在 reply 捏造「已幫你加休旅／雙B 加價」等理由；沒有上述字眼就不要提特殊車款加價。

【地理與地址萃取（v0.7.11，AI 無最終驗證權）】
- 你只負責從客人文字中萃取可能的上車地點到 draft.pickup。pickup_verified 只能代表「有較完整候選文字」，**不得**代表已通過地圖驗證。
- 若客人提供簡略地址（如：133、133旅館、南港車站旁），你必須結合近期對話與進行中訂單上下文（如前文提到的縣市區、路名、地標）補全為完整候選地址格式（例：新北市汐止區樟樹一路133號）後再寫入 JSON。
- 嚴禁直接將純數字、單一門牌、模糊地標或「旁邊／附近」這類口語原文直接丟入 draft.pickup；上下文不足以補全時，draft.pickup 保持空或保留可用路名，pickup_verified=false，reply 請客人補完整門牌或地標。
- 真正是否可派車，必須由 server.js 呼叫 Google Maps API 核對；若 Google Maps 查無或太模糊，server.js 會擋下派單。
- 若出現明顯虛構、惡搞字樣（例如：蟑螂區、老鼠路、外星路），你仍應輸出 is_fake: true，並請對方提供真實可定位的位置。

【地址絕對嚴謹（司機保護，強制）】
- 你必須判斷上車地址是否包含「行政區」(例如：板橋區、中山區、汐止區)。只寫路名（例如：中正路）一律視為不合格。
- 禁止通靈補地址、禁止猜區域。若只有路名，你必須追問：
  「請問是哪一個區的[路名]呢？為了避免司機跑錯，再麻煩提供一下喔！🥰」
- 在「地址含行政區」與「時間具體」同時成立前，嚴禁說已派車/已安排司機/司機要到了等誤導語。

【機場與里程計費（口徑固定）】
- 嚴禁只看到「機場」關鍵字就當成機場接送，必須先判斷為「交通請求/叫車意圖」才可套用機場定額。
- 機場定額（示例）：台北市多數區域 $1000、汐止 $1200、林口 $700。若區域不明，先追問區域再報價。
- 一般叫車里程計費：起步 $50，每公里 $20，4 公里內低消 $130（不知道公里數時就用這句說明，不要亂算總額）。

【知識庫定額（最高準則）】
- 下列內容來自 knowledge_base.json；若非空，代表已定額。**嚴禁**在 reply 或 price 自創與下列牴觸的金額。
${kbFareHint ? kbFareHint : "（本則尚未由系統預先命中 KB 定額；仍須遵守後續欄位與口徑。）"}

【等待費與特殊加價（強制）】
- 等待費：司機抵達後緩衝 5 分鐘，超過後每分鐘 5 元。客人問起時 reply 必須包含：「1分鐘都是5元喲🥰」。
- 暫時下車：若客人要求暫下/中途下車，不適用緩衝，立即以每分鐘 5 元開始計費（同樣要帶「1分鐘都是5元喲🥰」）。
- 車種加價 $100：**僅當**客人本則明確提到要大車／休旅或 SUV／指定雙B（或明確雙B 品牌）／搬家／寵物時，系統才會加；兩者同時存在不疊加。**不要**因泛泛的「指定」就假設要加價。

【EmotionScore（0～100，整數）】
- 依本則訊息判斷乘客情緒負荷：著急、重複催促、髒話、恐懼、抱怨等 → 分數偏高；平穩敘述地址／時間 → 偏低。
- 疑似酒醉、意識不清、語無倫次、情緒失控 → emotion_score 至少 70。
- 一般略急 → 約 35～55。
- 冷靜明確 → 0～25。
- 你必須輸出欄位 emotion_score（數字）。若 emotion_score ≥ 40，reply 內須含**一句安撫**（例如：先別急／我這邊幫你看），並在對方有疑問時給足說明，不要為了短而敷衍。

【Map-First】
- 以司機用導航能否在台灣精準到點思考；但你不做最終地圖判定。
- pickup_verified=true 只可在客人文字看起來足以送 Google Maps 驗證時使用；模糊、重名、缺縣市區 → false，並用固定句型追問：「請問是在哪個縣市區的 [路名] 呢？」（[路名] 代入客人說的路）。
- 地圖是否存在由 server.js 判定；你不要自行宣稱「地圖已找到」。
- time_clear：時間具體可派車且寫入 draft.time 才 true；pickup_verified=false 則 time_clear 必 false。

【發送門檻對齊（v0.7.11 極速盲派 + Google Maps 安全鎖）】
- server.js 只要萃取到上車點候選，會先呼叫 Google Maps API 實體驗證；只有 Google Maps 找到明確有效地址後，才建立訂單並向司機群發送唯一一次派車卡。
- 你只負責解析資料與自然回話，**嚴禁**在 reply 貼整段「❤️‍🔥加速派車格式」或表格式條列。
- 如果已取得上車點但缺下車點，reply 應簡短承接：「收到，已為您派車。請問下車地點是哪裡？」；後續補資料只更新資料或由 server.js 純文字通知已接單司機，絕不重發派車卡。

【draft】
- 合併草稿；下車可空。pickup 寫成方便搜尋且可送 Google Maps 驗證的完整中文（含縣市區、路名門牌或明確地標）；嚴禁只填純數字或模糊口語。

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

/** 每次解析前可清掉快取，強制重新讀取 knowledge_base.json（定額以檔案為準）。 */
export function invalidateKnowledgeBaseCache() {
  KB_CACHE = null;
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

/**
 * 呼叫模型前：依草稿＋本則文字預讀 KB，寫入 prompt（嚴禁 AI 自創與 KB 牴觸的價格）。
 */
export async function buildKbFareHintForPrompt(messageText, prevDraft) {
  await loadKnowledgeBase();
  const pickup = String(prevDraft?.pickup ?? "").trim();
  const dropoff = String(prevDraft?.dropoff ?? "").trim();
  const msg = String(messageText ?? "");
  const pickupHint = pickup || msg;
  const dropHint = dropoff || msg;
  const lines = [];

  if (pickupHint && isAirportRideIntent(msg) && isTaoyuanAirportMentioned(dropHint)) {
    const af = await estimateAirportFlatFareByKb({
      pickup: pickupHint,
      messageText: msg,
      dropoff: dropHint
    });
    if (Number.isFinite(af)) {
      lines.push(`- 機場定額（知識庫）：基礎 $${af}（加價／人數另計，由 estimated_fare_text 呈現）。reply 嚴禁寫成其他金額。`);
    }
  }

  if (pickup && dropoff) {
    const hit = await lookupKnowledgePrice(pickup, dropoff);
    if (hit) {
      lines.push(`- 內建路線（知識庫）「${hit.route_key}」：$${hit.price}。reply 報價須與此一致。`);
    }
  }

  return lines.join("\n");
}

/** 從已定稿的 estimated_fare_text 抽出「定額基礎＋加價」合計，供與對話對齊。 */
export function parseKbCanonicalFareTotal(estimatedFareText) {
  const s = String(estimatedFareText ?? "");
  let base = null;
  const mA = s.match(/機場定額 \$(\d+)/);
  const mR = s.match(/內建路線定額 \$(\d+)/);
  if (mA) base = Number(mA[1]);
  else if (mR) base = Number(mR[1]);
  if (base == null || !Number.isFinite(base)) return null;
  const mS = s.match(/加價\+\$(\d+)/);
  const sur = mS && Number.isFinite(Number(mS[1])) ? Number(mS[1]) : 0;
  return Math.round(base + sur);
}

export function alignCustomerReplyToEstimatedFare(reply, estimatedFareText) {
  const total = parseKbCanonicalFareTotal(estimatedFareText);
  if (total == null) return String(reply ?? "").trim();
  let t = String(reply ?? "")
    .replace(/\$\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const tail = `參考$${total}（同派車卡）。`;
  return `${t} ${tail}`.trim();
}

export function finalizeCustomerFareReply(reply, estimatedFareText, messageText = "") {
  const aligned = alignCustomerReplyToEstimatedFare(reply, estimatedFareText);
  if (guestMessageLooksLikeSubstantiveQuestion(messageText)) {
    return clipReplyToMaxChars(aligned, REPLY_MAX_CHARS_LONG);
  }
  return ensureReplyLengthBand(aligned);
}

function suppressAddressReaskWhenPickupVerified(reply, pickup_verified, draft) {
  if (!pickup_verified) return String(reply ?? "").trim();
  const pickup = String(draft?.pickup ?? "").trim();
  if (!pickup) return String(reply ?? "").trim();
  const t = String(reply ?? "").trim();
  const reask =
    /(哪一個區|哪個區|哪裡上車|上車在哪|在哪個縣市區|請補.*地址|補.*縣市區)/.test(t);
  if (!reask) return t;
  const missingDropoff = !String(draft?.dropoff ?? "").trim() || String(draft?.dropoff ?? "").trim() === "—";
  const missingTime = !String(draft?.time ?? "").trim();
  if (missingDropoff && missingTime) return "好的，上車點我記下了～再給我下車地點跟時間就行。";
  if (missingDropoff) return "好的，上車點我記下了～下車要到哪裡呢？";
  if (missingTime) return "好的，上車點我記下了～想幾點搭車呢？";
  return "好的，上車點我記下了～我這邊幫你整理。";
}

function looksLikeFakeDriverNote(messageText) {
  const t = String(messageText ?? "");
  return /(假資|派主|機器人)/.test(t);
}

/** 與 system prompt 範例對齊；AI 推理為主，此僅後備攔截明顯惡搞字樣。 */
export function looksLikePromptFictionPickupHint(pickup) {
  const t = String(pickup ?? "");
  return /蟑螂區|老鼠路|外星路/.test(t);
}

export function looksLikePricingQuestion(messageText) {
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

/**
 * 車種加價：僅在客人本則**明確**出現關鍵需求時才回傳非空（嚴禁寬鬆「指定」誤判）。
 */
function detectExplicitVehicleSurchargeType(messageText) {
  const t = String(messageText ?? "");
  if (!t.trim()) return "";

  if (/搬家/.test(t)) return "specified";
  if (/寵物/.test(t)) return "specified";

  if (/(要大車|九人座|9人座|七人座|7人座)/.test(t)) return "specified";

  const hasSuv = /(休旅車|休旅|SUV)/i.test(t);
  const hasDoubleB = /(指定\s*雙\s*B|BMW|賓士|Benz|Mercedes)/i.test(t);

  if (hasSuv && hasDoubleB) return "suv_double_b";
  if (hasSuv) return "suv";
  if (hasDoubleB) return "double_b";
  return "";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 正規化 draft.date：缺欄位→今日（台北日曆）；缺年份→2026；舊年分 2024/2025→2026 */
function normalizeDraftDateTo2026(draftDateStr, refNow) {
  const ref =
    refNow instanceof Date && Number.isFinite(refNow.getTime()) ? refNow : new Date();
  const forced = forcedCurrentYear();

  if (!String(draftDateStr ?? "").trim()) {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(ref);
    const [y, m, d] = ymd.split("-");
    const yy = y === "2024" || y === "2025" ? forced : y;
    return `${yy}-${m}-${d}`;
  }

  const s = String(draftDateStr).trim();
  const mFull = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (mFull) {
    let yy = mFull[1];
    if (yy === "2024" || yy === "2025") yy = String(forced);
    return `${yy}-${pad2(mFull[2])}-${pad2(mFull[3])}`;
  }
  const mPart = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (mPart) {
    return `${forced}-${pad2(mPart[1])}-${pad2(mPart[2])}`;
  }
  const mZh = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (mZh) {
    return `${forced}-${pad2(mZh[1])}-${pad2(mZh[2])}`;
  }
  return s;
}

function stripUnwarrantedVehicleSurchargeClaims(reply, vehicleRequestType) {
  if (vehicleRequestType) return String(reply ?? "");
  let r = String(reply ?? "");
  r = r.replace(/另外(要)?.{0,16}加價\d+可嗎[？?]?/gi, "");
  r = r.replace(/(已幫|幫你).{0,12}(休旅|雙B|指定車|特殊車款)/g, "");
  r = r.replace(/(休旅|雙B|指定車種|特殊車款).{0,12}加價/g, "");
  r = r.replace(/\s{2,}/g, " ").trim();
  return r;
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

/**
 * AI 優先：若 AI 判定 is_fake，或 pickup_verified 為 false，則不可派車（不因字面上有「區」而放行）。
 * 僅在「非假資且 AI 聲稱 pickup_verified」時，才允許以結構規則向下加嚴（絕不將 false 改成 true）。
 * @param {Record<string, unknown>} obj AI 原始 JSON
 * @param {{ pickup?: string, time?: string }} draft
 * @param {boolean} [heuristicFake] 例如 looksLikeFakeDriverNote(messageText)
 * @returns {{ pickup_verified: boolean, time_clear: boolean }}
 */
export function finalizePickupDispatchGate(obj, draft, heuristicFake = false) {
  const pickupText = String(draft?.pickup ?? "").trim();
  const timeText = String(draft?.time ?? "").trim();
  const aiDeclaredFake = Boolean(obj?.is_fake) || Boolean(heuristicFake);
  const aiSaysPickupVerified = Boolean(obj?.pickup_verified);
  const aiSaysTimeClear = Boolean(obj?.time_clear);

  if (aiDeclaredFake || !aiSaysPickupVerified) {
    return { pickup_verified: false, time_clear: false };
  }

  let pickup_verified = aiSaysPickupVerified && Boolean(pickupText);
  let time_clear = aiSaysTimeClear && Boolean(timeText);
  if (time_clear && !pickup_verified) time_clear = false;

  if (pickup_verified && !hasAdminDistrict(pickupText)) {
    pickup_verified = false;
  }
  if (pickup_verified && isOnlyRoadWithoutDistrict(pickupText)) {
    pickup_verified = false;
  }
  if (!pickup_verified) time_clear = false;

  return { pickup_verified, time_clear };
}

function isAirportRideIntent(messageText) {
  const t = String(messageText ?? "");
  // 「送機／接機／桃機」常見寫法不含「機場」二字，不可只依賴 /機場/。
  if (/(送機|接機)/.test(t)) return true;
  if (!/(機場|桃機|桃園機場|國際機場|松山機場|航廈)/.test(t)) return false;
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

export async function estimateAirportFlatFareByKb({ pickup, messageText, dropoff }) {
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
 * @param {{
 *   draft?: Record<string,string>,
 *   conversationHistory?: Array<{ role?: string, text?: string }>,
 *   activeOrderContext?: Record<string, unknown> | null,
 *   now?: Date
 * }} [options]
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

    invalidateKnowledgeBaseCache();
    const currentDateTime =
      options.now instanceof Date && Number.isFinite(options.now.getTime())
        ? options.now
        : new Date();
    const clockDateStr = currentDateTime.toLocaleDateString("zh-TW");
    const clockTimeStr = currentDateTime.toLocaleTimeString("zh-TW");

    const prevDraft = options.draft || {};
    const vehicle_request_type_hint = detectExplicitVehicleSurchargeType(messageText);
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

    const kbFareHint = await buildKbFareHintForPrompt(messageText, prevDraft);
    const conversationBlock = formatConversationBlockForPrompt(options.conversationHistory);
    const activeOrderBlock =
      options.activeOrderContext && typeof options.activeOrderContext === "object"
        ? JSON.stringify(options.activeOrderContext, null, 0)
        : "";
    const systemPrompt = buildSystemPrompt(
      draftJson,
      messageText,
      kbFareHint,
      conversationBlock,
      activeOrderBlock,
      clockDateStr,
      clockTimeStr
    );

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
            vehicle_request_type: "",
            fare_surcharge: 0,
            estimated_fare_text: String(obj.draft?.estimated_fare_text ?? "").trim()
          };

          draft.date = normalizeDraftDateTo2026(draft.date, currentDateTime);

          const heuristicFake =
            looksLikeFakeDriverNote(messageText) || looksLikePromptFictionPickupHint(draft.pickup);
          const aiDeclaredFake = Boolean(obj.is_fake) || heuristicFake;
          const aiSaysPickupVerified = Boolean(obj.pickup_verified);
          let { pickup_verified, time_clear } = finalizePickupDispatchGate(obj, draft, heuristicFake);

          // ===== 特殊需求（休旅/雙B）：完全以本則明確關鍵字為準，忽略模型輸出 =====
          const allowedVehicleTypes = new Set(["suv", "double_b", "suv_double_b", "specified"]);
          draft.vehicle_request_type =
            vehicle_request_type_hint && allowedVehicleTypes.has(vehicle_request_type_hint)
              ? vehicle_request_type_hint
              : "";
          draft.fare_surcharge = draft.vehicle_request_type
            ? vehicleTypeSurcharge(draft.vehicle_request_type)
            : 0;

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

          // 若只有路名（無行政區），且 AI 已認為可核實、非假資，才補固定追問；其餘一律保留 AI reply。
          const pickupHasAdminMarker = /(區|鄉|鎮|市)/.test(String(draft.pickup ?? ""));
          if (
            !aiDeclaredFake &&
            aiSaysPickupVerified &&
            isOnlyRoadWithoutDistrict(draft.pickup) &&
            !pickupHasAdminMarker
          ) {
            const road = extractRoadName(draft.pickup) || extractRoadName(messageText) || "這條路";
            reply = `請問是哪一個區的${road}呢？為了避免司機跑錯，再麻煩提供一下喔！🥰`;
          }

          let airportKbFlatResolved = null;

          // ===== 預計車資口徑（派單欄位用） =====
          if (isAirportRideIntent(messageText) && Boolean(obj.ride_related)) {
            if (pickup_verified) {
              const kbFlat = await estimateAirportFlatFareByKb({
                pickup: draft.pickup,
                messageText,
                dropoff: draft.dropoff
              });
              if (Number.isFinite(kbFlat)) {
                airportKbFlatResolved = kbFlat;
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
            const routeHit =
              pickup_verified && String(draft.dropoff ?? "").trim()
                ? await lookupKnowledgePrice(draft.pickup, draft.dropoff)
                : null;
            if (routeHit) {
              draft.estimated_fare_text = `內建路線定額 $${routeHit.price}`;
            } else {
              draft.estimated_fare_text = "起步$50＋$20/公里（4公里內低消$130）";
            }
          }

          // v0.5.0：等待費備註（AI 報價 draft 需備註）
          draft.estimated_fare_text = `${draft.estimated_fare_text}；等候5分後$5/分`;

          // ===== v0.3.0：假資偵測 + ride_timestamp + 未建檔報價攔截 =====
          const is_fake = heuristicFake || Boolean(obj.is_fake);

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
          if (Number.isFinite(airportKbFlatResolved) && pickup_verified) {
            price = Math.round(airportKbFlatResolved + totalSurcharge);
            needs_admin_pricing = false;
          } else if (Number.isFinite(price) && price != null) {
            price = Math.round(Number(price) + totalSurcharge);
          }
          draft.estimated_fare_text = `${draft.estimated_fare_text}；加價+$${totalSurcharge}`;

          reply = stripUnwarrantedVehicleSurchargeClaims(reply, draft.vehicle_request_type);
          reply = ensureSurchargeQuestionInReply(reply, draft.vehicle_request_type);
          reply = suppressAddressReaskWhenPickupVerified(reply, pickup_verified, draft);
          reply = finalizeCustomerFareReply(reply, draft.estimated_fare_text, messageText);

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
