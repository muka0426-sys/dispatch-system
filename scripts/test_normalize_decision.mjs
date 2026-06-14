import { normalizeDecision } from "../utils/ai_v7.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log("OK:", msg);
}

// 1. Full v2 decision
const full = normalizeDecision({
  intent: "cancel_request",
  action: "cancel_candidate",
  should_dispatch: false,
  should_quote_only: false,
  should_cancel: true,
  should_hold: true,
  should_escalate: true,
  confidence: "high",
  reason: "guest confirmed cancel after wait",
  next_action: "confirm_cancel"
});
assert(full.action === "cancel_candidate", "action cancel_candidate");
assert(full.should_cancel === true, "should_cancel true");
assert(full.should_hold === true, "should_hold true");
assert(full.should_escalate === true, "should_escalate true");
assert(full.next_action === "confirm_cancel", "next_action confirm_cancel");

// 2. Missing optional fields default false / empty
const defaults = normalizeDecision({
  intent: "dispatch_request",
  action: "ask_followup",
  confidence: "medium",
  reason: "need pickup"
});
assert(defaults.should_cancel === false, "default should_cancel false");
assert(defaults.should_hold === false, "default should_hold false");
assert(defaults.should_escalate === false, "default should_escalate false");
assert(defaults.next_action === "", "default next_action empty");

// 3. Invalid intent / action fallback
const fallback = normalizeDecision({
  intent: "wait_driver_update",
  action: "not_a_real_action",
  confidence: "bogus"
});
assert(fallback.intent === "unknown", "invalid intent -> unknown");
assert(fallback.action === "ask_followup", "invalid action -> ask_followup");
assert(fallback.confidence === "low", "invalid confidence -> low");

// 4. Truncation
const longReason = "x".repeat(200);
const longNext = "y".repeat(120);
const truncated = normalizeDecision({
  intent: "status_inquiry",
  action: "status_reply",
  reason: longReason,
  next_action: longNext
});
assert(truncated.reason.length <= 120, "reason truncated");
assert(truncated.reason.endsWith("..."), "reason ends with ellipsis");
assert(truncated.next_action.length <= 80, "next_action truncated");
assert(truncated.next_action.endsWith("..."), "next_action ends with ellipsis");

// 5. PII redaction in reason / next_action
const pii = normalizeDecision({
  intent: "cancel_request",
  action: "cancel_candidate",
  reason: "call 0912345678 user U1234567890abcdef1234567890abcdef",
  next_action: "confirm_cancel 0987654321"
});
assert(!pii.reason.includes("0912345678"), "phone redacted in reason");
assert(!pii.reason.includes("U1234567890abcdef1234567890abcdef"), "userId redacted in reason");
assert(!pii.next_action.includes("0987654321"), "phone redacted in next_action");

if (process.exitCode) {
  console.error("\nSome tests failed.");
  process.exit(process.exitCode);
}
console.log("\nAll normalizeDecision smoke tests passed.");
