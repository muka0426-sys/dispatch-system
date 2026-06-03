# AI Dispatcher Role

## 0. Purpose

- 本檔定義 dispatch-system 的 AI 角色。
- AI 不是聊天機器人。
- AI 不是關鍵字機器人。
- AI 不是單純地址解析器。
- AI 的目標是成為「AI 派車專員」。
- AI 要像真人派單員一樣理解客人訊息、訂單狀態與下一步。

## 1. Core role

- **AI 是派車專員的大腦** — 負責理解客人本則訊息、承接對話與進行中訂單上下文，並提出下一步建議（intent / decision / next_action / reason）。
- **`server.js` 是狀態保管與執行層** — 訂單狀態、draft、pending 鎖、conversation log、回覆 LINE、呼叫 Maps、建立訂單、推送司機群。
- **gate 是安全保險，不是主要派車邏輯** — cancel / quote / special / status inquiry 等 gate 防止已知高風險誤判；長期目標是 AI 先給 decision，gate 做確認與硬邊界，而非只靠 regex 當主腦。
- AI 應輸出（未來）：**intent、decision、next_action、reason**（詳見 `AI_DECISION_SCHEMA_DRAFT.md`）。
- **server 仍負責** Google Maps 驗證、`createOrder`、`pushDispatchCardOnce`、資料庫 / 記憶體狀態更新 — 這些不可交由 AI 單方面決定。

## 2. What AI must decide

AI 派車專員應能判斷（含但不限於）：

| 判斷項 | 說明 |
|--------|------|
| 是否是叫車 | 客人是否要安排用車、補齊或修改叫車需求 |
| 是否是問價 | 純估價 / 公式 / 機場定額詢問，未必立即叫車 |
| 是否是取消 | 明確放棄、不叫了、不用了等 |
| 是否是狀態追問 | 有嗎、到了嗎、司機到了嗎等，追問既有單狀態 |
| 是否是改時間 / 改地點 | 媒合前後修改同一筆需求 |
| 是否是特殊需求 | 寵物、大車、代買、跑腿、搬家等 |
| 是否需要追問 | 地址 / 時間 / 意圖不清，需一問一答 |
| 是否可以派車 | 資料與 intent 是否達派車候選（仍須 server 驗證） |
| 是否需要人工介入 | 未建檔路線、複合計費、情緒高、規則不明 |
| 是否只是閒聊 / 感謝 / 確認 | 與叫車無關或僅禮貌回應 |

## 3. What AI must not do alone

- 不可單方面決定 `createOrder`。
- 不可單方面通知司機群（`pushDispatchCardOnce`、司機群 `@` 等）。
- 不可繞過 Google Maps 驗證。
- 不可繞過 cancel / quote / special **安全保險**（現階段必保留；未來改為 AI 建議 + gate 確認）。
- 不可把**問價**當**派車**。
- 不可把**取消**當**新單**。
- 不可把**狀態追問**當**新單**。
- 不可把**特殊需求**直接當一般單派出（須 hold / 確認 / 人工）。

## 4. Gate vs AI division

| 元件 | 現狀角色 | 目標角色 |
|------|----------|----------|
| **cancel gate** | 安全保險；AI 前 regex 攔截明確取消 | 長期：**AI decision（cancel_candidate）+ gate confirm** 雙重判斷 |
| **quote gate** | 安全保險；防問價誤派車 | 長期：AI `quote_request` / `should_quote_only` + gate 確認 |
| **special lock** | 安全保險；防特殊需求盲派 | 長期：AI `special_request` + hold + gate 確認 |
| **status inquiry gate** | 安全保險；防狀態追問誤觸 `driverReady` | 長期：AI `status_inquiry` + 短句白名單 gate 確認 |
| **driverReady** | server 硬條件：`hasPickupCandidate && ride_related` | **不應只靠 AI**；須與 Maps、active order、decision 對齊 |
| **Maps validation** | server 硬條件；AI 不可宣稱已驗證 | **永遠 server 硬條件** |

## 5. Current system gap

- **`utils/ai_v7.js` 目前偏解析器 + 回覆器** — 強調 draft 地址萃取、`reply` 生成、`ride_related` intent；prompt 有人設但無完整 decision 輸出。
- **目前缺 decision schema** — 無 `should_dispatch`、`should_quote_only`、`intent`、`next_action` 等欄位（見 `AI_DECISION_SCHEMA_DRAFT.md`）。
- **`server.js` 目前靠 gate + `ride_related` + `driverReady` 決定派車** — AI 每則幾乎都會被呼叫，但關鍵分支由程式 gate 與硬條件主導。
- **這不是最終 AI 派車專員架構** — 是過渡期「混合架構」；訓練規則（Phase 1a 文件）尚未接入 prompt / schema。

## 6. Target architecture

```
客人訊息
  → AI 派車專員（intent + decision + draft + reply + reason）
  → server 安全驗證（gate + Maps + active order + driverReady 硬條件）
  → 執行（回覆 / pending / createOrder / 通知司機 / 人工）
```

- **AI 先輸出 decision**（建議，非命令）。
- **server 再用安全規則驗證 decision** — 不一致時以 server 硬 gate 為準。
- **決策與執行分離** — AI 建議；server 執行。
- **初期只 log / 對照，不直接讓 AI decision 控制派車** — 見 `AI_DECISION_SCHEMA_DRAFT.md` Migration plan。

## 7. Non-goals

- 不是立刻移除 gate。
- 不是全部丟 AI（取消、問價、Maps、特殊需求仍須保險）。
- 不是讓 AI 直接 push 司機群。
- 不是一次重寫 `server.js` 主線。
- 不是立刻改 `utils/ai_v7.js` prompt（須先完成 schema 設計與 GPT 審查任務包）。
