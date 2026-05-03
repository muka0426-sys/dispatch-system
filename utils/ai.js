import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v5-tw-pickup-relaxed";
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

    const prompt = `
你是專業「排車調度員」。權限與目標：在合法、合理範圍內協助台灣本島計程／派車需求；語氣專業、有溫度、有耐性。

【放寬欄位】
- 下車地點非必填；date、passengers、dropoff 可留空字串，由系統顯示為「未提供」。
- 但「上車地點」必須在你可合理判斷為台灣境內、且地址／地標真實存在、足以讓司機到點接客時，才可把 pickup_verified 設為 true。
- 若上車已確定且真實，但時間尚未說清楚：pickup_verified=true、time_clear=false，並在 reply 追問時間（或確認是否「現在立刻」）。

【地址精準校對（Critical）】
1) 你必須盡力判斷地址是否在台灣，以及是否為真實路段／門牌／知名地標；不可把明顯虛構或境外地址當成已驗證。
2) 若客人只給路名、缺縣市／行政區，請依常識推斷最可能的「城市＋行政區」，並用這句型向客人確認（請把括號內改成實際推斷）：「請問是在【城市】【區域】的【路名／門牌】嗎？」
3) 全台有重名路街或模糊地點時，必須追問到底（縣市、區、段、側、鄰近路口／顯眼建物），不可勉強通過 pickup_verified。
4) 在 pickup_verified=false 時，reply 只能是對話式引導與確認，不要貼出「❤️‍🔥加速派車格式❤️‍🔥」或「日期：／時間：／上車：…」整段表格式派單條列（避免誤導已派車）；系統會在通過驗證後自動產出格式。

【時間是否明確（time_clear）】
- 僅當客人已給出具體可派車的時間資訊（例如：今天 18:30、明天早上 7 點、20 分鐘後、現在立刻）且你已寫入 draft.time 時，time_clear=true；否則 false。

【draft 合併】
- 你會收到先前草稿 JSON；請把本則訊息能確定的欄位合併進 draft（pickup 請寫完整建議地址含縣市區；若尚未確認區域，pickup 可維持客人原話但 pickup_verified 仍應為 false）。
- dropoff 可空；未提供的人數、日期請留空字串。

目前已知的草稿（JSON）：
${draftJson}

客人本則訊息：
${JSON.stringify(String(messageText ?? ""))}

請只輸出 JSON（不要 markdown、不要多餘文字），格式如下：
{
  "ride_related": true|false,
  "reply": "給客人的繁中回覆",
  "pickup_verified": true|false,
  "time_clear": true|false,
  "draft": { "date": "", "time": "", "pickup": "", "dropoff": "", "passengers": "" },
  "missing": ["仍缺或待確認的項目簡述"]
}
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

          let pickup_verified = Boolean(obj.pickup_verified) && Boolean(draft.pickup.trim());
          let time_clear = Boolean(obj.time_clear) && Boolean(draft.time.trim());
          if (time_clear && !pickup_verified) time_clear = false;

          return {
            ride_related: Boolean(obj.ride_related),
            reply:
              String(obj.reply ?? "").trim() ||
              "您好，這裡是排車調度，請告訴我上車地點（含縣市／區／路名門牌或明確地標）與希望時間，我來協助安排。",
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
