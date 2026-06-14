# AI Decision Schema Draft v2 (Phase 1B Aligned)

> **Version:** draft v2 — Phase 1B aligned  
> **Status:** document-only — **不進程式**  
> **Supersedes:** v1 草案（同檔案內容升級；非獨立 fork）

## 0. Purpose

- 本檔是 AI 派車專員 **decision schema** 草案 **v2**，依 Phase 1B 規則對照補強語意、欄位說明與 `next_action` 範例。
- 目前只做設計與 log 對照參考，**不進程式**、**不直接控制派車**。
- 不代表 `server.js` 或 `utils/ai_v7.js` 已實作。
- 角色定義見 `AI_DISPATCHER_ROLE.md`。

### Phase 1B 對應來源

| 檔案 | 角色 |
|------|------|
| `TRAINING_RULE_EXTRACTION_PHASE1B_FROM_DEIDENTIFIED.md` | Phase 1B 規則候選（P1B-001～010） |
| `AI_DECISION_PHASE1B_MAPPING.md` | 規則 ↔ schema 對照表 |
| `AI_DISPATCHER_ROLE.md` | AI / server / gate 分工 |
| `TRAINING_DATA_PRIVACY_PLAN.md` | 隱私與禁止事項 |
| `PROJECT_STATE.md` | 專案主入口與訓練主線（§8） |

### Phase 1B 限制（必讀）

| 項目 | 說明 |
|------|------|
| **資料範圍** | 只根據 **6 筆 direct** 去識別化樣本（每筆前 50 行視窗） |
| **未納入** | **unknown 30** 未納入；**garbled 443** 禁止使用 |
| **不是全集** | 6 筆不是完整訓練全集；結論為 **Phase 1B 初步規則候選** |
| **不可直接用於線上** | **不可**直接改 LINE 派車流程、deploy 或 `server.js` 主線 |
| **程式狀態** | v2 仍為 document-only；Phase 1（ai_v7 log-only）尚未開始 |

### 隱私限制（必讀）

- 本文件**不得含**客戶原文。
- 本文件**不得含**姓名、電話、地址、車牌、ChatId、UserId、LINE ID。
- 範例一律使用去識別化短句或抽象情境描述。
- 撰寫過程**未讀** `training_deidentified_output/`、`hermes_candidate_usable_data/`、`final_chat.txt`、`customer_info.txt`、`captured_*.json`。

---

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

---

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
| `intent` | string | 見 §3.1 正式 intent |
| `action` | string | `ask_followup` \| `quote_only` \| `hold_for_confirmation` \| `dispatch_candidate` \| `cancel_candidate` \| `status_reply` \| `escalate_to_human` \| `ignore` |
| `should_dispatch` | boolean | 是否建議進入派車流程（**非**直接派車） |
| `should_quote_only` | boolean | 是否僅報價 |
| `should_cancel` | boolean | 是否建議取消 |
| `should_hold` | boolean | 是否應暫停等待確認 |
| `should_escalate` | boolean | 是否應轉人工 |
| `confidence` | string | `high` \| `medium` \| `low` |
| `reason` | string | 去識別化短句；不含姓名、電話、完整地址 |
| `next_action` | string | 機器可讀建議；見 §5 |

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

---

## 3. Intent / decision type 語意（Phase 1B 補強）

### 3.1 正式 intent（schema 內）

以下為 v2 明確定義的 intent 語意；對應 Phase 1B Rule ID 見各項說明。

#### `cancel_request`

- **語意：** 客人明確放棄、不叫了、不用了、那算了；或確認取消；或已在別處叫到車而取消本單。
- **AI 應做：** `action=cancel_candidate`；`should_cancel=true`；`should_dispatch=false`。
- **AI 不應做：** `createOrder`；把取消當新單；在尋車中忽略取消繼續派。
- **Phase 1B：** P1B-001（等待過長→放棄）、P1B-002（別處叫到車）、P1B-003（尋車中取消）。
- **典型 next_action：** `confirm_cancel`、`apologize_and_close`。

#### `status_inquiry`

- **語意：** 追問既有單狀態（車到了嗎、還要多久）；或弱位置更新（僅便利商店等地標，非完整新叫車）。
- **AI 應做：** `action=status_reply`；`should_hold=true`；協調/轉述，不開新 draft。
- **AI 不應做：** 無上下文 `createOrder`；把弱地標當全新上下車重派。
- **Phase 1B：** P1B-005（司機 ETA/狀態）、P1B-010（弱位置更新，evidence 弱）。
- **典型 next_action：** `reply_status_only`、`wait_driver_update`。

#### `quote_request`

- **語意：** 純估價、問多少錢、公式/定額詢問；未必立即叫車。
- **AI 應做：** `action=quote_only`；`should_quote_only=true`；`should_dispatch=false`。
- **AI 不應做：** `createOrder`；把問價當派車。
- **Phase 1B：** P1B-001 前半（等待條件轉述前）；P1B-008 邊界（非標準里程詢價）。
- **典型 next_action：** `quote_only`、`set_pending_quote`。

#### `dispatch_request`

- **語意：** 客人要安排用車、補齊叫車需求；或結構化表單已齊可進候選。
- **AI 應做：** 欄位齊 → `dispatch_candidate` + `should_dispatch=true`（仍須 server gate）；缺欄 → `ask_followup` + `missing`。
- **AI 不應做：** 缺欄仍 `dispatch_candidate`；提前宣告已派車完成。
- **Phase 1B：** P1B-004（受理後先稍等）、P1B-007（表單缺欄時為 ask_followup 路徑）。
- **典型 next_action：** `ask_missing_info`、`dispatch_when_ready`、`wait_driver_update`。

#### `modify_order`

- **語意：** 媒合前後修改同一筆需求的時間、地點或表單內容。
- **AI 應做：** `hold_for_confirmation` 或 `ask_followup`；確認新行程後再候選。
- **AI 不應做：** 與舊單並行 silent dispatch。
- **Phase 1B：** P1B-007 邊界（改表單）；evidence 弱，映射時宜 `confidence=medium`。
- **典型 next_action：** `ask_missing_info`、`hold_for_confirmation`（語意）。

#### `special_request`

- **語意：** 寵物、大車、代購/代買、跑腿、搬家、跳表計費說明等非標準一般叫車。
- **AI 應做：** `hold_for_confirmation` 或 `escalate_to_human`；`should_hold=true`；爭議時 `should_escalate=true`。
- **AI 不應做：** 一般 `dispatch_candidate`；自動裁決費用爭議。
- **Phase 1B：** P1B-006（跳表/等待計費**說明**）、P1B-008（代購/代買）。
- **典型 next_action：** `escalate_to_human`、`do_not_dispatch`。

#### `need_more_info`（語意映射，非獨立 intent 值）

- **語意：** 地址/時間/意圖不清，需一問一答補齊。
- **映射方式：** 使用 `dispatch_request` 或 `unknown` + `action=ask_followup` + 現有 `missing` 欄位。
- **Phase 1B：** P1B-007。
- **典型 next_action：** `ask_missing_info`。
- **v2 結論：** **不新增**獨立 intent 值；以 `ask_followup` + `missing` 承接。

#### `manual_review` / `escalate`（語意映射，非獨立 intent 值）

- **語意：** 需人工判斷、拒絕或特殊確認；AI 僅 mark escalate。
- **映射方式：** `special_request` + `should_escalate=true` + `action=escalate_to_human`。
- **Phase 1B：** P1B-008（代購/代買）；P1B-006 爭議時。
- **典型 next_action：** `escalate_to_human`。
- **v2 結論：** **不新增** `manual_review` intent；用 `should_escalate` + `action` 承接。

### 3.2 語意補強（暫不正式進 schema intent 枚舉）

以下語意可在 `reason` / `next_action` 文字中表達；**v2 不要求新增 intent 欄位值**。

| 語意 | 說明 | 建議映射 | Phase 1B |
|------|------|----------|----------|
| `wait_driver_update` | 已受理、等司機指派或回報 | `dispatch_request` + `should_hold=true` + `next_action=wait_driver_update` | P1B-004 |
| `customer_changed_request` | 客人改時間/地點/表單 | `modify_order` + `hold_for_confirmation` | P1B-007 |
| `quote_abandoned` | 問價或等待後客人放棄 | 前一則 `quote_request` → 下一則 `cancel_request` | P1B-001 |
| `weak_location_update` | 弱地標、非完整新單 | `status_inquiry` + `status_reply` + `should_hold=true` | P1B-010 |

### 3.3 不建議現在進 schema 的分類

- 話術細分（確認型 / 安撫型 / 致歉型 / 通知型）— 屬 `reply` 模板層。
- 只靠關鍵字的分類 — 違反 `AI_DISPATCHER_ROLE.md`。
- `driver_not_found_guest` — Phase 1B 0/6 evidence。
- 雙平台 / 多車並行細分 intent — 未充分驗證。
- 跳表爭議自動裁決 — 應 human review。
- 行銷尾模板 — 映射 `chitchat` / `ignore`。

---

## 4. Execution safety rules

以下規則在 schema 設計中視為**鐵律**（未來 server 實作時仍須遵守）：

### 4.1 AI decision 目前角色（Phase 0～1）

| 原則 | 說明 |
|------|------|
| **只供 log / 設計參考** | Phase 1 目標是 ai_v7 輸出 decision JSON，server **只記錄**，不執行 |
| **不直接控制派車** | server 分支仍由現行 gate + `driverReady` + Maps 主導 |
| **不取代 server hard gate** | cancel / quote / special / status inquiry gate **保留** |
| **不可直接 createOrder** | 無論 `should_dispatch` 為何，AI 不可單方面建令 server 建單 |
| **不可直接 pushDispatchCardOnce** | 通知司機群永遠由 server 執行層決定 |

### 4.2 意圖層鐵律

- **`should_dispatch=true` 也不能直接派車** — server 必須再檢查 pickup / dropoff / time / Maps / active order / 現行 gate。
- **`quote_request` / `should_quote_only=true` 不可 `createOrder`** — 須進 quote 流程或 pending。
- **`cancel_request` / `should_cancel=true` 必須過 cancel 安全** — 與現行 cancel gate 對齊或雙重確認。
- **`status_inquiry` 不可 `createOrder`** — 僅 status 回覆或查狀態。
- **`special_request` 必須先 `hold_for_confirmation`** — 不可 silent dispatch。
- **`confidence: low` 必須追問或人工介入** — 不可在高不確定下派車。

---

## 5. `next_action` 範例（v2 補強）

`next_action` 為**建議字串**（log 對照用）；server Phase 1 **不盲從**。v2 整理常用語意如下。

| next_action | 語意 | 典型 intent / action | Phase 1B |
|-------------|------|----------------------|----------|
| `ask_missing_info` | 追問缺欄（日期/時間/上下車等） | `dispatch_request` + `ask_followup` | P1B-007 |
| `wait_driver_update` | 已受理，等司機指派或回報 | `dispatch_request` + `should_hold=true` | P1B-004 |
| `confirm_cancel` | 確認取消後結束 | `cancel_request` + `cancel_candidate` | P1B-001/002/003 |
| `apologize_and_close` | 致歉並明確告知已取消/結束 | `cancel_request` 或 `status_reply` | P1B-009 |
| `escalate_to_human` | 轉人工（代購/爭議/高風險） | `special_request` + `escalate_to_human` | P1B-006/008 |
| `do_not_dispatch` | 明確不進派車（非標準服務等） | `special_request` | P1B-008 |
| `quote_only` | 僅報價路徑 | `quote_request` + `quote_only` | P1B-001 前半 |
| `dispatch_when_ready` | 欄位與 gate 齊全後才候選派車 | `dispatch_request` + `dispatch_candidate` | P1B-007 欄位齊後 |

**既有 v1 範例（仍有效）：**

| next_action | 語意 |
|-------------|------|
| `reply_status_only` | 僅回狀態，不建新單 |
| `set_pending_quote` | 進 pending quote |
| `verify_maps_then_dispatch_candidate` | Maps 驗證通過後才候選 |
| `confirm_cancel_then_close` | 確認取消並關閉（同 `confirm_cancel` 語意族） |
| `wait_driver_assignment` | 同 `wait_driver_update` 語意族 |
| `escalate_non_standard_service` | 同 `escalate_to_human` 語意族 |

**v2 結論：** 不強制 server 枚舉全部字串；Phase 1 log-only 時以 **intent + action + should_* + next_action 文字** 對照即可。

---

## 6. Example decisions（Phase 1B 對齊）

（去識別化範例，非客戶原文）

| 情境 | intent | action | should_dispatch | should_cancel | should_hold | next_action | P1B |
|------|--------|--------|-----------------|---------------|-------------|-------------|-----|
| 客人提供完整上下車，明確要車 | `dispatch_request` | `dispatch_candidate` | true | false | false | `dispatch_when_ready` | — |
| 客人問「A 到 B 多少錢」 | `quote_request` | `quote_only` | false | false | false | `quote_only` | P1B-001 |
| 等待過長後客人說「那算了」 | `cancel_request` | `cancel_candidate` | false | true | false | `confirm_cancel` | P1B-001 |
| 客人已在別處叫到車 | `cancel_request` | `cancel_candidate` | false | true | false | `apologize_and_close` | P1B-002 |
| 尋車中客人說取消 | `cancel_request` | `cancel_candidate` | false | true | false | `confirm_cancel` | P1B-003 |
| 受理後先回稍等/尋車中 | `dispatch_request` | `ask_followup` | false | false | true | `wait_driver_update` | P1B-004 |
| 客人問車到了嗎（有 active order） | `status_inquiry` | `status_reply` | false | false | true | `reply_status_only` | P1B-005 |
| 跳表/等待計費規則詢問 | `special_request` | `hold_for_confirmation` | false | false | true | `do_not_dispatch` | P1B-006 |
| 結構化表單缺日期/時間 | `dispatch_request` | `ask_followup` | false | false | true | `ask_missing_info` | P1B-007 |
| 代購/代買/非標準服務 | `special_request` | `escalate_to_human` | false | false | true | `escalate_to_human` | P1B-008 |
| 弱地標更新（非完整新單） | `status_inquiry` | `status_reply` | false | false | true | `reply_status_only` | P1B-010 |
| 客人閒聊、感謝 | `chitchat` | `ignore` | false | false | false | — | — |

---

## 7. Hard gate / AI judgment / human review 分界摘要

| 類型 | 應放在哪裡 | 理由 | 現在改程式？ |
|------|------------|------|--------------|
| 問價不可 createOrder | **server hard gate** | 現行 quote gate | **否** |
| 取消須 cancel gate | **server hard gate** | 防誤取消/誤派 | **否** |
| Maps / 地址 / active order | **server hard gate** | 執行層硬條件 | **否** |
| pending quote 鎖 | **server hard gate** | 問價路徑安全 | **否** |
| special / status inquiry gate | **server hard gate** | 現行保險 | **否** |
| driverReady / createOrder / pushDispatchCardOnce | **server 執行** | 永遠 server | **否** |
| 本則主 intent 分類 | **AI judgment** | Phase 1B 核心 | **否**（Phase 1 僅 log） |
| should_* 旗標 | **AI judgment** | 建議層 | **否** |
| missing 欄位 | **AI judgment**（沿用 ai_v7） | P1B-007 | **否** |
| 非標準代購/代買 | **human review**（AI mark escalate） | P1B-008 高風險 | **否** |
| 跳表/費用爭議 | **human review** | 說明≠裁決 | **否** |
| 特殊備註（拍照/物品） | **human review** | P1B-007/008 邊界 | **否** |
| AI confidence low / 意圖衝突 | **human review** | 取消+新地址同句 | **否** |
| 致歉/通知模板 | **AI judgment + reply 模板** | 非 gate | **否** |

詳細 Rule ID 對照見 `AI_DECISION_PHASE1B_MAPPING.md` §5。

---

## 8. Relationship to current gates

| 現行 gate | 本階段策略 |
|-----------|------------|
| **cancel gate** | **保留**；AI 輸出 `cancel_candidate` 時可 log 對照 |
| **quote gate** | **保留**；AI 輸出 `quote_only` 時可 log 對照 |
| **special lock** | **保留**；與 `hold_for_confirmation` 對齊 |
| **status inquiry gate** | **保留**；與 `status_reply` 對齊 |
| **driverReady / Maps** | **保留**；decision 僅為建議，不取代硬條件 |

- AI decision **目前只 log，不直接控制派車**。
- 等 log 對照穩定、審查通過後，再評估是否縮小部分 regex gate（改為 AI 建議 + gate 確認）。

---

## 9. Migration plan

| Phase | 內容 | 改程式？ |
|-------|------|----------|
| **Phase 0** | 文件定義（`AI_DISPATCHER_ROLE.md`、本檔 v1→v2） | 否 |
| **Phase 1** | `ai_v7.js` 增加 `decision` 欄位輸出；`server.js` **只記錄 / log，不執行** | 是（待 GPT 任務包） |
| **Phase 2** | 比較 AI decision 與現行 gate / `driverReady` 結果；產對照報告 | 否（或僅 log） |
| **Phase 3** | 只讓**低風險** decision 參與輔助判斷 | 是（待審查） |
| **Phase 4** | **仍保留** server safety hard gates | 持續 |

**Phase 0 狀態：** v2 草案已完成（Phase 1B aligned）；**Phase 1 尚未開始**。

---

## 10. Related files

| 檔案 | 角色 |
|------|------|
| `AI_DECISION_PHASE1B_MAPPING.md` | Phase 1B ↔ schema 對照 |
| `TRAINING_RULE_EXTRACTION_PHASE1B_FROM_DEIDENTIFIED.md` | Phase 1B 規則來源 |
| `AI_DISPATCHER_ROLE.md` | AI / server / gate 分工 |
| `TRAINING_DATA_PRIVACY_PLAN.md` | 隱私政策 |
| `PROJECT_STATE.md` | 專案狀態與訓練主線 |

---

## 11. Document status

- **Version:** draft v2 (Phase 1B aligned)
- **Scope:** document-only
- **Program changes:** none authorized by this file
- **Privacy:** 不含客戶原文與個資
- **Pending:** Phase 1 ai_v7 prompt / decision JSON log-only 任務包
