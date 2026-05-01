import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v2";
let CACHED_MODEL_ID = null;

console.log("AI module loaded.", { AI_RESOLVER_VERSION });

async function getAvailableModel(apiKey) {
    if (CACHED_MODEL_ID) return CACHED_MODEL_ID;
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        const model = data.models?.find(m => m.supportedGenerationMethods.includes("generateContent") && m.name.includes("flash"));
        CACHED_MODEL_ID = model ? model.name.split('/').pop() : "gemini-1.5-flash-latest";
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
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { return null; }
}

export async function parseOrderFromText(messageText) {
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

        const modelId = await getAvailableModel(apiKey);
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: modelId });

        const prompt = `你是一個「白牌車派單系統」的文字解析器。請將輸入解析成 JSON：{"from":"起點","to":"終點","passengers":1,"note":""}。輸入：${messageText}`;
        const res = await model.generateContent(prompt);
        const text = res?.response?.text?.() ?? "";
        const obj = extractJsonObject(text);

        if (!obj) throw new Error("AI output invalid");
        return {
            from: obj.from || "未知起點",
            to: obj.to || "未知終點",
            passengers: obj.passengers || 1,
            note: obj.note || ""
        };
    } catch (err) {
        console.error("[AI Error]", err.message);
        if (err.message.includes("404")) CACHED_MODEL_ID = null; // 遇到404就清掉快取重試
        return null; 
    }
}