import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v7-map-first";
let CACHED_MODEL_ID = null;
let CACHED_MODEL_CANDIDATES = null;

const REPLY_MAX_CHARS = 50;
const REPLY_TARGET_MIN = 30;

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
  "draft": { "date": "", "time": "", "pickup": "", "dropoff": "", "passengers": "" },
  "missing": []
}
`.trim();
}

async function getAvailableModel(apiKey) {
  if (CACHED_MODEL_ID) return CACHED_MODEL_ID;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    const models = Array.isArray(data?.models) ? data.models : [];
    const supportsGenerate = (m) =>
      Array.isArray(m?.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent");

    const candidates = models
      .filter(supportsGenerate)
      .map((m) => String(m.name || ""))
      .filter(Boolean)
      .map((name) => name.replace(/^models\//, ""));

    const flash = candidates.filter((id) => id.toLowerCase().includes("flash"));
    CACHED_MODEL_CANDIDATES = [...flash, ...candidates.filter((id) => !flash.includes(id))];

    CACHED_MODEL_ID = CACHED_MODEL_CANDIDATES[0] || "gemini-1.5-flash-latest";
    console.log(`[AI] Auto-detected model: ${CACHED_MODEL_ID}`);
    return CACHED_MODEL_ID;
  } catch (e) {
    return "gemini-1.5-flash-latest";
  }
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
    const draftJson = JSON.stringify(
      {
        date: prevDraft.date || "",
        time: prevDraft.time || "",
        pickup: prevDraft.pickup || "",
        dropoff: prevDraft.dropoff || "",
        passengers: prevDraft.passengers || ""
      },
      null,
      0
    );

    const genAI = new GoogleGenerativeAI(apiKey);
    const firstModelId = await getAvailableModel(apiKey);
    const modelCandidates =
      Array.isArray(CACHED_MODEL_CANDIDATES) && CACHED_MODEL_CANDIDATES.length
        ? CACHED_MODEL_CANDIDATES
        : [firstModelId];

    const systemPrompt = buildSystemPrompt(draftJson, messageText);

    let lastErr = null;
    for (let i = 0; i < Math.min(modelCandidates.length, 4); i++) {
      const modelId = modelCandidates[i];
      const model = genAI.getGenerativeModel({ model: modelId });

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await model.generateContent(systemPrompt);
          const raw = res?.response?.text?.() ?? "";
          const obj = extractJsonObject(raw);
          if (!obj || typeof obj !== "object") throw new Error("AI output invalid");

          if (modelId && modelId !== CACHED_MODEL_ID) {
            CACHED_MODEL_ID = modelId;
            console.log(`[AI] Switched to working model: ${CACHED_MODEL_ID}`);
          }

          const draft = {
            date: String(obj.draft?.date ?? "").trim(),
            time: String(obj.draft?.time ?? "").trim(),
            pickup: String(obj.draft?.pickup ?? "").trim(),
            dropoff: String(obj.draft?.dropoff ?? "").trim(),
            passengers: String(obj.draft?.passengers ?? "").trim()
          };

          let pickup_verified = Boolean(obj.pickup_verified) && Boolean(draft.pickup.trim());
          let time_clear = Boolean(obj.time_clear) && Boolean(draft.time.trim());
          if (time_clear && !pickup_verified) time_clear = false;

          const rawScore = Number(obj.emotion_score);
          const emotion_score = Number.isFinite(rawScore)
            ? Math.min(100, Math.max(0, Math.round(rawScore)))
            : 0;

          let reply =
            String(obj.reply ?? "").trim() ||
            "收到，請補縣市區、路名門牌，再加希望時間，謝謝。";
          reply = ensureReplyLengthBand(reply);

          return {
            ride_related: Boolean(obj.ride_related),
            emotion_score,
            reply,
            pickup_verified,
            time_clear,
            draft,
            missing: Array.isArray(obj.missing) ? obj.missing.map((x) => String(x)) : []
          };
        } catch (err) {
          lastErr = err;
          const status = err?.status;
          if (status === 404) break;
          if (status === 503 || status === 429) {
            await sleep(250 * (attempt + 1));
            continue;
          }
          break;
        }
      }
    }

    throw lastErr || new Error("AI failed");
  } catch (err) {
    console.error("[AI Error]", err?.message || err);
    if (String(err?.message || "").includes("404") || err?.status === 404) {
      CACHED_MODEL_ID = null;
      CACHED_MODEL_CANDIDATES = null;
    }
    return null;
  }
}
