/**
 * 內部邏輯測試（不依賴 Gemini API）：node utils/ai_v7.address_gate.test.mjs
 */
import assert from "node:assert/strict";
import {
  finalizePickupDispatchGate,
  looksLikePromptFictionPickupHint
} from "./ai_v7.js";

function test(name, fn) {
  try {
    fn();
    console.log("ok:", name);
  } catch (e) {
    console.error("fail:", name, e);
    process.exitCode = 1;
  }
}

test("蟑螂區老鼠路：惡搞後備應觸發，且閘門關閉（即使 AI 誤判 verified）", () => {
  const draft = { pickup: "蟑螂區老鼠路1號", time: "10:00" };
  assert.equal(looksLikePromptFictionPickupHint(draft.pickup), true);
  const gate = finalizePickupDispatchGate(
    { is_fake: false, pickup_verified: true, time_clear: true },
    draft,
    looksLikePromptFictionPickupHint(draft.pickup)
  );
  assert.equal(gate.pickup_verified, false);
  assert.equal(gate.time_clear, false);
});

test("蟑螂區老鼠路：AI 標假資時必關閉", () => {
  const draft = { pickup: "蟑螂區老鼠路", time: "10:00" };
  const gate = finalizePickupDispatchGate(
    { is_fake: true, pickup_verified: true, time_clear: true },
    draft,
    false
  );
  assert.equal(gate.pickup_verified, false);
  assert.equal(gate.time_clear, false);
});

test("板橋區文化路：真實語境且 AI 核實通過時應放行", () => {
  const draft = { pickup: "板橋區文化路一段100號", time: "10:00" };
  assert.equal(looksLikePromptFictionPickupHint(draft.pickup), false);
  const gate = finalizePickupDispatchGate(
    { is_fake: false, pickup_verified: true, time_clear: true },
    draft,
    false
  );
  assert.equal(gate.pickup_verified, true);
  assert.equal(gate.time_clear, true);
});

test("板橋區文化路：AI 判定不可核實時必須尊重（不因字面有區而放行）", () => {
  const draft = { pickup: "板橋區文化路一段100號", time: "10:00" };
  const gate = finalizePickupDispatchGate(
    { is_fake: false, pickup_verified: false, time_clear: true },
    draft,
    false
  );
  assert.equal(gate.pickup_verified, false);
  assert.equal(gate.time_clear, false);
});

if (process.exitCode) {
  console.error("\n部分測試失敗。");
} else {
  console.log("\n全部地址閘門測試通過。");
}
