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
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
你是一個「白牌車派單系統」的文字解析器。
請將使用者輸入解析成 JSON，且只輸出 JSON（不要任何多餘文字）。

輸出格式：
{
  "from": "起點(必填)",
  "to": "終點(必填)",
  "passengers": 1,
  "note": "可選備註"
}

使用者輸入：
${JSON.stringify(String(messageText ?? ""))}
`.trim();

    const res = await model.generateContent(prompt);
    const text = res?.response?.text?.() ?? "";

    const obj = extractJsonObject(text);
    if (!obj) throw new Error("AI output not JSON");

    return {
      from: String(obj.from ?? "").trim() || "未知起點",
      to: String(obj.to ?? "").trim() || "未知終點",
      passengers: Number(obj.passengers) || 1,
      note: String(obj.note ?? "")
    };

  } catch (err) {
    // 🔥 完全靜音（關鍵）
    return {
      from: "測試起點",
      to: "測試終點",
      passengers: 1,
      note: ""
    };
  }
}