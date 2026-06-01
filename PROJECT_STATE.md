# Dispatch System Project State

## 0. How to use this file

- 新視窗 / 新 AI / Cursor 進入專案時，先讀本檔。
- 本檔是主入口狀態檔。
- 若本檔與實際程式碼、git、部署結果衝突，以實際程式碼、git、部署結果為準。
- 不確定就停止，不要腦補。

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

## 4. Current deployment notes

- `origin/main` 已曾指向 `8e16fdb`。
- Railway 曾經跑到舊 commit `cca6e97`，後來用空 commit 觸發 redeploy。（需以 Railway Deployments / Logs 驗證）
- Railway 最新 boot log 曾顯示 `railwayGitSha: 0fd248d3649e3610940e35387c29dc8231d9edc7`。（需以最新 logs / deployment 頁面確認實際 running SHA）
- origin/main 尚未包含 `076a2f2`。
- 本地 main ahead of origin/main by 1 commit。
- Railway 是否已部署 `076a2f2`：not verified。
- 不要假設部署成功；每次測試前確認 Railway running SHA。

## 5. Latest important test observations

- 問價誤派車大洞已由 fare_quote_gate V1 修正方向處理（問價不再直接派車）。
- 線上測試「你幫我算 林森北路409號到三重三和夜市多少錢？」已不再回「已為您派車」。
- V1.1 已在本地修正報價顯示來源，但尚未 push / 尚未線上驗證。
- 需要驗證的句子：
  1. 你幫我算 林森北路409號到三重三和夜市多少錢？
  2. 林森北路409號到三重三和夜市多少錢？
  3. 汐止到桃園機場多少？
  4. 幫我叫
  5. OK
  6. 取消

## 6. Data / training / Lobster / Hermes status

只寫可確認事實，不要腦補：

- `LOBSTER_ARCHIVE_MANIFEST_20260523.txt` exists.
- `RESTORE_LOBSTER_ARCHIVE_20260523.ps1` exists.
- `hermes_training_pack_20260523_040314/hermes_training_manifest.csv` exists.
- `.openclaw/workspace-state.json` exists.
- 龍蝦 / OpenClaw 曾用來抓 LINE 客戶對話紀錄；這些資料是未來訓練 / 規則萃取的重要來源。
- 需要注意亂碼資料不可直接作為訓練資料。
- 目前可用/不可用比例：**needs verification**（可從 `hermes_training_manifest.csv` 欄位如 `LooksGarbled`, `HasFinal`, `ChineseChars` 做摘要）。

## 7. Important existing reference files

以下是參考檔，不是主入口。主入口是 `PROJECT_STATE.md`。

- `project_state.txt`：legacy / older project state candidate
- `AI_PROJECT_MEMORY.md`：legacy memory / collaboration rules
- `CORE_CODE_SNAPSHOT_FOR_GPT.txt`：core code snapshot
- `PROJECT_READONLY_SNAPSHOT_FOR_GPT.txt`：readonly project snapshot
- `LOBSTER_ARCHIVE_MANIFEST_20260523.txt`：lobster archive manifest
- `hermes_training_pack_20260523_040314/hermes_training_manifest.csv`：training data manifest

## 8. Current next step

- 先驗收 `PROJECT_STATE.md`。
- 再決定是否 commit `PROJECT_STATE.md`。
- 再決定是否 push main 觸發部署測試 `076a2f2`。
- 不開新功能。

