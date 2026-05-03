import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v3-dispatcher";
let CACHED_MODEL_ID = null;
let CACHED_MODEL_CANDIDATES = null;

console.log("AI module loaded.", { AI_RESOLVER_VERSION });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
 *   reply: string,
 *   complete: boolean,
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
    const draftJson = JSON.stringify({
      date: prevDraft.date || "",
      time: prevDraft.time || "",
      pickup: prevDraft.pickup || "",
      dropoff: prevDraft.dropoff || "",
      passengers: prevDraft.passengers || ""
    });

    const genAI = new GoogleGenerativeAI(apiKey);
    const firstModelId = await getAvailableModel(apiKey);
    const modelCandidates =
      Array.isArray(CACHED_MODEL_CANDIDATES) && CACHED_MODEL_CANDIDATES.length
        ? CACHED_MODEL_CANDIDATES
        : [firstModelId];

    const prompt = `
你是專業的「調度排車員」。語氣簡潔、專業、親切；核心目標是完成派單。
你正在用「碎片收集模式」與客人對話：就算客人只打「車」「林森」等極短內容，也要盡力解讀並累積到草稿（draft）。
若資訊不足，請在 reply 主動追問：上車地點、門牌號、時間、下車地點、人數等缺漏項。
若客人聊無關話題，請在 reply 禮貌繞回，堅持引導提供地址與行程資訊（防歪樓）。

目前已知的草稿（JSON，可能為空字串）：
${draftJson}

客人本則訊息：
${JSON.stringify(String(messageText ?? ""))}

請只輸出 JSON（不要 markdown、不要多餘文字），格式如下：
{
  "ride_related": true|false,
  "reply": "給客人的一句話（繁中）",
  "complete": true|false,
  "draft": {
    "date": "日期或空字串",
    "time": "時間或空字串",
    "pickup": "上車地點或空字串",
    "dropoff": "下車地點或空字串",
    "passengers": "人數或空字串"
  },
  "missing": ["缺漏欄位簡述，例如：下車地點、時間…"]
}

規則：
1) 若與叫車/行程無關且無法合理推斷，ride_related=false，reply 禮貌帶回地址詢問。
2) 合併規則：把本則訊息能確定的欄位填入 draft；不確定就保留空字串；不要亂編造假地址。
3) 只有當 date、time、pickup、dropoff、passengers 五個欄位都能合理填滿（不可為空）時，complete=true；否則 complete=false 並在 missing 列出缺項。
4) reply 要簡短（建議 1～3 句），像真人調度。
`.trim();

    let lastErr = null;
    for (let i = 0; i < Math.min(modelCandidates.length, 4); i++) {
      const modelId = modelCandidates[i];
      const model = genAI.getGenerativeModel({ model: modelId });

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await model.generateContent(prompt);
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

          return {
            ride_related: Boolean(obj.ride_related),
            reply: String(obj.reply ?? "").trim() || "您好，請提供上車地點與目的地，方便為您排車。",
            complete: Boolean(obj.complete),
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
