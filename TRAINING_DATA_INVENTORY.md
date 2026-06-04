# Training Data Inventory

## 0. How to use this file

- 本檔是**資料來源索引**，不含客戶原文、不含個資 key、不含 ChatId / UserId。
- 統計以 2026-05-23 前後 manifest 盤點為準；若資料夾數量變動，以 `data_quality_manifest.csv` 為準。
- 詳細規則見 `TRAINING_DATA_STATUS.md`；去識別化見 `TRAINING_DATA_PRIVACY_PLAN.md`。
- **36 筆 CandidateUsable 不是完整訓練全集。**

## 1. Summary table

| # | 路徑 | 型態 | 約略筆數 | 中文品質 | 個資風險 | 可用性 | 禁止 / 注意 |
|---|------|------|----------|----------|----------|--------|-------------|
| 1 | `hermes_candidate_usable_data/` | 龍蝦抓取精簡副本 | **36** 資料夾 | manifest：非 LooksGarbled | **高**（含對話檔） | **優先** 去識別化起點 | 不可整包 commit；非全集 |
| 2 | `hermes_training_pack_20260523_040314/01_可用_*` | 分類副本 direct | **6** | 有標記中文 direct | **高** | **最優先** 規則萃取 | 勿當全集 |
| 3 | `hermes_training_pack_20260523_040314/02_*` | 分類副本 unknown | **30** | 中文但需審 | **高** | 需人工抽樣後 | unknown 不可直接當 direct |
| 4 | `hermes_training_pack_20260523_040314/99_*` | 亂碼分類 | **443** | **亂碼** | **高** | **禁止** 訓練 | 不可讀入 AI |
| 5 | `line_text_capture_test/` | 龍蝦全量主庫 | **506** + quarantine **98** | **混合**（443 亂碼） | **極高** | 僅索引 | **不可整包讀** |
| 6 | `data_quality_manifest.csv` | 品質 manifest | **506** 列 | N/A（metadata） | 低 | **必用** 索引 | 非訓練內容 |
| 7 | `hermes_training_pack_.../hermes_training_manifest.csv` | Hermes manifest | **506** 列 | N/A | 低 | **必用** 索引 | 非訓練內容 |
| 8 | `captured_customers.json` | 抓取索引 | 約 **620** 項 | N/A | **極高**（key） | 僅內部對照 | **不可** commit / 不可貼 key |
| 9 | `captured_chatids.json` | ChatId 索引 | 約 **239** 項 | N/A | **極高**（key） | 僅內部對照 | **不可** commit / 不可貼 key |
| 10 | `_LOBSTER_ARCHIVE_DO_NOT_USE_20260523/` | 龍蝦封存 | 見封存 manifest | **無法判斷** | **假設高** | **禁止** 使用 | DO_NOT_USE |
| 11 | `line_customers_capture/` | 早期試抓 | **3** 資料夾 | 不具代表性 | **極高** | 不建議 | 含 UI/截圖痕跡 |
| 12 | `line_snapshot.txt` | OA 後台 UI 擷取 | 1 檔 | 非對話結構 | **極高** | **排除** | 非訓練語料 |
| 13 | 外部「第一批實戰資料分析」 | Gemini 輸入批次 | **不在 repo** | 使用者稱無亂碼（未驗） | **假設極高** | 待路徑對齊 | 不可原文入庫 |
| 14 | repo 內 Gemini **完成分析** prose | 分析結果 | **未找到** | — | — | N/A | README 為指令非結果 |

## 2. Manifest category counts (Hermes pack)

| Category（約） | 筆數 |
|----------------|------|
| 亂碼不可用 | **443** |
| 沒標記中文 unknown | **30** |
| skipped_other | **26** |
| 有標記中文 direct | **6** |
| skipped_group | **1** |

## 3. What this inventory is NOT

- **不是**完整真人派單紀錄全集。
- **不是** LINE 官方後台匯出檔清單（repo 內未見獨立官方匯出 corpus）。
- **不是**可 commit 的訓練集。

## 4. Recommended read order

1. `PROJECT_STATE.md` §8
2. `TRAINING_DATA_PRIVACY_PLAN.md`
3. `TRAINING_DATA_STATUS.md`
4. 本檔
5. manifest CSV（欄位名 only，不貼資料列）

## 5. Current next step

- 確認 Railway running SHA（不假設 rollback）。
- 使用者提供外部「第一批實戰資料分析」實體位置（若要用）。
- 設計去識別化抽樣（另開任務包；**36 筆起點，6 direct 優先**）。
