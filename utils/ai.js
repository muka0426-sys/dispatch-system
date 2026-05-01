import { GoogleGenerativeAI } from "@google/generative-ai";

const AI_RESOLVER_VERSION = "v2";
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

        // Prefer "flash" models, but keep a full fallback list.
        const candidates = models
            .filter(supportsGenerate)
            .map((m) => String(m.name || ""))
            .filter(Boolean)
            .map((name) => name.replace(/^models\//, ""));

        const flash = candidates.filter((id) => id.toLowerCase().includes("flash"));
        CACHED_MODEL_CANDIDATES = [...flash, ...candidates.filter((id) => !flash.includes(id))];

        CACHED_MODEL_ID = (CACHED_MODEL_CANDIDATES[0] || "gemini-1.5-flash-latest");
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
        const apiKey = (process.env.GEMINI_API_KEY || "").trim();
        if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

        const genAI = new GoogleGenerativeAI(apiKey);

        // Ensure model list is loaded at least once.
        const firstModelId = await getAvailableModel(apiKey);
        const modelCandidates = Array.isArray(CACHED_MODEL_CANDIDATES) && CACHED_MODEL_CANDIDATES.length
            ? CACHED_MODEL_CANDIDATES
            : [firstModelId];

        const prompt = `你是一個「白牌車派單系統」的文字解析器。請將輸入解析成 JSON：{"from":"起點","to":"終點","passengers":1,"note":""}。輸入：${messageText}`;

        let lastErr = null;
        for (let i = 0; i < Math.min(modelCandidates.length, 4); i++) {
            const modelId = modelCandidates[i];
            const model = genAI.getGenerativeModel({ model: modelId });

            // Retry a little on 503/429 for each model.
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const res = await model.generateContent(prompt);
                    const text = res?.response?.text?.() ?? "";
                    const obj = extractJsonObject(text);
                    if (!obj) throw new Error("AI output invalid");

                    // Success: cache the working model id.
                    if (modelId && modelId !== CACHED_MODEL_ID) {
                        CACHED_MODEL_ID = modelId;
                        console.log(`[AI] Switched to working model: ${CACHED_MODEL_ID}`);
                    }

                    return {
                        from: obj.from || "未知起點",
                        to: obj.to || "未知終點",
                        passengers: obj.passengers || 1,
                        note: obj.note || ""
                    };
                } catch (err) {
                    lastErr = err;
                    const status = err?.status;
                    if (status === 404) {
                        // model not found: break and try next model
                        break;
                    }
                    if (status === 503 || status === 429) {
                        await sleep(250 * (attempt + 1));
                        continue;
                    }
                    // other errors: break attempt loop and try next model
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