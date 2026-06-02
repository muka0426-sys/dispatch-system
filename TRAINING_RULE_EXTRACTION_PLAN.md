# Training Rule Extraction Plan

## 0. How to use this file

- 本檔是訓練資料規則萃取的計畫檔。
- 本檔不是萃取結果。
- 本檔不包含客戶原文。
- 本檔不能直接拿來修改 `server.js`。
- 若本檔與 `TRAINING_DATA_STATUS.md` 或 manifest 衝突，以 manifest / 實際檔案為準。
- 不確定就停，不要腦補。

## 1. Scope and non-goals

本計畫只做**規則萃取的流程與安全邊界定義**，不包含實際萃取產出。

- 只做規則萃取計畫。
- 不做模型訓練。
- 不接 LINE webhook。
- 不接 `server.js`。
- 不讀全量 `line_text_capture_test/`。
- 不使用 `99_亂碼_不可用`。
- 不把規則直接覆蓋現有程式。
- 後續萃取結果必須先經 GPT 審查，再由 Cursor 任務包進行最小實作。

## 2. Allowed data sources

| 路徑 | 用途 |
|------|------|
| `hermes_candidate_usable_data/` | **唯一讀取入口**；36 筆候選可用資料（每筆通常含 `customer_info.txt` + `final_chat.txt`） |
| `hermes_training_pack_20260523_040314/hermes_training_manifest.csv` | 判斷 `Category` / `ChatType` / `LooksGarbled` 等 |
| `data_quality_manifest.csv` | 判斷 `CandidateUsable` / `LooksGarbled` / `HasFinal` 等 |
| `TRAINING_DATA_STATUS.md` | 資料狀態主檔；可用 / 禁止 / 個資規則 |

**重要：** 不要同時從 `hermes_candidate_usable_data/` 與 Hermes pack 內 `01_可用_*` / `02_沒標記_*` 讀取**同一 folder name**。candidate 與 pack 可能是同一批資料的副本；重複讀取會造成樣本與工時重複計算。

## 3. Forbidden data sources

預設禁止用於規則萃取：

- `99_亂碼_不可用`（Category）
- `LooksGarbled = True`（manifest 欄位）
- `skipped_other`（Category）
- `skipped_group`（Category）
- `line_text_capture_test/_duplicate_chatid_quarantine/`
- `line_text_capture_test/` **全量未篩選資料**
- `captured_customers.json` 的 key（可能含個資）
- `captured_chatids.json` 的 key（可能含 LINE userId）
- `line_snapshot.txt`
- `raw_openclaw_output.txt`
- 任何未去識別化客戶原文

## 4. Phased rollout

### Phase 1a — High confidence direct set

- **Source:** `hermes_candidate_usable_data/`，依 manifest `Category = 01_可用_有標記中文_direct` 篩選
- **Count:** 6
- **Purpose:** 先萃取 P0 規則候選
- **Output:** 去識別化規則摘要，不含原文

### Phase 1b — Unknown Chinese set

- **Source:** `hermes_candidate_usable_data/`，依 manifest `Category = 02_沒標記但是中文_unknown` 篩選
- **Count:** 30
- **Requirement:** 人工 spot-check 後才可用
- **Output:** 只能標為**待確認規則**，不可直接進程式

### Later phases

- 只有在 Phase 1a / 1b 規則穩定、且 GPT 審查通過後，才考慮補資料品質掃描或新索引（例如 `training_index.json`）。
- 未核准前，不擴大至全量 lobster 庫或其他未分類來源。

## 5. Rule taxonomy

| 優先級 | 規則類型 | 目標 | 對應現有程式模組 | 是否可直接進程式 |
|--------|----------|------|------------------|------------------|
| **P0** | 系統不應自動派車的情境 | 區分問價、閒聊、資訊不足等不應觸發派車的輸入 | `server.js`（fare quote gate、主線派車前判斷） | **否** — 需 GPT 審查 |
| **P0** | 問價 / 報價 / 機場定額 | 整理純問價、里程估價、機場定額相關觸發與反例 | `server.js`（`detectPureQuoteIntent`、`pending_quote_confirmation`）；`utils/ai_v7.js`（估價、機場定額） | **否** — 需 GPT 審查 |
| **P0** | 取消 / 不坐 / 不叫了 | 區分執行取消 vs 詢問取消；整理取消邊界句 | `server.js`（cancel gate V3.6） | **否** — 需 GPT 審查 |
| **P0** | 特殊需求：寵物、大車、代買、跑腿、行李多 | 整理觸發詞、確認流程、反例 | `server.js`（`detectSpecialServiceRequest`、`pending_special_request`）；`utils/ai_v7.js`（加價規則） | **否** — 需 GPT 審查 |
| **P1** | 客人叫車意圖 | 區分叫車 vs 閒聊 vs 司機報班等非乘客叫車 | `utils/ai_v7.js`（`parseOrderFromText`、司機黑話規則） | **否** — 需 GPT 審查 |
| **P1** | 上車 / 下車地點補資料 | 缺欄位、多輪補地址、模糊地點模式 | `utils/ai_v7.js`（解析 draft）；`rules/dispatch_rules_v1.js`（`REQUIRED_ORDER_FIELDS`） | **否** — 需 GPT 審查 |
| **P1** | 需要人工處理的情境 | 對齊需轉真人或暫停自動派車的條件 | `rules/dispatch_rules_v1.js`（`MANUAL_REVIEW_REASONS`）；`server.js`（部分 gate） | **否** — 需 GPT 審查 |
| **P2** | 改時間 / 改地點 | 媒合前後變更意圖與系統應有行為 | `server.js`；`rules/dispatch_rules_v1.js`（`ORDER_AFTER_MATCHED_CHANGED`） | **否** — 需 GPT 審查 |
| **P2** | 司機回報：到、上、車卡 | 司機端訊息 vs 客人叫車的區分 | `utils/ai_v7.js`（司機 ETA 黑話規則） | **否** — 需 GPT 審查 |
| **P3** | 客服真人話術風格 | 整理 reply 風格候選（非邏輯 gate） | `utils/ai_v7.js`（reply 生成）；`server.js`（固定回覆模板） | **否** — 需 GPT 審查 |

**一律：** 所有分類萃取結果皆不可直接進程式；須 GPT 審查後另開 Cursor 任務包。

## 6. Extraction output template

未來每條萃取規則應使用以下欄位（**不含客戶原文**）：

| 欄位 | 說明 |
|------|------|
| **Rule ID** | 唯一識別，例如 `P0-QUOTE-001` |
| **Source phase** | `1a` / `1b` |
| **Data category** | manifest `Category`（例如 `01_可用_有標記中文_direct`） |
| **Trigger pattern** | 抽象觸發模式（去識別化描述或關鍵詞類別，非原文句） |
| **System should do** | 系統應採取的行為 |
| **System should not do** | 系統不應採取的行為 |
| **Counterexamples** | 反例或易混淆情境（去識別化） |
| **Confidence** | `high` / `medium` / `low` |
| **Sample count** | 支持此規則的樣本筆數（數字即可，不列 folder 內個資） |
| **Privacy check passed** | `yes` / `no` |
| **Human review status** | `pending` / `approved` / `rejected` |
| **Related current code** | `server.js` / `utils/ai_v7.js` / `rules/dispatch_rules_v1.js` / `unknown` |
| **Can enter implementation** | 固定填 `no until GPT approval`；核准後另開任務才改為可實作 |

## 7. Privacy and safety rules

- 不准貼客戶原文。
- 不准貼電話、地址、姓名、完整 userId、完整 display name key。
- 規則萃取只能寫**抽象模式**。
- 若需要範例，必須去識別化，例如「客人詢問 A 到 B 多少錢」。
- 禁止將訓練資料直接接入主系統。
- 禁止讓 `server.js` 讀取訓練資料資料夾。

## 8. Relationship to existing code

- **`server.js`** 已有 cancel gate、fare quote gate、special request lock 等主線 gate。
- **`utils/ai_v7.js`** 已有 AI 解析、估價、Gemini API 呼叫與 prompt 規則。
- **`rules/dispatch_rules_v1.js`** 是孤立規則模組，**目前未接入** `server.js`。
- 規則萃取結果只能作為**候選**，不可直接覆蓋現有邏輯。
- 若萃取結論與現有程式衝突，必須以實際測試與 GPT / Cursor 審查為準；不得因訓練資料少數樣本即改主線。

## 9. Human review checklist

每批萃取產出或單條規則提交審查前，逐項確認：

- [ ] 是否不含原文
- [ ] 是否不含個資（電話、地址、姓名、完整 userId、display name key）
- [ ] 是否只使用 allowed sources
- [ ] 是否標註 phase（1a / 1b）
- [ ] 是否標註 confidence
- [ ] 是否有 counterexample
- [ ] 是否和現有程式衝突（若衝突，是否已標註）
- [ ] 是否需要人工客服判斷
- [ ] 是否可進 GPT 二審

## 10. Current next step

- 本檔建立後，**不立即萃取**。
- 下一步如要萃取，先由 **GPT 產 Phase 1a 小批去識別化萃取任務包**。
- Cursor **不可**自行讀 36 筆做大量萃取。
- Phase 1a 最多先處理 **6 筆 direct**，且只產出抽象規則候選。
- 任何規則進程式前都必須**另開任務**；本計畫檔不授權改碼。
