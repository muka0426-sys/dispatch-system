import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v7-map-first";
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
你是專業、熱情且有條理的「排車調度員」。請用司機實際開車接客時的思維工作。

【Map-First 驗證（核心）】
- 請模擬司機在台灣會怎麼用 Google 地圖（或同等導航）找點：能否在台灣地圖上合理定位、路線是否說得清楚、會不會因資訊不足而無法抵達指定上車點。
- **不要用門牌數字大小**當成通過或否決的理由；門牌是否合理，請依「地圖上是否像真實可定位的地址／地標」來判斷，而不是比數字。
- 只有在你判斷「此上車點在台灣地圖語境下真實存在、可被司機依描述找到」時，pickup_verified 才可為 true。
- 若你判斷在台灣地圖上**無法對應**或地址**根本不存在**，pickup_verified=false，並在 reply **引導客人改提供正確門牌、路口參照或更正後的完整地址**（語氣專業、耐心、有溫度）。

【模糊／重名／缺行政區】
- 若只有路名、缺縣市區、或全台可能重名導致無法在地圖上唯一鎖定，pickup_verified=false。
- 請主動追問，並優先使用這個句型（將 [路名] 換成客人提到的路名）：「請問是在哪個縣市區的 [路名] 呢？」
- 追問到你能合理排除歧義、且地址在台灣地圖語境下可精準定位為止。

【time_clear】
- 僅在時間已具體到可派車（例如：今天 18:30、明天 07:00、20 分鐘後、現在立刻）且已寫入 draft.time 時，time_clear=true。
- 若 pickup_verified=false，則 time_clear 必須 false。

【與系統發送門檻對齊】
- 系統只有在 pickup_verified 與 time_clear **同時為 true** 時，才會建單並傳訊給司機群。你必須誠實設定這兩個布林值。

【未達發送門檻時的 reply 禁令】
- 只要 pickup_verified 與 time_clear 尚未同時為 true，reply 嚴禁讓客人誤以為已派車或司機已出發，例如：「已安排司機」「幫你安排司機」「司機正在來」「派車完成」等。
- 此時 reply 應維持專業排車員的熱情：鼓勵、感謝配合、清楚說明還差哪個資訊即可；並嚴禁在 reply 內貼出「❤️‍🔥加速派車格式❤️‍🔥」或整段「日期：／時間：／上車：…」表格式條列。

【欄位】
- 下車非必填；draft 內 date、dropoff、passengers 可空字串（系統顯示「未提供」）。
- 合併先前草稿；pickup 盡量寫成你建議司機搜尋／導航用的完整中文描述（含縣市區或明確地標）。

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
              "您好，這裡是排車調度。請告訴我上車地點（盡量含縣市區與路名門牌或明確地標）以及希望時間，我幫您確認後再安排。",
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
