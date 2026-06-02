# Training Rule Extraction Phase 1A

## 0. Scope

- 本檔是 Phase 1a 的初步規則萃取結果。
- 來源僅限 `01_可用_有標記中文_direct` 的 6 筆資料。
- 本檔不含客戶原文。
- 本檔不含個資。
- 本檔不可直接進程式。
- 所有規則都只是候選，需 GPT 審查後才能進入實作。

## 1. Source audit

| 項目 | 結果 |
|------|------|
| **Manifest 路徑** | `hermes_training_pack_20260523_040314/hermes_training_manifest.csv` |
| **篩選條件** | `Category = 01_可用_有標記中文_direct` |
| **篩出 folder 數量** | **6** |
| **讀取入口** | 僅 `hermes_candidate_usable_data/`（未讀 pack 內 01/02 副本路徑） |
| **final_chat.txt** | 6 / 6 存在 |
| **customer_info.txt** | 6 / 6 存在 |
| **manifest ChatType** | 6 筆皆 `direct` |
| **manifest LooksGarbled** | 6 筆皆 `False` |

**Folder 清單（僅資料夾命名模式，不含個資）：**

- `customer_text_20260523_021803`
- `customer_text_20260523_022101`
- `customer_text_20260523_023526`
- `customer_text_20260523_023643`
- `customer_text_20260523_024246`
- `customer_text_20260523_024513`

**排除確認：**

- 未讀 `02_沒標記但是中文_unknown`（30 筆）
- 未讀 `99_亂碼_不可用`
- 未讀 `skipped_other` / `skipped_group`
- 未讀 `_duplicate_chatid_quarantine/`
- 未讀 `line_text_capture_test/` 全量

## 2. Extracted rule candidates

### P0-A：系統不應自動派車的情境

---

**Rule ID:** P0-A-001  
**Category:** P0-A — 非叫車服務詢問  
**Trigger pattern:** 客人詢問車隊是否提供某項**非標準叫車**服務（例如垃圾代收、特殊代運類服務是否存在）  
**System should do:** 明確回覆是否提供；若不提供，結束流程，不建立派車 draft  
**System should not do:** 把此類詢問當成叫車 intent 並自動派車  
**Counterexample:** 客人雖問服務是否存在，但同則訊息也含完整上下車地址且明確要車 → 需人工或 AI 判斷主次 intent  
**Evidence count:** 1（1 / 6 folder 出現此類詢問）  
**Confidence:** medium  
**Privacy check:** passed  
**Related current code:** `utils/ai_v7.js`（`ride_related` 判斷）；`server.js` 主線  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-A-002  
**Category:** P0-A — 派車狀態追問  
**Trigger pattern:** 客人僅追問**已有訂單/尋車中**狀態（例如「有嗎」「有車嗎」「到了嗎」「司機到了嗎」），無新上下車資訊  
**System should do:** 回覆狀態或轉人工；不建立新派車 draft  
**System should not do:** 把狀態追問當成新叫車單並重複派車  
**Counterexample:** 「到了嗎」同時附新上車地址 → 可能是新單，需另判  
**Evidence count:** 4（4 / 6 folder 多次出現狀態追問）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`；`utils/ai_v7.js`  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-A-003  
**Category:** P0-A — 尋車等待 / 無車循環  
**Trigger pattern:** 系統或人工已進入「尋車中 / 附近無空車 / 是否繼續派車」流程；客人回覆數字選項（如繼續）或沉默後被系統取消  
**System should do:** 維持等待狀態或依人工規則處理；不另開新派車 pipeline  
**System should not do:** 把「繼續尋車」回覆誤判為全新叫車 intent  
**Counterexample:** 客人明確送出全新完整叫車格式 → 可能是新訂單  
**Evidence count:** 3（3 / 6 folder 出現無車等待 / 按鍵繼續流程）  
**Confidence:** medium  
**Privacy check:** passed  
**Related current code:** `server.js`（目前以人工客服為主，自動 bot 未必有對應狀態）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-A-004  
**Category:** P0-A — 已在別處叫到車  
**Trigger pattern:** 客人表示**已在其他管道叫到車**，要求取消本車隊這單（例如「已叫到…先取消」類表述）  
**System should do:** 取消本單；不回「已為您派車」  
**System should not do:** 忽略取消請求繼續派車  
**Counterexample:** 「已叫到」是指本車隊剛派到的司機 → 語意歧義，需上下文  
**Evidence count:** 2（2 / 6 folder）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（cancel gate）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-A-005  
**Category:** P0-A — 同時多平台叫車  
**Trigger pattern:** 客人明示**同時向多家叫車**或需保留多台車，再取消其中一台  
**System should do:** 人工協調或狀態鎖定；避免 bot 無狀態重複派車  
**System should not do:** 無上下文地對每則地址訊息都自動派車  
**Counterexample:** 單次叫車但歷史有多筆取消紀錄 → 不等於多平台  
**Evidence count:** 2（2 / 6 folder 出現多車 / 雙單情境）  
**Confidence:** medium  
**Privacy check:** passed  
**Related current code:** `server.js`  
**Implementation status:** document only, not approved for code

---

### P0-B：問價 / 報價 / 機場定額

---

**Rule ID:** P0-B-001  
**Category:** P0-B — 計費公式詢問  
**Trigger pattern:** 客人詢問**計費規則是否正確**（例如「基本費 + 每公里單價」的確認句），未必含「多少錢」字眼  
**System should do:** 進入 quote / 說明模式；回覆官方公式；不直接派車  
**System should not do:** 把公式確認句當成完整叫車 intent  
**Counterexample:** 公式詢問後緊接「好，幫我叫」→ 應分兩階段處理  
**Evidence count:** 1（1 / 6 folder 有明確公式詢問對話）  
**Confidence:** medium  
**Privacy check:** passed  
**Related current code:** `server.js`（`detectPureQuoteIntent`）；`utils/ai_v7.js`（`rsFareExpectedBy52`）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-B-002  
**Category:** P0-B — 人工客服公式 vs 程式公式  
**Trigger pattern:** 人工客服以「公里數 × 單價 + 基本費」向客人解釋（未提及低消 / ceil 規則）  
**System should do:** （文件記錄）bot 回覆應以程式官方規則 `max(130, 50 + 20 × ceil(km))` 為準  
**System should not do:** 因訓練資料中人工話術而改回舊公式  
**Counterexample:** 機場定額路線 → 不走里程公式  
**Evidence count:** 1（1 / 6 folder 人工解釋與現行程式可能不一致）  
**Confidence:** high（衝突面）  
**Privacy check:** passed  
**Related current code:** `utils/ai_v7.js`（`rsFareExpectedBy52`）；`server.js`（quote display）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-B-003  
**Category:** P0-B — 純路線估價（A 到 B 多少）  
**Trigger pattern:** 客人詢問**特定路線**車資（上下車地點 + 多少錢 / 幾錢）  
**System should do:** 進 `pending_quote_confirmation`；顯示估價；等確認後才派車  
**System should not do:** 直接回「已為您派車」  
**Counterexample:** 問價句同時含「現在幫我叫」→ 可能為確認叫車  
**Evidence count:** 0（6 筆 direct 中**未見**典型 A→B 純問價句；此規則來自計畫 P0 與現行程式，非本批實證）  
**Confidence:** low（本批無 direct evidence）  
**Privacy check:** passed  
**Related current code:** `server.js`（fare quote gate V1/V1.1）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-B-004  
**Category:** P0-B — 機場定額詢問  
**Trigger pattern:** 客人詢問**機場接送定額**  
**System should do:** 回覆定額或進 quote gate；不直接派車  
**System should not do:** 僅因出現「機場」關鍵字就派車  
**Counterexample:** 明確機場叫車且已確認要派 → 可進派車  
**Evidence count:** 0（6 筆 direct 未見）  
**Confidence:** low  
**Privacy check:** passed  
**Related current code:** `server.js`；`utils/ai_v7.js`（airport flat rates）  
**Implementation status:** document only, not approved for code

---

### P0-C：取消 / 不坐 / 不叫了

---

**Rule ID:** P0-C-001  
**Category:** P0-C — 明確放棄用詞  
**Trigger pattern:** 客人使用「那算了」「不用了」「先不用」等**放棄叫車**用語  
**System should do:** 在有 active order 或 pending 狀態時取消；回覆已取消  
**System should not do:** 繼續派車或追問上車地址  
**Counterexample:** 「那算了」後又送完整叫車格式 → 可能是新 intent  
**Evidence count:** 2（2 / 6 folder）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（cancel gate：`那算了`、`不用了`、`先不用`）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-C-002  
**Category:** P0-C — 單字或短句「取消」  
**Trigger pattern:** 客人單送「取消」或「麻煩幫我取消」類短句  
**System should do:** 若存在進行中訂單 / 尋車 / pending，執行取消  
**System should not do:** 在無 active 狀態時誤觸其他流程  
**Counterexample:** 客服先問「取消嗎？」客人回「對」→ 多輪確認，非單則 cancel gate 可涵蓋  
**Evidence count:** 5（5 / 6 folder 多次出現）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（cancel gate：`取消`、`幫我取消`）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-C-003  
**Category:** P0-C — 「取消嗎」為客服問句  
**Trigger pattern:** **客服**向客人確認「取消嗎」，客人回「對 / 好」  
**System should do:** （人工流程）確認後取消  
**System should not do:** 把客人單獨說的「取消嗎」當成 execute cancel（應視為詢問句排除）  
**Counterexample:** 客人主動「可以取消嗎」→ 屬詢問，非 execute  
**Evidence count:** 1（1 / 6 folder 有客服確認取消對話）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（cancel gate 已排除 `可以取消嗎`、`取消嗎` 等）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-C-004  
**Category:** P0-C — 已派司機後取消  
**Trigger pattern:** 司機資訊已送出後，客人仍要求取消（含「不用了謝謝」）  
**System should do:** 允許取消並通知司機 / 人工；必要時提及取消費規則  
**System should not do:** 忽略取消繼續等待上車  
**Counterexample:** 取消費詢問句 → 應回說明而非 execute cancel  
**Evidence count:** 3（3 / 6 folder 在已派車後仍出現取消）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-C-005  
**Category:** P0-C — 尋車失敗後取消  
**Trigger pattern:** 長時間無車或系統提示停止尋車後，客人回「取消」  
**System should do:** 確認取消；結束尋車  
**System should not do:** 自動重開派車  
**Counterexample:** 取消後立即送新地址 → 新單  
**Evidence count:** 3（3 / 6 folder）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`  
**Implementation status:** document only, not approved for code

---

### P0-D：特殊需求：寵物、大車、代買、跑腿、行李多

---

**Rule ID:** P0-D-001  
**Category:** P0-D — 代買 + 指定商品流程  
**Trigger pattern:** 客人要求司機**代購指定商品**（含數量、拍照確認、現金支付等備註）  
**System should do:** 進 special request lock；人工確認商品 / 費用 / 路線後再派  
**System should not do:** 當一般 point-to-point 叫車直接派  
**Counterexample:** 備註「幫我買水」但上下車同店 → 仍屬特殊需求  
**Evidence count:** 1（1 / 6 folder 有完整代買對話）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（`detectSpecialServiceRequest`：`代買`）；`utils/ai_v7.js`  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-D-002  
**Category:** P0-D — 跑腿 / 運送物件  
**Trigger pattern:** 客人要求**運送物品**至指定地點（非單純載客），或提及跑腿加價  
**System should do:** 標記特殊服務；說明額外費用；人工確認後派車  
**System should not do:** 忽略「運送 / 跑腿」直接當一般叫車  
**Counterexample:** 「行李多」僅為備註但仍為載客 → 可能仍屬 special，但非跑腿  
**Evidence count:** 1（1 / 6 folder 有跑腿 / 運送對話）  
**Confidence:** high  
**Privacy check:** passed  
**Related current code:** `server.js`（`跑腿`、`運送` keyword）；`rules/dispatch_rules_v1.js`（`SPECIAL_SERVICE`）  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-D-003  
**Category:** P0-D — 代買 + 里程複合計費  
**Trigger pattern:** 客人明示計費方式含**里程 + 代買 / 代購費**等多段費用  
**System should do:** 人工報價確認；不可只用標準里程 bot 公式  
**System should not do:** 只回 `50 + 20/km` 標準價  
**Counterexample:** 一般叫車備註「幫我停便利商店」→ 未必到代買級別  
**Evidence count:** 1（1 / 6 folder）  
**Confidence:** medium  
**Privacy check:** passed  
**Related current code:** `utils/ai_v7.js`；`server.js`  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-D-004  
**Category:** P0-D — 大車 / 休旅需求  
**Trigger pattern:** 客人備註或要求**休旅 / 大車 / 七人座**等車型  
**System should do:** special lock + 加價規則確認  
**System should not do:** 派一般小車且不告知  
**Counterexample:** 司機派遣資訊顯示休旅車，但客人未要求 → 不能反推客人需求  
**Evidence count:** 1（1 / 6 folder 派遣資訊含休旅車型；客人主動要求證據較弱）  
**Confidence:** low  
**Privacy check:** passed  
**Related current code:** `server.js`（`大車|休旅|SUV`）；`utils/ai_v7.js`  
**Implementation status:** document only, not approved for code

---

**Rule ID:** P0-D-005  
**Category:** P0-D — 寵物 / 行李多  
**Trigger pattern:** 備註提及**寵物、行李多**  
**System should do:** special lock 或人工確認  
**System should not do:**  silent dispatch  
**Counterexample:** —  
**Evidence count:** 0（6 筆 direct 未見明確寵物 / 行李多備註）  
**Confidence:** low  
**Privacy check:** passed  
**Related current code:** `server.js`；`rules/dispatch_rules_v1.js`  
**Implementation status:** document only, not approved for code

---

**Phase 1a 候選規則小計：20 條**（含 evidence count = 0 的缺口標記規則 3 條）

## 3. Gaps found

6 筆 direct 中**未見或極少**，需 Phase 1b（30 unknown）或人工補樣本：

| 缺口類型 | 說明 |
|----------|------|
| 純路線問價（A→B 多少錢） | 本批無典型樣本；fare quote gate 無法用本批驗證 |
| 機場定額詢問 | 本批未見 |
| 寵物 / 行李多備註 | 本批未見 |
| 明確「幫我叫車」intent 邊界 | 多為結構化格式或「安排」，較少口語叫車句 |
| 改時間 / 改地點（媒合後） | 少見；僅見改停點、改車 |
| 司機報班黑話（地名+數字 ETA） | 本批皆 passenger direct，未見司機端訊息 |
| Group 對話 | 本批 ChatType 皆 direct |
| 問價後確認叫車（兩階段） | 本批未見完整 quote → confirm 流程 |

## 4. Conflicts with current code

### vs `server.js` cancel gate

| 衝突 / 缺口 | 說明 |
|-------------|------|
| **多輪確認取消** | 客服問「取消嗎」+ 客人「對」— cancel gate 為單則判斷，無法覆蓋 |
| **已派車後取消** | gate 有 cancel 詞，但取消費 / 空趟費為人工處理，bot 未必對齊 |
| **整體** | 現行排除詞（`取消嗎`、`可以取消嗎` 等）與本批人工對話**方向一致**；衝突風險低 |

### vs fare quote gate

| 衝突 / 缺口 | 說明 |
|-------------|------|
| **公式詢問未含「多少錢」** | `detectPureQuoteIntent` 依賴 `多少錢|車資|怎麼算` 等；本批有「基本費 + 公里單價是否正確」類句，**可能漏進 quote gate** |
| **人工公式話術** | 客服 `公里數×20+50` vs 程式 `max(130, 50+20×ceil(km))` — **潛在回覆不一致** |
| **純 A→B 問價** | 現行 gate 設計合理，但本批無樣本驗證 |

### vs special request lock

| 衝突 / 缺口 | 說明 |
|-------------|------|
| **代買 / 跑腿** | `代買|跑腿|運送` 已在 keywordRe — **與本批高信心樣本一致** |
| **複合計費** | lock 後如何報價（代購費 + 里程）— 程式未見完整規則，仍靠人工 |
| **休旅 / 大車** | keyword 有覆蓋；本批客人主動要求證據弱 |

### vs `utils/ai_v7.js`

| 衝突 / 缺口 | 說明 |
|-------------|------|
| **結構化叫車格式** | 「神話叫車格式」模板 — AI 應能解析；與現行 prompt 相容 |
| **簡短「A 到 B」兩行** | 常見於本批；需確保 pickup/dropoff 解析穩定 |
| **地址導航不到** | 人工處理「上車地址導航不到」— bot 應觸發 map verify fail / manual review |
| **司機黑話** | 本批未覆蓋；現行 prompt 規則無法用本批驗證 |

**文件結論：** 未發現需立即改碼的硬衝突；主要缺口在 **quote gate 對「公式確認句」的覆蓋** 與 **人工話術 vs 官方公式不一致**。皆需 GPT 審查後再決定是否調整 `detectPureQuoteIntent` 或 reply 文案。

## 5. Recommended next step

1. **GPT 審查 Phase 1a（必做）** — 審本檔 20 條候選規則、evidence count、衝突表；核准前不進程式。
2. **建立 Phase 1a review 表（建議）** — 以 §6 template 逐條填 `Human review status`；可先從 evidence ≥ 2 的 8 條高信心規則開始。
3. **人工 spot-check（建議）** — 6 筆 direct 雖已標可用，仍建議人工確認無 group 混入、無個資外洩風險後，才進 Phase 1b。
4. **Phase 1b（待 GPT 核准後）** — 30 筆 unknown 可能補足問價、口語叫車、邊界 cancel；**不可跳過人工 gate**。
5. **不建議現階段改 `server.js` / `ai_v7.js`** — 樣本少且多為人工客服流程，自動 bot 不可直接照搬。
