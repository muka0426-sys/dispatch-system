# Training Data Privacy Plan

## 0. How to use this file

- 本檔是**去識別化與訓練資料安全**規劃，不是訓練語料、不是程式規格。
- 不含任何客戶原文、姓名、電話、地址、車牌、ChatId、UserId、LINE ID。
- 若與 `TRAINING_DATA_STATUS.md`、`TRAINING_DATA_INVENTORY.md` 衝突，以 manifest 實際欄位與資料夾為準。
- 不確定就停，不要腦補。

## 1. Purpose

- 將 **LINE 官方後台真人派單脈絡**、**龍蝦 / OpenClaw 抓取資料**、（未來可能納入的）**外部 Gemini 輸入批次**，在**去識別化**後，用於：
  - 萃取**真人派單員判斷邏輯**（話術、意圖、何時追問、何時不派車等）。
  - 後續改善 **AI decision** 設計（文件與 schema 對照，**不**直接改 `server.js` 直到另開任務包）。
- **不是**建立可還原的客戶資料庫；**不是**把 repo 變成聊天紀錄倉庫。

## 2. Prohibited actions

- **禁止**將客戶完整聊天原文 commit 進 git。
- **禁止** commit 或貼入對話：姓名、電話、地址、車牌、ChatId、UserId、LINE ID、可還原的顯示名稱 key。
- **禁止**讀全量 `final_chat.txt` / `line_text_capture_test/` 後，把原文直接丟給 AI 分析。
- **禁止**把 `LooksGarbled = True` 或 `99_亂碼_不可用` 當訓練資料。
- **禁止**把 `captured_customers.json` / `captured_chatids.json` 的 **key 原樣**寫入狀態檔或報告。
- **禁止**啟用 `_LOBSTER_ARCHIVE_DO_NOT_USE_20260523`（除非 GPT 另開封存任務）。
- **禁止**把 **36** 筆 CandidateUsable 誤稱為「完整訓練全集」。
- **禁止**在未去識別化前，將訓練流程接入 `server.js` webhook 主線。

## 3. Allowed data sources (for planning / indexing)

| 類型 | 說明 |
|------|------|
| **Manifest metadata** | `data_quality_manifest.csv`、`hermes_training_manifest.csv` 欄位名與統計 |
| **候選資料夾清單** | 僅 `customer_text_YYYYMMDD_HHMMSS` 等命名模式與筆數 |
| **去識別化後短片段** | 用於人工/GPT 審查規則，每段需標 `[姓名]` `[地址]` 等 |
| **去識別化後規則摘要** | 如 Phase 1a 風格，無客戶原文 |
| **文件規劃** | 本檔、`TRAINING_DATA_INVENTORY.md`、`TRAINING_DATA_STATUS.md` |

## 4. De-identification field rules

| 原始類型 | 替換標記 |
|----------|----------|
| 姓名 / 暱稱 | `[姓名]` |
| 電話 | `[電話]` |
| 地址（含門牌、地標可還原組合） | `[地址]` |
| 車牌 | `[車牌]` |
| ChatId / UserId / LINE ID | `[ID]` |
| 可識別個人的精確時間 | 泛化為 `[時間]` 或相對描述（例如「當日稍晚」） |

- 去識別化產物**預設不可** commit；若需版本管理，須 GPT 審查後另訂「可 commit 的規則摘要檔」白名單。
- 抽樣時**一次一資料夾**，禁止批次複製原文到聊天視窗。

## 5. Phase 1 data scope (first batch only)

| 範圍 | 政策 |
|------|------|
| **起點** | 僅 manifest 標記 `CandidateUsable = True` 的 **36** 筆（對應 `hermes_candidate_usable_data/`） |
| **優先** | Hermes `01_可用_有標記中文_direct`（**6** 筆） |
| **需審** | `02_沒標記但是中文_unknown`（**30** 筆）— 人工抽樣確認後才可納入 |
| **禁止** | `99_亂碼_不可用`（**443** 筆）、`LooksGarbled = True`、全量未篩選 `line_text_capture_test/` |
| **全庫** | **506** 筆主資料夾僅作統計與索引，**不是**第一階段讀取範圍 |

## 6. Expected outputs (later phases)

- **不產**完整原文集、**不產**可還原客戶的對話 dump。
- **只產：**
  - 去識別化案例（短片段、結構化欄位）。
  - 真人派單員判斷規則候選（文件層，GPT 審查後才可能進程式任務包）。
  - AI decision 改善建議（對照 `AI_DECISION_SCHEMA_DRAFT.md`，與程式分離）。

## 7. External batch (not in repo)

- 「客群訓練模組：第一批實戰資料分析」：定位為**外部 Gemini 輸入**，**不在 repo**。
- 納入前必須：使用者提供實體位置 → 去識別化 → mapping 到 manifest / 候選來源 → GPT 審查。
- **不可**視為已完成分析或已訓練完成。

## 8. Current next step (privacy track)

1. 讀 `TRAINING_DATA_INVENTORY.md`（索引）。
2. 由 manifest 產出 **36 筆 folder 清單**（僅路徑 + 品質欄位，無原文）。
3. 設計去識別化抽樣流程（**另開任務包**；本階段不寫程式亦可）。
4. 等使用者確認 **Railway SHA** 與外部批次位置。
