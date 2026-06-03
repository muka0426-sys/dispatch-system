# AI Decision Schema Draft

## 0. Purpose

- 本檔是未來 AI 派車專員 **decision schema** 草案。
- 目前只做設計，**不進程式**。
- 不代表 `server.js` 或 `utils/ai_v7.js` 已實作。
- 角色定義見 `AI_DISPATCHER_ROLE.md`。

## 1. Current AI output gap

### 目前 `ai_v7.js` / `parseOrderFromText` 已有

| 欄位 | 用途（簡述） |
|------|----------------|
| `ride_related` | 是否與叫車相關 |
| `reply` | 給客人的自然語言回覆 |
| `draft` | date / time / pickup / dropoff / passengers 等 |
| `missing` | 缺欄位列表 |
| `price` | 估價數字 |
| `route_key` | 路線 key |
| `needs_admin_pricing` | 需老闆報價 |
| `pickup_verified` | AI 認為地址文字是否足夠（非 Maps 結果） |
| `time_clear` | 時間是否清楚 |
| `is_fake` | 假資 / 惡搞 |
| `ride_timestamp` | 預約時間 |
| `emotion_score` | 情緒分數 |
| `estimated_fare_text`（在 draft 內） | 車資說明文字 |

### 缺少（decision 層）

| 欄位 | 用途 |
|------|------|
| `intent` | 本則主要意圖分類 |
| `decision` | 結構化決策物件（見 §2） |
| `should_dispatch` | 是否建議進入派車候選 |
| `should_quote_only` | 是否僅報價、不派車 |
| `should_cancel` | 是否建議取消 |
| `should_hold` | 是否應等待確認 |
| `should_escalate` | 是否應人工介入 |
| `next_action` | 建議 server 下一步（機器可讀） |
| `reason` | 去識別化短句理由 |
| `confidence` | high / medium / low |

## 2. Proposed top-level decision object

建議在 AI JSON 輸出中新增頂層欄位 `decision`（與現有 `draft`、`reply` 並存）：

```json
{
  "decision": {
    "intent": "dispatch_request",
    "action": "dispatch_candidate",
    "should_dispatch": true,
    "should_quote_only": false,
    "should_cancel": false,
    "should_hold": false,
    "should_escalate": false,
    "confidence": "high",
    "reason": "guest provided pickup and dropoff for new trip",
    "next_action": "verify_maps_then_dispatch_candidate"
  }
}
```

### 欄位定義

| 欄位 | 型別 | 允許值 |
|------|------|--------|
| `intent` | string | `dispatch_request` \| `quote_request` \| `cancel_request` \| `status_inquiry` \| `modify_order` \| `special_request` \| `chitchat` \| `unknown` |
| `action` | string | `ask_followup` \| `quote_only` \| `hold_for_confirmation` \| `dispatch_candidate` \| `cancel_candidate` \| `status_reply` \| `escalate_to_human` \| `ignore` |
| `should_dispatch` | boolean | 是否建議進入派車流程（**非**直接派車） |
| `should_quote_only` | boolean | 是否僅報價 |
| `should_cancel` | boolean | 是否建議取消 |
| `should_hold` | boolean | 是否應暫停等待確認 |
| `should_escalate` | boolean | 是否應轉人工 |
| `confidence` | string | `high` \| `medium` \| `low` |
| `reason` | string | 去識別化短句；不含姓名、電話、完整地址 |
| `next_action` | string | 機器可讀建議，例如 `reply_status_only`、`set_pending_quote` |

### intent 與 action 對照（草案）

| intent | 典型 action |
|--------|-------------|
| `dispatch_request` | `dispatch_candidate` 或 `ask_followup` |
| `quote_request` | `quote_only` |
| `cancel_request` | `cancel_candidate` |
| `status_inquiry` | `status_reply` |
| `modify_order` | `dispatch_candidate` 或 `hold_for_confirmation` |
| `special_request` | `hold_for_confirmation` 或 `escalate_to_human` |
| `chitchat` | `ignore` |
| `unknown` | `ask_followup` 或 `escalate_to_human`（confidence low 時） |

## 3. Execution safety rules

以下規則在 schema 設計中視為**鐵律**（未來 server 實作時仍須遵守）：

- **`should_dispatch=true` 也不能直接派車** — server 必須再檢查 pickup / dropoff / time / Maps / active order / 現行 gate。
- **`quote_request` / `should_quote_only=true` 不可 `createOrder`** — 須進 quote 流程或 pending。
- **`cancel_request` / `should_cancel=true` 必須過 cancel 安全** — 與現行 cancel gate 對齊或雙重確認。
- **`status_inquiry` 不可 `createOrder`** — 僅 status 回覆或查狀態。
- **`special_request` 必須先 `hold_for_confirmation`** — 不可 silent dispatch。
- **`confidence: low` 必須追問或人工介入** — 不可在高不確定下派車。

## 4. Example decisions

（去識別化範例，非客戶原文）

| 情境 | intent | action | should_dispatch | 備註 |
|------|--------|--------|-----------------|------|
| 客人提供完整上下車地點，明確要車 | `dispatch_request` | `dispatch_candidate` | true | server 仍須 Maps |
| 客人問「A 到 B 多少錢」 | `quote_request` | `quote_only` | false | should_quote_only=true |
| 客人說「不用了 / 那算了」 | `cancel_request` | `cancel_candidate` | false | should_cancel=true |
| 客人問「車到了嗎」且已有 active order | `status_inquiry` | `status_reply` | false | 不建新 draft |
| 客人說「有寵物」 | `special_request` | `hold_for_confirmation` | false | should_hold=true |
| 客人只給不完整路名、缺行政區 | `dispatch_request` | `ask_followup` | false | confidence medium |
| 客人要求代買 / 搬家 / 跑腿 | `special_request` | `escalate_to_human` 或 `hold_for_confirmation` | false | should_escalate 或 hold |
| 客人閒聊、感謝 | `chitchat` | `ignore` | false | ride_related=false |

## 5. Relationship to current gates

| 現行 gate | 本階段策略 |
|-----------|------------|
| **cancel gate** | **保留**；未來 AI 輸出 `cancel_candidate` 時可 log 對照 |
| **quote gate** | **保留**；未來 AI 輸出 `quote_only` 時可 log 對照 |
| **special lock** | **保留**；與 `hold_for_confirmation` 對齊 |
| **status inquiry gate** | **保留**；與 `status_reply` 對齊 |
| **driverReady / Maps** | **保留**；decision 僅為建議，不取代硬條件 |

- 未來 AI decision **可先只 log，不直接控制派車**。
- 等 log 對照穩定、GPT 審查通過後，再評估是否縮小部分 regex gate（改為 AI 建議 + gate 確認）。

## 6. Migration plan

| Phase | 內容 | 改程式？ |
|-------|------|----------|
| **Phase 0** | 文件定義（`AI_DISPATCHER_ROLE.md`、`AI_DECISION_SCHEMA_DRAFT.md`） | 否 |
| **Phase 1** | `ai_v7.js` 增加 `decision` 欄位輸出；`server.js` **只記錄 / log，不執行** | 是（待 GPT 任務包） |
| **Phase 2** | 比較 AI decision 與現行 gate / `driverReady` 結果；產對照報告 | 否（或僅 log） |
| **Phase 3** | 只讓**低風險** decision 參與輔助判斷（例如 status_inquiry 與 gate 一致時簡化） | 是（待審查） |
| **Phase 4** | **仍保留** server safety hard gates（cancel、quote、Maps、special confirm） | 持續 |

**Phase 0 狀態：本檔與 `AI_DISPATCHER_ROLE.md` 已完成；Phase 1 尚未開始。**
