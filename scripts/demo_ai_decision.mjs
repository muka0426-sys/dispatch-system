/**
 * Local AI decision v2 demo — no LINE, no DB, no dispatch.
 * Usage: node scripts/demo_ai_decision.mjs
 * Requires: GEMINI_API_KEY in environment or .env (not printed).
 */
import "dotenv/config";
import { parseOrderFromText } from "../utils/ai_v7.js";

const DEMO_MESSAGES = [
  "我要取消",
  "那算了不用了",
  "司機到了嗎",
  "還要多久",
  "我要從台北某路到新北某路",
  "這樣多少錢",
  "可以幫我買東西嗎",
  "我改成十分鐘後",
  "找不到司機嗎",
  "我已經叫到別台了"
];

const EMPTY_DRAFT = {
  date: "",
  time: "",
  pickup: "",
  dropoff: "",
  passengers: ""
};

function printDecisionSummary(input, result) {
  const d = result?.decision ?? {};
  console.log(JSON.stringify({
    input,
    intent: d.intent ?? null,
    action: d.action ?? null,
    should_dispatch: d.should_dispatch ?? null,
    should_quote_only: d.should_quote_only ?? null,
    should_cancel: d.should_cancel ?? null,
    should_hold: d.should_hold ?? null,
    should_escalate: d.should_escalate ?? null,
    next_action: d.next_action ?? null,
    confidence: d.confidence ?? null,
    reason: d.reason ?? null
  }, null, 2));
}

async function main() {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    console.error("缺少 GEMINI_API_KEY：請在環境變數或專案根目錄 .env 設定後再執行。");
    console.error("本腳本不 hardcode key，也不會印出 key。");
    process.exitCode = 0;
    return;
  }

  console.log("AI decision v2 local demo");
  console.log(`測試句數：${DEMO_MESSAGES.length}`);
  console.log("（僅輸出 decision 摘要，不含 reply/draft 全文）\n");

  const now = new Date();
  for (let i = 0; i < DEMO_MESSAGES.length; i++) {
    const input = DEMO_MESSAGES[i];
    console.log(`--- [${i + 1}/${DEMO_MESSAGES.length}] ---`);
    try {
      const result = await parseOrderFromText(input, {
        draft: { ...EMPTY_DRAFT },
        conversationHistory: [],
        activeOrderContext: null,
        now
      });
      if (!result) {
        console.log(JSON.stringify({ input, error: "parseOrderFromText returned null" }, null, 2));
      } else {
        printDecisionSummary(input, result);
      }
    } catch (err) {
      console.log(JSON.stringify({ input, error: String(err?.message || err) }, null, 2));
    }
    if (i < DEMO_MESSAGES.length - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log("\nDemo finished.");
}

main().catch((err) => {
  console.error("Demo failed:", err?.message || err);
  process.exitCode = 1;
});
