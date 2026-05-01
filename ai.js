import { GoogleGenerativeAI } from "@google/generative-ai";

const GEMINI_MODEL_ID = "gemini-1.5-flash-latest";
console.log("AI module loaded. Gemini model =", GEMINI_MODEL_ID);

function extractJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ?? s;

  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const maybe = candidate.slice(first, last + 1);
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}

export async function parseOrderFromText(messageText) {
  try {
    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      console.error("Missing Gemini API Key");
      return null;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_ID });

    const prompt = `
你是一個「白牌車派單系統」的意圖辨識 + 訂單資訊抽取器。
你只允許輸出 JSON（不要任何多餘文字、不要 markdown）。

任務：判斷使用者訊息是否具有「叫車/搭車」意圖。
- 如果不是叫車意圖（例如：打招呼、閒聊、詢問天氣、貼圖），請回傳：{"isOrder": false}
- 如果是叫車意圖，請回傳：{"isOrder": true, ...} 並盡可能抽取欄位。

輸出 JSON 格式（鍵名固定，未取得則用 null 或空字串）：
{
  "isOrder": true|false,
  "date": "日期(可選，字串)",
  "time": "時間(可選，字串)",
  "from": "起點(必填，字串)",
  "to": "終點(必填，字串)",
  "passengers": 1,
  "note": "備註(可選，字串)"
}

判斷規則提示：
- 具有叫車意圖的常見特徵：提到「叫車/搭車/去/到/從/上車/下車/起點/終點」或提供起終點資訊。
- 只有當你能合理判斷是叫車意圖時才回 isOrder=true；否則一律 isOrder=false。

使用者輸入：
${JSON.stringify(String(messageText ?? ""))}
`.trim();

    const res = await model.generateContent(prompt);
    const text = res?.response?.text?.() ?? "";

    const obj = extractJsonObject(text);
    if (!obj) throw new Error("AI output not JSON");

    const isOrder = Boolean(obj.isOrder);
    if (!isOrder) return null;

    const from = String(obj.from ?? "").trim();
    const to = String(obj.to ?? "").trim();
    const date = obj.date == null ? null : String(obj.date).trim() || null;
    const time = obj.time == null ? null : String(obj.time).trim() || null;
    const passengersNum = Number(obj.passengers);
    const passengers = Number.isFinite(passengersNum) && passengersNum > 0 ? passengersNum : 1;
    const note = String(obj.note ?? "");

    if (!from || !to) return null;

    // 回傳 JSON 字串（供上游直接 JSON.parse）
    return JSON.stringify({ isOrder: true, from, to, date, time, passengers, note });
  } catch (err) {
    // 針對最常見的部署問題做更清楚的錯誤訊息
    const status = err?.status;
    const reason =
      err?.errorDetails?.find?.((d) => d?.reason)?.reason ??
      err?.errorDetails?.[0]?.reason ??
      null;

    if (status === 400 && reason === "API_KEY_INVALID") {
      console.error(
        "AI 解析錯誤: Gemini API Key 無效（API_KEY_INVALID）。請到 Google AI Studio 重新產生 API Key，並更新 Railway 的 GEMINI_API_KEY（確認沒有多餘空白/換行、也沒有貼錯專案或已被撤銷）。"
      );
      console.error("AI 錯誤摘要:", { status, reason, model: GEMINI_MODEL_ID });
      return null;
    }

    console.error("AI 解析錯誤:", err);
    return null;
  }
}