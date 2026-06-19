# AI Dispatcher Human Style Examples v1

## 來源與限制

* 來源：`training_deidentified_output/samples/*.json` 共 6 筆已去識別 sample，皆來自 `01_可用_有標記中文_direct`。
* 是否已去識別：是。樣本中姓名、地址、司機、車牌、派車資訊、ID 多已替換為 `[客人]`、`[地址]`、`[姓名]`、`[司機]`、`[車牌]`、`[派車資訊]`、`[ID]`。
* 二次隱私檢查：本檔不照抄完整對話；所有地點、車牌、人名、司機資訊皆維持 placeholder 或抽象化。看到 `possible_name_or_nickname_remaining` warning 的片段只抽判斷模式，不保留可疑原句。
* 不足之處：目前只有 6 筆 direct sample，問價、改地址、改時間、司機群喊單、派單員代喊單樣本不足，需要更多已去識別資料補齊。

## 核心原則

* 看上下文，不看死關鍵字；同一句「好」可能是 ack，也可能是確認，取決於上一輪狀態。
* 客人「好 / 收到 / 對」在已派車或等待司機資訊後，通常只是 ack，不是改單。
* 報價後「來一台 / 來吧 / 趕快 / 馬上」若上一輪是報價，才傾向確認叫車；本批 direct sample 對問價後確認證據不足，需補資料。
* 資訊不完整時只追問缺的欄位，不重問已知地址、下車點或時間。
* 已經有下車地點，不要再問下車地點；已派車後主要是安撫與狀態同步。
* 尋車中要短句安撫，例如「稍等，立即為您尋車」，不要假裝已派到車。
* 取消要看狀態；未派到車時可直接取消並致歉，已媒合時應確認是否通知司機。
* 客人說「已叫到車 / 那算了 / 取消」是取消意圖，不應繼續派車。
* 司機資訊通知要簡潔，重點是已安排、抵達時間、司機與車輛資訊；不要混入多餘促銷話術。
* 到達通知要清楚，讓客人準備上車；可提醒等候費，但不要恐嚇或責備。
* 上車回報代表流程進入乘車中，回覆應轉為客服支援與完成流程，不再重派。
* 特殊需求（代買、嘔吐、禁菸、指定物品等）要保守處理，必要時轉人工或先確認，不要用一般叫車流程硬派。

## 樣本分類

### 類型：確認叫車

* 情境：客人已有完整叫車格式，或在上一輪報價/詢問後明確要繼續。
* 客人意思：要系統開始尋車或派車。
* 真人派單員判斷：若 pickup/dropoff/time 等資訊已足夠，進入尋車；若上一輪只是報價，本批樣本不足，需要更多已去識別資料補證。
* 建議 AI 回覆：`收到，馬上為您尋車。`
* 不應該怎麼回：不要在資訊已足夠時重複問上下車；不要把問價階段直接當派車。
* 可放進 prompt 的 example：上一輪已確認要車且資料完整時，回覆「收到，馬上為您尋車」，並進入 dispatch candidate。

### 類型：ack

* 情境：系統已在尋車、已派車、已通知司機或已說明狀態後，客人回「好 / 收到 / 對」。
* 客人意思：知道了、接受目前狀態。
* 真人派單員判斷：沒有新增 pickup/dropoff/time/passengers，就不是改單，也不通知司機。
* 建議 AI 回覆：`好的，司機資訊會再通知您。`
* 不應該怎麼回：不要回「已幫您通知司機」；不要把既有地址當成客人更新資訊。
* 可放進 prompt 的 example：已派車等待司機資訊，客人回「好」→ intent `ack`，reply「好的，請稍候」。

### 類型：取消

* 情境：客人表示「已叫到車」「那算了」「取消」「先不用」。
* 客人意思：停止本次尋車或叫車。
* 真人派單員判斷：未媒合或尋車中可直接取消；若已派司機，需同步司機或進一步確認。
* 建議 AI 回覆：`這邊幫您取消，抱歉沒能完成這次派車。`
* 不應該怎麼回：不要繼續派車；不要回報價或要求補資料。
* 可放進 prompt 的 example：尋車中客人說「取消」→ intent `cancel_request`，reply「這邊幫您取消」。

### 類型：催車

* 情境：客人在等待中詢問有沒有車、多久到、司機到哪。
* 客人意思：查狀態，不是開新單。
* 真人派單員判斷：若還在尋車，安撫等待；若已有司機，提供 ETA；若司機已到，提醒準備上車。
* 建議 AI 回覆：`目前還在幫您找車，有司機接單會立刻通知。`
* 不應該怎麼回：不要重新建立派車卡；不要把「有車嗎」當新叫車。
* 可放進 prompt 的 example：state `waiting_driver`，客人問「有了嗎」→ intent `status_inquiry`。

### 類型：司機資訊

* 情境：司機已接單，系統要把司機與車輛資料給客人。
* 客人意思：等待接單結果。
* 真人派單員判斷：用短訊息確認已安排，再附 `[司機資訊]`；若有 ETA，明確告知幾分鐘。
* 建議 AI 回覆：`已為您安排司機，約 10-15 分鐘內抵達。`
* 不應該怎麼回：不要問已知下車點；不要把車牌、司機名以未遮蔽方式放進訓練文件。
* 可放進 prompt 的 example：司機接單後 → reply「已為您安排司機，[司機資訊] 稍後提供」。

### 類型：到達

* 情境：司機回報已到達上車地點。
* 客人意思：需要知道可以準備上車。
* 真人派單員判斷：直接通知已到達，必要時提醒等候費規則。
* 建議 AI 回覆：`司機已到達 [上車地點]，請準備上車。`
* 不應該怎麼回：不要重新問地址；不要把到達訊息當成客人新需求。
* 可放進 prompt 的 example：driver_status `arrived` → customer reply「司機已到達，請準備上車」。

### 類型：上車

* 情境：司機回報客人已上車。
* 客人意思：行程已開始或服務進入乘車中。
* 真人派單員判斷：通知客人已上車，若有問題可回報；不再派車或追問地址。
* 建議 AI 回覆：`司機回報您已上車，有任何乘車問題都可以跟我們反應。`
* 不應該怎麼回：不要再說「馬上為您尋車」；不要問下車地點。
* 可放進 prompt 的 example：driver_status `onboard` → reply「司機回報您已上車」。

### 類型：資訊不足追問

* 情境：客人只給部分地址、地標或叫車格式缺欄位。
* 客人意思：可能要車，但資訊不足。
* 真人派單員判斷：只追問缺的一項；若上車已有、下車缺，就問下車；若時間缺但可預設現在，通常不必追問。
* 建議 AI 回覆：`收到，上車點先記下了，下車要到哪裡？`
* 不應該怎麼回：不要一次丟整張表逼填；不要重問已知欄位。
* 可放進 prompt 的 example：pickup known, dropoff missing → reply「下車要到哪裡？」。

### 類型：特殊需求

* 情境：客人提到代買、指定物品、禁菸、嘔吐、車門狀況等非標準乘車需求。
* 客人意思：要附加條件或非標準服務。
* 真人派單員判斷：先確認是否能處理，必要時轉人工或提醒司機；不要直接當一般派車完成。
* 建議 AI 回覆：`這個需求我先幫您確認，確認可以接再回覆您。`
* 不應該怎麼回：不要亂承諾；不要自動加價或自編規則。
* 可放進 prompt 的 example：special request present → intent `special_request`，action `hold_for_confirmation`。

### 類型：不確定時追問

* 情境：對話斷裂、只有一個簡短回覆、或上一輪狀態不清。
* 客人意思：不一定是叫車或改單。
* 真人派單員判斷：保守追問或維持狀態，不用死關鍵字擴大動作。
* 建議 AI 回覆：`我幫您確認一下，是要繼續叫車還是取消？`
* 不應該怎麼回：不要直接派車；不要直接取消；不要通知司機。
* 可放進 prompt 的 example：state unknown, message ambiguous → intent `unknown`，reply asks one clarifying question.

### 類型：改地址 / 改時間

* 情境：本批 6 個 sample 未提供足夠明確的改地址或改時間對話。
* 客人意思：樣本不足，不能從本批定規則。
* 真人派單員判斷：需要從更多已去識別資料補。
* 建議 AI 回覆：若未來確認是改單，回覆「收到，幫您更正，若已派司機會同步通知。」
* 不應該怎麼回：不要把 ack 當改單；不要用既有地址製造「客人更新資訊」。
* 可放進 prompt 的 example：本版不列 direct evidence，標記 `needs_more_samples`。

## Prompt 可用 few-shot examples

### Example 1

Input context:

* state: `waiting_driver`
* last_bot_message: `稍等，立即為您尋車`
* customer_message: `好`

Expected intent:

* intent: `ack`
* confidence: `high`
* reason: `客人只是回覆收到，沒有新增欄位`

Expected reply:

* reply: `好的，司機資訊會再通知您。`

Safety note:

* note: `不要通知司機，不要更新訂單。`

### Example 2

Input context:

* state: `waiting_driver`
* last_bot_message: `稍等，立即為您尋車`
* customer_message: `取消`

Expected intent:

* intent: `cancel_request`
* confidence: `high`
* reason: `客人明確停止本次派車`

Expected reply:

* reply: `這邊幫您取消，抱歉沒能完成這次派車。`

Safety note:

* note: `若已媒合司機，server 應同步司機或走取消 gate。`

### Example 3

Input context:

* state: `waiting_driver`
* last_bot_message: `目前還在幫您找車`
* customer_message: `那算了`

Expected intent:

* intent: `cancel_request`
* confidence: `high`
* reason: `放棄等待`

Expected reply:

* reply: `好的，這邊先幫您取消。`

Safety note:

* note: `不要繼續派車。`

### Example 4

Input context:

* state: `waiting_driver`
* last_bot_message: `稍等，立即為您尋車`
* customer_message: `有車了嗎`

Expected intent:

* intent: `status_inquiry`
* confidence: `high`
* reason: `詢問尋車狀態`

Expected reply:

* reply: `目前還在幫您找車，有司機接單會立刻通知。`

Safety note:

* note: `不要建立新派車 draft。`

### Example 5

Input context:

* state: `matched`
* last_bot_message: `已為您安排司機，約 10-15 分鐘內抵達`
* customer_message: `收到`

Expected intent:

* intent: `ack`
* confidence: `high`
* reason: `接收司機資訊`

Expected reply:

* reply: `好的，請稍候。`

Safety note:

* note: `不要回已通知司機。`

### Example 6

Input context:

* state: `matched`
* last_bot_message: `[司機資訊]`
* customer_message: `司機到了嗎`

Expected intent:

* intent: `status_inquiry`
* confidence: `high`
* reason: `詢問司機位置`

Expected reply:

* reply: `我幫您確認司機狀態，有更新會立刻通知。`

Safety note:

* note: `不要重派派車卡。`

### Example 7

Input context:

* state: `matched`
* last_bot_message: `司機已出發，車到通知您`
* customer_message: `好`

Expected intent:

* intent: `ack`
* confidence: `high`
* reason: `客人接受等待`

Expected reply:

* reply: `好的，車到會通知您。`

Safety note:

* note: `不要要求補地址。`

### Example 8

Input context:

* state: `matched`
* last_bot_message: `司機已出發，車到通知您`
* customer_message: `可以提前上車嗎`

Expected intent:

* intent: `status_inquiry`
* confidence: `medium`
* reason: `詢問上車時間彈性`

Expected reply:

* reply: `可以提前或準時上車，司機到點會通知您。`

Safety note:

* note: `不要改訂單時間，除非客人明確要求改時間。`

### Example 9

Input context:

* state: `driver_arrived`
* last_bot_message: `司機已到達 [上車地點]`
* customer_message: `好`

Expected intent:

* intent: `ack`
* confidence: `high`
* reason: `客人知道司機已到`

Expected reply:

* reply: `好的，請準備上車。`

Safety note:

* note: `不要重問上車地點。`

### Example 10

Input context:

* state: `driver_arrived`
* last_bot_message: `司機已到達 [上車地點]`
* customer_message: `等一下`

Expected intent:

* intent: `hold_short`
* confidence: `medium`
* reason: `客人請司機稍等`

Expected reply:

* reply: `好的，提醒您超過等候時間可能會有等候費。`

Safety note:

* note: `如已媒合，必要時同步司機。`

### Example 11

Input context:

* state: `onboard`
* last_bot_message: `司機回報您已上車`
* customer_message: `謝謝`

Expected intent:

* intent: `ack`
* confidence: `high`
* reason: `乘車中客人回覆感謝`

Expected reply:

* reply: `不客氣，有乘車問題都可以跟我們反應。`

Safety note:

* note: `不要再觸發派車。`

### Example 12

Input context:

* state: `collecting_order`
* last_bot_message: `請提供上車與下車地點`
* customer_message: `上車 [上車地點]`

Expected intent:

* intent: `provide_partial_info`
* confidence: `high`
* reason: `只補了上車點`

Expected reply:

* reply: `收到，上車點先記下了，下車要到哪裡？`

Safety note:

* note: `只追問缺的下車，不要重問上車。`

### Example 13

Input context:

* state: `collecting_order`
* last_bot_message: `下車要到哪裡？`
* customer_message: `[下車地點]`

Expected intent:

* intent: `provide_dropoff`
* confidence: `high`
* reason: `補齊下車點`

Expected reply:

* reply: `收到，幫您安排車輛，請稍候。`

Safety note:

* note: `若 pickup 已存在，不要再問上車。`

### Example 14

Input context:

* state: `collecting_order`
* last_bot_message: `收到，幫您確認需求`
* customer_message: `有代買需求`

Expected intent:

* intent: `special_request`
* confidence: `high`
* reason: `非標準載客需求`

Expected reply:

* reply: `這個需求我先幫您確認，確認可以接再回覆您。`

Safety note:

* note: `不要直接承諾，也不要自動加價。`

### Example 15

Input context:

* state: `matched`
* last_bot_message: `[司機資訊]`
* customer_message: `我要取消`

Expected intent:

* intent: `cancel_request`
* confidence: `high`
* reason: `已媒合後取消`

Expected reply:

* reply: `收到，我先幫您處理取消並同步司機。`

Safety note:

* note: `已媒合時不能只對客回覆，需走 server 取消流程。`

### Example 16

Input context:

* state: `unknown`
* last_bot_message: `需要幫您叫車嗎？`
* customer_message: `對`

Expected intent:

* intent: `confirm_previous_question`
* confidence: `medium`
* reason: `只確認上一輪問題，需看上一輪是否為叫車確認`

Expected reply:

* reply: `收到，請提供上車與下車地點，我幫您安排。`

Safety note:

* note: `沒有完整路線時不要直接派車。`

## 缺口

* 問價樣本不足：6 筆 sample 未提供典型「[上車地點] 到 [下車地點] 多少錢」後續確認鏈。
* 改地址 / 改時間樣本不足：目前只能列原則，不能做強規則。
* 司機群喊單樣本不足：本批是客人 direct 對話，沒有司機群喊單、派單員代喊單、車卡貼回群組流程。
* 派單員代喊單樣本不足：需更多已去識別司機群資料才能分析。
* 特殊需求樣本偏少：有代買與備註類情境，但不足以覆蓋寵物、大車、行李、酒醉等需求。
* 需要更多已去識別樣本：建議下一批先補問價、改單、催車、司機群狀態訊號。
