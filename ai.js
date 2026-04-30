import { GoogleGenerativeAI } from "@google/generative-ai";

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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

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

    return { isOrder: true, from, to, date, time, passengers, note };
  } catch (err) {
    console.error("AI 解析錯誤:", err);
    return null;
  }
}

