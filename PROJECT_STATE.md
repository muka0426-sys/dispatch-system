# Dispatch System Project State

## 0. How to use this file

- 新視窗 / 新 AI / Cursor 進入專案時，先讀本檔。
- 本檔是主入口狀態檔。
- 若本檔與實際程式碼、git、部署結果衝突，以實際程式碼、git、部署結果為準。
- 不確定就停止，不要腦補。
- 讀檔順序、舊檔警告、禁止整包讀的資料夾：見下方 **§ Read order / source of truth**。

## Read order / source of truth

### Always read first

1. **`PROJECT_STATE.md`**
   - 專案目前主入口與最高讀檔順序。
   - 新視窗先讀本檔。
2. **若任務涉及訓練資料 / 龍蝦 / Hermes：**
   - 再讀 `TRAINING_DATA_STATUS.md`。
3. **若任務涉及 AI 派車專員架構：**
   - 再讀 `AI_DISPATCHER_ROLE.md`。
   - 再讀 `AI_DECISION_SCHEMA_DRAFT.md`。
4. **若任務涉及 Phase 1a 規則候選：**
   - 再讀 `TRAINING_RULE_EXTRACTION_PHASE1A.md`。
   - 注意：此檔已有 GPT Review Result，但仍是 **document only**，不可直接進 `server.js`。
5. **若任務涉及改程式：**
   - 以實際 `server.js`、`utils/ai_v7.js` 為最高依據。
   - 文件只能解釋意圖，不能取代程式現況。

### Do not use as current truth

| 檔案 | 說明 |
|------|------|
| `project_state.txt` | 舊狀態檔，內容可能描述舊架構，**不可當現況**。 |
| `AI_PROJECT_MEMORY.md` | 舊協作記憶，可能與 `PROJECT_STATE.md` 分叉，**不可優先於** `PROJECT_STATE.md`。 |
| `CORE_CODE_SNAPSHOT_FOR_GPT.txt` | 舊程式快照，**不可當現行** `server.js`。 |
| `PROJECT_READONLY_SNAPSHOT_FOR_GPT.txt` | 舊目錄快照，**不可當最新檔案狀態**。 |
| `GPT_REVIEW_cancel_gate_v3_4_diff.txt` | 單次歷史審查，**不是總規格**。 |
| `AGENTS.md` / `SOUL.md` / `IDENTITY.md` / `USER.md` / `TOOLS.md` | OpenClaw / Agent 通用模板，**不是派車業務主規格**。 |

### Do not read or add directly

| 路徑 / 檔案 | 說明 |
|-------------|------|
| `line_text_capture_test/` | 全量原始抓取庫，含客戶對話，**不可整包讀**。 |
| `captured_customers.json` / `captured_chatids.json` | 可能含個資 key，**不可貼出或直接 git add**。 |
| `hermes_training_pack_20260523_040314/` | 需依 `TRAINING_DATA_STATUS.md` 規則讀，**不可整包讀**。 |
| `hermes_candidate_usable_data/` | 只在訓練任務且 GPT 核准時讀。 |
| `*bak*`、`stable_*`、`backup_*` | 備份 / 穩定快照，**不是現況規格**。 |
| `_LOBSTER_ARCHIVE_DO_NOT_USE_20260523/` | 封存，**不可使用**。 |
| `.openclaw/` | OpenClaw 狀態，**不是派車主規格**。 |

### Current architecture note

- 現況**不是**純關鍵字機器人，也**還不是**完整 AI 派車專員。
- 現況是：**AI 解析 / 回覆** + **`server.js` gate** + **`driverReady`** + **Maps hard check**。
- 目標架構是：**AI 派車專員 decision** → **server 安全驗證** → **server 執行**（見 `AI_DISPATCHER_ROLE.md`、`AI_DECISION_SCHEMA_DRAFT.md`）。
- **gate 是安全保險，不是主要派車邏輯。**
- 未來若要進 AI dispatcher Phase 1，必須另開任務：先讓 `ai_v7.js` 輸出 decision，但 **server 只 log、不執行**。

### Phase 1a status correction

- `TRAINING_RULE_EXTRACTION_PHASE1A.md` **已有 GPT Review Result**。
- Phase 1a 規則仍是 **document only**。
- **不可**把 Phase 1a 規則直接寫進 prompt 或 `server.js`。
- 若要進程式，必須：**單一規則、單一任務、Cursor 第一審、GPT 第二審、最小測試**。

## 1. Workflow rules

- GPT 整理需求。
- Cursor 根據實際專案檔案做第一輪審查，不改檔。
- Cursor 可提出更小、更安全的改法，也可質疑 GPT 草稿。
- GPT 根據 Cursor 回報做第二輪審查。
- GPT 產正式 Cursor 任務包。
- Cursor 才改檔 + 測試 + 自我檢查。
- GPT 最後驗收。
- Gemini 暫停使用；除非同一問題錯誤 3 次以上，或使用者明確要求，才引入 Gemini。
- 最高依據：實際程式碼、實際檔案、實際測試結果。
- 不確定就停。

## 2. Hard rules

- 不准重寫主線。
- 不准擴大任務。
- 不准跳過備份。
- 不准跳過最小測試。
- 不准直接部署。
- 不准假設部署成功。
- 不准把推論當事實。
- 不准碰 `.env` / token / key。
- 不准把客戶個資或原始敏感對話貼進狀態檔。

## 3. Current code milestones

### Cancel gate V3.6

- commit: `008e0f2`
- purpose: 客人端 1 對 1 明確取消時，在 AI 解析前攔截，不污染 conversation history。

### Special request Context-Lock V1.1

- commit: `5452da1`
- purpose: 特殊需求如寵物、大車、代買、跑腿等，先鎖定 `pending_special_request`，確認後才續派。

### Fare quote gate V1

- commit: `8e16fdb`
- purpose: 純問價 / 多少錢 / 機場定額時，不直接派車，進入 `pending_quote_confirmation`。

### Fare quote gate V1.1 price display

- commit: `076a2f2`
- status: **completed locally, not pushed yet**
- purpose: 問價回覆優先顯示 `ai.price` 或 Google Maps 最短路線估價，避免只顯示公式。
- note: server.js no longer modified after commit `076a2f2`.

### Fare formula ceil-km fix

- commit: `8221c73`
- status: **completed locally, not pushed yet**
- rule: `fare = max(130, 50 + 20 * Math.ceil(km))`
- examples:
  - 3.4 km → 130
  - 5.2 km → 170
  - 6.0 km → 170
  - 6.1 km → 190

## 3.5 Architecture / AI (document only)

- **AI dispatcher role definition：** `AI_DISPATCHER_ROLE.md`
- **AI decision schema draft：** `AI_DECISION_SCHEMA_DRAFT.md`
- **狀態：** document only；**尚未改** `utils/ai_v7.js`；**尚未接入** `server.js`

## 4. Current deployment notes

- `origin/main` 已曾指向 `8e16fdb`。
- Railway 曾經跑到舊 commit `cca6e97`，後來用空 commit 觸發 redeploy。（需以 Railway Deployments / Logs 驗證）
- Railway 最新 boot log 曾顯示 `railwayGitSha: 0fd248d3649e3610940e35387c29dc8231d9edc7`。（需以最新 logs / deployment 頁面確認實際 running SHA）
- origin/main 尚未包含 `076a2f2`。
- 本地 main ahead of origin/main by 1 commit。
- Railway 是否已部署 `076a2f2`：not verified。
- origin/main 尚未包含 `8221c73`。
- Railway 尚未部署 `8221c73`。
- 不要假設部署成功；每次測試前確認 Railway running SHA。

## 5. Latest important test observations

- 問價誤派車大洞已由 fare_quote_gate V1 修正方向處理（問價不再直接派車）。
- 線上測試「你幫我算 林森北路409號到三重三和夜市多少錢？」已不再回「已為您派車」。
- V1.1 已在本地修正報價顯示來源，但尚未 push / 尚未線上驗證。
- 但最新公式修正 `8221c73` 尚未 push / 尚未線上驗證。
- 待驗證重點：問價「你幫我算 林森北路409號到三重三和夜市多少錢？」應顯示 130，不應顯示 118。
- 需要驗證的句子：
  1. 你幫我算 林森北路409號到三重三和夜市多少錢？
  2. 林森北路409號到三重三和夜市多少錢？
  3. 汐止到桃園機場多少？
  4. 幫我叫
  5. OK
  6. 取消

## 6. Data / training / Lobster / Hermes status

只寫可確認事實，不要腦補：

- **訓練資料主狀態檔：** `TRAINING_DATA_STATUS.md`
- **最新可用資料入口：** `hermes_candidate_usable_data/`
- **Hermes manifest：** `hermes_training_pack_20260523_040314/hermes_training_manifest.csv`
- **品質 manifest：** `data_quality_manifest.csv`
- **詳細訓練資料狀態以 `TRAINING_DATA_STATUS.md` 為準**（含可用 / 禁止 / 個資規則與統計）
- **Gemini / Hermes 規則萃取輸出：** repo 內尚未找到；詳見 `TRAINING_DATA_STATUS.md`（Gemini / Hermes analysis outputs）
- **訓練規則萃取計畫：** `TRAINING_RULE_EXTRACTION_PLAN.md` — 狀態：**planning only**；尚未開始萃取。
- **Phase 1a 規則萃取：** `TRAINING_RULE_EXTRACTION_PHASE1A.md` — **已有 GPT Review Result**；**document only**；**尚未進程式**（詳見 § Read order / source of truth → Phase 1a status correction）。
- **外部 Gemini 原始輸入批次：** 已知存在一份「客群訓練模組：第一批實戰資料分析」；使用者回報完整且無亂碼；目前**未入庫、未去識別化**、**不可視為完成分析結果**；詳見 `TRAINING_DATA_STATUS.md`（External Gemini input batches）。
- `LOBSTER_ARCHIVE_MANIFEST_20260523.txt` exists.
- `RESTORE_LOBSTER_ARCHIVE_20260523.ps1` exists.
- `.openclaw/workspace-state.json` exists.
- 龍蝦 / OpenClaw 曾用來抓 LINE 客戶對話紀錄；這些資料是未來訓練 / 規則萃取的重要來源。
- 需要注意亂碼資料不可直接作為訓練資料（manifest 約 443 筆 `LooksGarbled`；見 `TRAINING_DATA_STATUS.md`）。

## 7. Important existing reference files

以下是參考檔，**不是主入口**。主入口是 `PROJECT_STATE.md`。舊檔 / 禁止整包讀清單見 **§ Read order / source of truth**。

- `LOBSTER_ARCHIVE_MANIFEST_20260523.txt`：lobster archive manifest
- `hermes_training_pack_20260523_040314/hermes_training_manifest.csv`：training data manifest
- `TRAINING_RULE_EXTRACTION_PLAN.md`：規則萃取計畫（planning only）

## 8. Current next step

- 先驗收 `PROJECT_STATE.md`。
- 再 commit `PROJECT_STATE.md`。
- 再 push main。
- 再確認 Railway running SHA。
- 最後只測一題問價。

