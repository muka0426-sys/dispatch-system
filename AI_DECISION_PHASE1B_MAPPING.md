# AI Decision Phase 1B Mapping

## 0. Purpose

- 本檔是 **Phase 1B 規則候選** 與 **`AI_DECISION_SCHEMA_DRAFT.md`** 的 **document-only 對照表**。
- **不**修改 `server.js`、`utils/ai_v7.js` 或任何派車邏輯。
- **不**新增 gate / regex。
- 角色定義見 `AI_DISPATCHER_ROLE.md`；訓練主線見 `PROJECT_STATE.md` §8。

---

## 1. 來源與限制

| 項目 | 說明 |
|------|------|
| **本文件依據** | 僅 `TRAINING_RULE_EXTRACTION_PHASE1B_FROM_DEIDENTIFIED.md` 規則摘要 |
| **資料範圍** | Phase 1B **只看 6 筆 direct**（去識別化 sample，每筆前 50 行視窗） |
| **未納入** | **unknown 30** 筆；**garbled 443** 筆禁止使用 |
| **不是全集** | 6 筆 **不是**完整訓練全集；結論為 **Phase 1B 初步規則候選** |
| **不可直接用於線上** | **不可**直接改 LINE 派車流程、deploy 或 `server.js` 主線 |
| **隱私** | 本檔**不含**客戶原文、姓名、電話、地址、車牌、ChatId、UserId、LINE ID |
| **未讀** | `training_deidentified_output/` 全文（對照時僅引用 Phase 1B 已整理摘要） |

---

## 2. Phase 1B 規則候選列表

| Rule ID | 規則名稱 | 觸發情境 | 派單員判斷 | AI 應做 | AI 不應做 | 風險等級 | 人工覆核 |
|---------|----------|----------|------------|---------|-----------|----------|----------|
| **P1B-001** | 等待過長→客人放棄→確認取消 | 司機回報等待過久；客人表示不搭/那算了 | 轉述等待條件→確認是否取消→結束 | `intent=cancel_request`；`should_cancel=true`；`action=cancel_candidate` | `should_dispatch=true`；createOrder | **中** | 中（若同句含新地址→高） |
| **P1B-002** | 已在別處叫到車→取消本單 | 客人表示已在其他管道叫到車 | 取消本車隊單+致歉；不派第二台 | `cancel_request`；`cancel_candidate`；`should_cancel=true` | 回「已派車」；重開新單 | **高** | 低～中 |
| **P1B-003** | 尋車中客人取消 | 尋車/受理後客人主動說取消 | 取消確認+致歉；不假設仍要車 | `cancel_request`；`cancel_candidate` | 繼續尋車或新派 | **高** | 低 |
| **P1B-004** | 受理後先稍等再派車資訊 | 收到叫車意圖，尚未有司機指派 | 先回稍等/尋車；有司機後再發派車資訊 | `dispatch_request` 或 `wait_driver_update` 語意；`action=ask_followup`/`status_reply`；`should_hold=true` | 提前宣告已派車完成 | **中** | 低 |
| **P1B-005** | 司機 ETA/狀態模板通知 | 司機端有 ETA、已出發、已上車、抵達回報 | 以模板通知客人 ETA 與狀態 | `status_inquiry` 回覆或 `status_reply`；`should_hold=true` | 無狀態下 createOrder | **中** | 低 |
| **P1B-006** | 跳表/等待計費規則說明 | 即時單/預約單等待跳表、每分鐘計費說明 | **說明規則**；爭議時轉人工 | `special_request` 或 `chitchat`+模板；`should_hold=true` | 自動裁決費用爭議 | **中** | **高**（爭議時） |
| **P1B-007** | 結構化表單缺欄 | 叫車表單缺日期/時間/上下車 | 追問或請重填；不進尋車 | `dispatch_request`+`ask_followup`；`missing` 填欄位 | 缺欄仍 `dispatch_candidate` | **中** | 低（純缺欄） |
| **P1B-008** | 非標準代購/代買 | 需求含代購、代買、非標準里程/物品 | 不套用一般派車；人工判斷或拒絕 | `special_request`；`should_escalate=true`；`action=escalate_to_human` 或 `hold_for_confirmation` | 一般 `dispatch_candidate` | **高** | **是** |
| **P1B-009** | 未能即時服務致歉 | 未能叫到車或主動取消後 | 標準致歉+明確已取消 | `cancel_request` 或 `status_reply`；話術模板（非 intent 核心） | 致歉後仍顯示尋車中 | **低** | 低 |
| **P1B-010** | 弱位置更新→狀態協調 | 客人僅給弱地標（如便利商店）無完整新單 | 協助轉達/請稍等；不開新 draft | `status_inquiry`；`status_reply`；`should_hold=true` | 當新 `dispatch_request` 重派 | **中** | 中 |

**Evidence confidence（Phase 1B 原文）：** P1B-001/008 medium；P1B-006/007 medium；P1B-010 low；其餘 high。

---

## 3. 對照 `AI_DECISION_SCHEMA_DRAFT.md`

### 3.1 現有 schema 是否可承接

| Schema 欄位 / 概念 | 是否已有 | Phase 1B 用法 |
|--------------------|----------|---------------|
| `decision.intent` | 草案已有 8 值 | 可承接 cancel / status / quote / dispatch / modify / special |
| `decision.action` | 草案已有 8 值 | 可承接 cancel_candidate、status_reply、ask_followup、hold_for_confirmation、escalate_to_human |
| `should_dispatch` | 草案已有 | P1B-004/007/010 多數為 false 或 hold |
| `should_quote_only` | 草案已有 | P1B-001/008 問價或放棄路徑 |
| `should_cancel` | 草案已有 | P1B-001/002/003 |
| `should_hold` | 草案已有 | P1B-004/005/007/010 |
| `should_escalate` | 草案已有 | P1B-006 爭議、P1B-008 |
| `next_action` | 草案已有（自由字串） | 可擴充語意，見 §3.3 |
| `missing` | **現有 ai_v7 已有**（非 decision 內） | P1B-007 可直接沿用 |
| `confidence` | 草案已有 | P1B-010 建議 low～medium |

### 3.2 Rule ID → intent / action / flags 對照

| Rule ID | 建議 intent | 建議 action | should_dispatch | should_quote_only | should_cancel | should_hold | should_escalate |
|---------|-------------|-------------|-----------------|-------------------|---------------|-------------|-----------------|
| P1B-001 | `cancel_request`（放棄後）或 `quote_request`（前半） | `cancel_candidate` | false | true→false | true | false | false |
| P1B-002 | `cancel_request` | `cancel_candidate` | false | false | true | false | false |
| P1B-003 | `cancel_request` | `cancel_candidate` | false | false | true | false | false |
| P1B-004 | `dispatch_request` | `ask_followup` 或 `status_reply` | false | false | false | true | false |
| P1B-005 | `status_inquiry`（若客人問）或 N/A（若系統推播） | `status_reply` | false | false | false | true | false |
| P1B-006 | `special_request` 或 `chitchat` | `hold_for_confirmation` / `escalate_to_human` | false | false | false | true | 爭議時 true |
| P1B-007 | `dispatch_request` | `ask_followup` | false | false | false | true | false |
| P1B-008 | `special_request` | `escalate_to_human` 或 `hold_for_confirmation` | false | false | false | true | true |
| P1B-009 | （話術層，非主 intent） | `cancel_candidate` 或 `status_reply` | false | false | 視情境 | false | false |
| P1B-010 | `status_inquiry` | `status_reply` | false | false | false | true | false |

**`modify_order` 對照：** P1B-007/010 若判定為「改單」而非新單，可映射 `modify_order` + `hold_for_confirmation`（schema 已有，Phase 1B evidence 弱）。

### 3.3 建議 `next_action` 語意（不強制新增 schema 欄位）

| next_action 語意 | 對應 Rule | 現有 schema 是否需新值 |
|------------------|-----------|------------------------|
| `reply_status_only` | P1B-005, P1B-010 | **否** — 草案範例已提及 |
| `set_pending_quote` | P1B-001 前半 | **否** |
| `verify_maps_then_dispatch_candidate` | P1B-007 欄位齊全後 | **否** |
| `confirm_cancel_then_close` | P1B-001/002/003 | **語意補強** — 可用 `reason` 描述，不必新欄位 |
| `wait_driver_assignment` | P1B-004 | **語意補強** — 見 §4.B |
| `escalate_non_standard_service` | P1B-008 | **語意補強** — 對應 `escalate_to_human` |

### 3.4 是否需要新增 schema 欄位

| 提議 | 結論 |
|------|------|
| 新增 `intent=wait_driver_update` | **不急** — 可用 `dispatch_request` + `should_hold=true` + `next_action` 語意補強 |
| 新增 `quote_abandoned` | **不急** — 映射 `cancel_request` after `quote_request` |
| 新增 `weak_location_update` | **不急** — 映射 `status_inquiry` |
| 新增 `dispatch_ready` intent | **不急** — 映射 `dispatch_request` + `dispatch_candidate` + gates |
| 話術類型欄位（致歉/安撫/通知） | **不建議** — 屬 `reply` 模板層，非 decision 核心 |
| 新增 `sub_intent` / `phase` | **可選 v2** — 僅在 log 對照需要時再議 |

**總結：** Phase 1B **多數可沿用現有 schema**；少數為 **語意補強**（`next_action` / `reason` 文字），**不要求**立即改 `AI_DECISION_SCHEMA_DRAFT.md` 欄位集合。

---

## 4. 建議 decision type 分類

### A. 目前 schema 可能已可承接

| 類型 | 對應 Rule | 說明 |
|------|-----------|------|
| `cancel_request` | P1B-001/002/003 | 與 schema §4 範例「不用了/那算了」一致 |
| `status_inquiry` | P1B-005/010 | 與 schema §4「車到了嗎」一致；P1B-010 evidence 弱 |
| `quote_request` | P1B-001 前半、P1B-008 邊界 | 與 quote gate 方向一致 |
| `dispatch_request` | P1B-004/007 | 含 `ask_followup` / `dispatch_candidate` 路徑 |
| `modify_order` | P1B-007（改表單） | schema 已有；Phase 1B evidence 弱 |
| `special_request` | P1B-006/008 | 與 schema §4 代買/特殊需求一致 |
| `need_more_info`（語意） | P1B-007 | 映射 `ask_followup` + `missing` |
| `manual_review`（語意） | P1B-008 | 映射 `should_escalate=true` |
| `dispatch_ready`（語意） | P1B-007 欄位齊全後 | 映射 `dispatch_candidate` + server gates |

### B. 建議語意補強，但不急著改 schema

| 語意 | 對應 Rule | 建議映射方式 |
|------|-----------|--------------|
| `wait_driver_update` | P1B-004 | `should_hold=true`；`next_action=wait_driver_assignment` |
| `customer_changed_request` | P1B-007 | `modify_order` + `hold_for_confirmation` |
| `quote_abandoned` | P1B-001 | `quote_request` → 下一則 `cancel_request` |
| `weak_location_update` | P1B-010 | `status_inquiry` + `status_reply` |
| `driver_status_notify` | P1B-005 | 系統/客服推播；AI 判斷是否需回覆 vs 純通知 |
| `apology_template` | P1B-009 | **reply 模板**；非獨立 intent |

### C. 不建議現在進 schema

| 類型 | 理由 |
|------|------|
| 話術細分（確認型/安撫型/致歉型/通知型…） | 屬 **reply 生成** 與客服模板，非 decision 分支 |
| 只靠關鍵字的分類 | 違反 `AI_DISPATCHER_ROLE.md`「不是關鍵字機器人」 |
| `driver_not_found_guest` | Phase 1B **0/6** evidence；需 unknown 或更多樣本 |
| 雙平台/多車並行細分 intent | Phase 1B 未充分驗證 |
| 跳表爭議自動裁決 | P1B-006 僅**說明規則**；裁決應 **human review** |
| 行銷尾模板（加好友/乘車金） | 非派車 decision；`chitchat` / `ignore` 即可 |

---

## 5. Hard gate / AI judgment / human review 分界

| 類型 | 應放在哪裡 | 理由 | 是否現在改程式 |
|------|------------|------|----------------|
| 問價不可 createOrder | **server hard gate** | 現行 quote gate；schema §3 鐵律 | **否** |
| 取消須 cancel gate | **server hard gate** | 防誤取消/誤派；P1B-002/003 | **否** |
| Maps / 地址精度 / active order | **server hard gate** | 執行層硬條件；AI 不可取代 | **否** |
| pending quote 鎖 | **server hard gate** | 問價路徑安全 | **否** |
| special / status inquiry gate | **server hard gate** | 現行保險；與 AI 對照 log | **否** |
| 本則主 intent 分類 | **AI judgment** | P1B 核心：cancel vs dispatch vs status vs quote | **否**（Phase 1 僅 log） |
| should_* 旗標建議 | **AI judgment** | 建議層；server 不盲從 | **否** |
| missing 欄位 | **AI judgment**（沿用 ai_v7） | P1B-007 | **否** |
| 非標準代購/代買 | **human review**（AI 可 mark escalate） | P1B-008；高風險 | **否** |
| 跳表/費用爭議 | **human review** | P1B-006 說明≠裁決 | **否** |
| 特殊備註（拍照/物品） | **human review** | P1B-007/008 邊界 | **否** |
| 司機找不到人 | **human review** | Phase 1B 無 evidence | **否** |
| AI confidence low / 意圖衝突 | **human review** | 取消+新地址同時出現 | **否** |
| 致歉/通知模板選擇 | **AI judgment + 模板庫** | P1B-009/005；非 gate | **否** |
| driverReady / createOrder | **server 執行** | 永遠 server；見 `AI_DISPATCHER_ROLE.md` §4 | **否** |

**鐵律（重申）：** `should_dispatch=true` **仍不可**直接派車；`AI_DECISION_SCHEMA_DRAFT.md` §3 與 `AI_DISPATCHER_ROLE.md` §3 一致。

---

## 6. 下一步建議（最小路徑）

1. **人工 / GPT 審本檔** — 確認 Rule ID 與 intent 映射無漏、無 over-fit 6 筆。
2. **若通過** — 再決定是否整理 **`AI_DECISION_SCHEMA_DRAFT.md` v2**（僅補 `next_action` 枚舉說明或範例，不強制新 intent）。
3. **之後** — 另開任務包：`ai_v7.js` prompt + decision JSON **log-only**（Phase 1 migration）。
4. **最後** — 評估 `server.js` 是否需調整 hard gate（**現階段文件結論：保留，不建議改**）。
5. **不納入本階段** — unknown 30、garbled 443、外部 Gemini 批次、commit samples。

---

## 7. Related files

| 檔案 | 角色 |
|------|------|
| `TRAINING_RULE_EXTRACTION_PHASE1B_FROM_DEIDENTIFIED.md` | 規則來源 |
| `AI_DECISION_SCHEMA_DRAFT.md` | Schema 草案 |
| `AI_DISPATCHER_ROLE.md` | AI / server / gate 分工 |
| `TRAINING_DATA_PRIVACY_PLAN.md` | 隱私與禁止事項 |
| `PROJECT_STATE.md` | 專案主入口與訓練主線 |
| `TRAINING_RULE_EXTRACTION_PHASE1A.md` | 早期規則（互補，非本檔重驗） |

---

## 8. Document status

- **Status:** draft — pending GPT review
- **Scope:** document-only mapping
- **Program changes:** none authorized by this file
