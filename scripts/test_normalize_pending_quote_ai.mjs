import { normalizePendingQuoteAiResult } from "../utils/ai_v7.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const cases = [
  {
    name: "high confirm_dispatch",
    in: { intent: "confirm_dispatch", confidence: "high", reason: "guest confirms" },
    intent: "confirm_dispatch",
    confidence: "high"
  },
  {
    name: "low confirm_dispatch blocked",
    in: { intent: "confirm_dispatch", confidence: "low", reason: "unclear" },
    intent: "unknown",
    confidence: "low"
  },
  {
    name: "invalid intent",
    in: { intent: "dispatch_now", confidence: "high" },
    intent: "unknown",
    confidence: "high"
  },
  {
    name: "reprice medium",
    in: { intent: "reprice", confidence: "medium", reason: "pricing again" },
    intent: "reprice",
    confidence: "medium"
  }
];

for (const c of cases) {
  const out = normalizePendingQuoteAiResult(c.in);
  assert(out.intent === c.intent, `${c.name}: intent ${out.intent} !== ${c.intent}`);
  assert(out.confidence === c.confidence, `${c.name}: confidence ${out.confidence} !== ${c.confidence}`);
}

console.log("All normalizePendingQuoteAiResult smoke tests passed.");
