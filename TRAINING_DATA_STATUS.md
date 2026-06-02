# Training Data Status

## 0. How to use this file

- 本檔是訓練資料 / 龍蝦資料 / Hermes pack 的主入口。
- 新視窗或新 AI 需要理解訓練資料狀態時，先讀本檔。
- 本檔只記錄索引、統計、規則，不保存客戶原文。
- 若本檔與 manifest 或實際資料夾衝突，以 manifest / 實際檔案為準。
- 不確定就停，不要腦補。

## 1. Canonical data sources

| 路徑 | 角色 |
|------|------|
| `line_text_capture_test/` | **全量原始抓取庫**（龍蝦 / OpenClaw 文字抓取主庫）。約 **506** 筆主資料夾（`customer_text_*`）；另有 `_duplicate_chatid_quarantine/` 約 **98** 筆。含 `final_chat.txt`、`raw_*.txt`、`customer_info.txt`、`index.txt` 等。**不可直接整包用於訓練**（須依 manifest 篩選）。 |
| `hermes_training_pack_20260523_040314/` | **Hermes 教材包**；依品質分類的副本與主要分類來源。內含 `README_HERMES_READ_FIRST.txt`、`hermes_training_manifest.csv`，子目錄含 `01_可用_*`、`02_沒標記_*`、`99_亂碼_*`。 |
| `hermes_candidate_usable_data/` | **候選可用精簡集**；約 **36** 筆，每筆通常僅 `customer_info.txt` + `final_chat.txt`（無 raw）。優先作規則萃取與話術整理的起點。 |
| `data_quality_manifest.csv` | **資料品質 manifest**；對 `line_text_capture_test/` 各資料夾的掃描結果（與 Hermes manifest 列數對齊，約 506 列）。 |
| `hermes_training_pack_20260523_040314/hermes_training_manifest.csv` | **Hermes 分類 manifest**；Category / LooksGarbled 等欄位。 |
| `captured_customers.json` | **清單標籤索引**（key 可能含個資）；value 含 `capturedAt`、`targetIndex`、`folder`。**不可將 key 原樣貼入本狀態檔或對外報告。** |
| `captured_chatids.json` | **ChatId 索引**（key 可能含 LINE userId）；value 含 `Folder`、`ChatType`、`RecordedAt`、`Source`。**不可將 key 原樣貼入本狀態檔或對外報告。** |

其他參考（非訓練主入口）：

- `LOBSTER_ARCHIVE_MANIFEST_20260523.txt`、`RESTORE_LOBSTER_ARCHIVE_20260523.ps1`：封存清單與還原腳本；訓練模組不應觸發還原或搬移封存。
- `line_customers_capture/`、`line_capture_test/`：早期試抓，規模小，不作主庫。
- 根目錄多份 `stable_captured_*.json`：各批次抓取成功的索引快照，僅供對照歷史，不作唯一真相來源。

## 2. Current known counts

以下為 2026-05-23 前後盤點與 Cursor 第一審確認之數字；**若與現場 manifest 不一致，以 manifest / 資料夾實際數量為準**。

| 項目 | 數量 |
|------|------|
| `hermes_training_manifest.csv` 資料列 | 約 **506** |
| `data_quality_manifest.csv` 資料列 | 約 **506** |
| `data_quality_manifest` → `CandidateUsable = True` | **36** |
| `data_quality_manifest` → `LooksGarbled = True` | **443** |
| Hermes `01_可用_有標記中文_direct` | **6** |
| Hermes `02_沒標記但是中文_unknown` | **30** |
| Hermes `99_亂碼_不可用` | **443** |
| `hermes_candidate_usable_data/` 資料夾 | **36**（與 CandidateUsable 一致） |
| `line_text_capture_test/` 主資料夾（不含 quarantine） | 約 **506** |
| `line_text_capture_test/_duplicate_chatid_quarantine/` | 約 **98** |
| `captured_customers.json` 索引筆數 | 約 **620** |
| `captured_chatids.json` 索引筆數 | 約 **239** |

Hermes README 另註：`skipped_other`、`skipped_group` 等類別存在；詳見 manifest 的 `Category` 欄位。

## 3. Usable / restricted / forbidden data

### Usable first

- `hermes_candidate_usable_data/`
- `hermes_training_pack_20260523_040314/01_可用_有標記中文_direct/`

### Needs review

- `hermes_training_pack_20260523_040314/02_沒標記但是中文_unknown/`
- 任何 `ChatType = unknown`（見 manifest）
- 任何沒有明確品質標記的新增資料夾

### Forbidden for training by default

- `99_亂碼_不可用`（Category）
- `LooksGarbled = True`（manifest 欄位）
- `skipped_other`、`skipped_group`（Category）
- `line_text_capture_test/_duplicate_chatid_quarantine/`（重複 chatId 隔離，預設不用於訓練）
- `line_text_capture_test/` **全量原始庫未篩選資料**（須先依 manifest 分類）

## 4. Privacy rules

- 不准把客戶原文整段貼進 GPT / Cursor 對話或狀態檔。
- 不准把電話、地址、姓名、完整 userId、完整 display name key 寫入狀態檔。
- 狀態檔只能寫統計、路徑、欄位名稱、品質分類、資料夾命名模式（如 `customer_text_YYYYMMDD_HHMMSS`）。
- 若要抽樣分析，必須先去識別化。
- `captured_customers.json` 的 key 可能含個資，**不可原樣貼出**。
- `captured_chatids.json` 的 key 可能含 LINE userId，**不可原樣貼出**。

## 5. Manifest fields

僅列欄位名稱，不貼資料列。

**`hermes_training_manifest.csv`**

- Folder
- Category
- ChatType
- HasFinal
- HasInfo
- HasMeta
- Duplicate
- LooksGarbled
- ChineseChars

**`data_quality_manifest.csv`**

- Folder
- LastWriteTime
- HasFinal
- HasInfo
- HasMeta
- ChatType
- Duplicate
- LooksGarbled
- Length
- ChineseChars
- QuestionMarks
- CandidateUsable

## 6. Recommended workflow

1. 先讀 `TRAINING_DATA_STATUS.md`（本檔）。
2. 再讀 `hermes_training_manifest.csv` / `data_quality_manifest.csv`，**不要**一開始就批次打開全量 `final_chat.txt`。
3. 只從 **Usable first** 類別做規則萃取、話術整理、流程分析。
4. **Needs review** 類別須人工確認後才可納入教材。
5. **Forbidden** 類別預設禁止用於訓練或規則萃取。
6. **不要接進 `server.js`**；派單 webhook 與訓練資料讀取分離。
7. 不要讓正式 LINE 派單主系統直接讀取訓練資料目錄。
8. 訓練資料整理、Hermes 教材維護與正式營運部署分開進行。

## Gemini / Hermes analysis outputs

- repo 內目前**未找到** Gemini 已整理完成的派單規則摘要 / 訓練摘要 / 對話分類 prose 報告（獨立檔案）。
- `hermes_training_pack_20260523_040314/README_HERMES_READ_FIRST.txt` 是**分析指令**（規定 Hermes / Gemini 如何讀取教材），**不是**已完成分析結果。
- `hermes_training_manifest.csv` / `data_quality_manifest.csv` 是 **manifest / 分類索引**，不是 Gemini prose summary。
- `rules/dispatch_rules_v1.js` 是**手寫規則**定義，**不可**誤標為龍蝦 / Gemini 整理成果。
- 若未來找到外部 Gemini 對話摘要（例如網頁對話、本機未入庫檔），必須**先去識別化**，再決定是否入庫。
- 在 repo 內找到此類輸出之前，**不准**把「已訓練完成」或「已完成規則萃取」當作事實。

## 7. Current next step

- 第一階段：只建立文件型訓練資料狀態（本檔 + `PROJECT_STATE.md` 指向）。
- **規則萃取計畫檔：** `TRAINING_RULE_EXTRACTION_PLAN.md` — 目前僅建立計畫，**不進行萃取**。
- 下一步（待 GPT 審查）：可考慮 `training_index.json` / csv，**目前先不做**。
- 不接 `server.js`、不移動資料、不訓練模型。
- 新增抓取資料時，應更新 manifest 或重新掃描後再更新本檔統計。
