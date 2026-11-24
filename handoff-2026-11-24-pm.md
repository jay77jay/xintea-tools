# 交接：心茶 B2C 工作程式——旺季 ②③④、B2B 箱型、無庫存搬檔（2026-11-24 下午）

以繁體中文回覆；先講根本原因再改程式；先寫測試看紅燈再改，改之前備份原檔、更新版本號、`node --check`。

## 先讀

- 規格 `D:\AI Design Project\xintea-tools\b2b-worker-jobs.md`（main 已含全部）：
  - 14-3 ② ③ ④ 實作狀態、「14-3 ② 補充」（xintea_stage2.py GENERATED_RE）
  - 第 15 節：無庫存舊單搬到「已重傳」被鎖（EBUSY）
- 上一份交接：`git show claude/affectionate-tesla-44e102:handoff-2026-11-24.md`（只在那個分支）
- 已合併的 PR（jay77jay/xintea-tools）：
  - #29 ②③ https://github.com/jay77jay/xintea-tools/pull/29
  - #30 ④ 先 OCR https://github.com/jay77jay/xintea-tools/pull/30
  - #31 B2B 回報箱型只放包材（拿掉黑貓、LALA，加 B01；xintea-b2b v2026-11-24-1）https://github.com/jay77jay/xintea-tools/pull/31
  - #32 規格 15 無庫存搬檔被鎖 https://github.com/jay77jay/xintea-tools/pull/32

## 目前版本（公司電腦，都不在 repo 的已直接改好、旁邊有 .bak_ 備份）

- `心茶自動化\B2B\`：b2c-start-2026-11-24-4、b2c-ship-2026-11-24-5、b2b-worker-2026-11-24-2
- `shipment\`：shipment.html v2026-11-24-128、agent-driver driver-2026-11-24-2（shipment 資料夾不是 git）
- `心茶自動化\xintea_stage2.py`：GENERATED_RE 認得 `訂單明細_日期-N.pdf`
- 網頁（GitHub Pages，已確認線上）：xintea-ship-2026-11-24-2、xintea-b2b v2026-11-24-1

## 環境事實（這次新增）

- 公司電腦已裝 GitHub CLI 並登入（jay77jay）：`C:\Program Files\GitHub CLI\gh.exe`。已開著的終端機 PATH 沒更新時用完整路徑。可直接 `gh pr create`／`gh pr merge --merge`（這個 repo 一直用 merge commit）。
- 這個 repo 沒有 CI；合併後用 `gh api repos/jay77jay/xintea-tools/pages/builds/latest` 看 Pages，再讀線上檔案的版本字串確認。
- 測試跑法寫在各測試檔開頭；連跑時把完整輸出存檔（11/24 曾有一次連跑 3 個測試失敗、重跑重現不出來、沒留下錯誤）。
- 讀 Firestore 工作紀錄要先問 Jay（11/24 被中斷過一次）。

## 還沒做／等 Jay

1. **Jay 要做**：重新啟動 b2b-worker（b2c-ship-2026-11-24-5 才生效）；確認 `E:\USER_不能刪\Downloads\無庫存訂單--------\無庫存訂單 心茶1124-1單.xlsx` 沒開在 Excel，再按一次「只重傳無庫存」補跑 11/24 14:29 那次（SG 已匯入，會沿用結果不重傳）。那時 `心茶1124\sg_uploads.json` 只有第 1 批。
2. **真實流程驗證**（第一次遇到時看執行紀錄）：
   - ② 300 單以上訂單明細切檔、存檔、送印
   - ③ OCR 進度行原地更新、「認出 X、要人工 Y」對得上 shipment「待人工比對」
   - ④ 第 1 段結束自動排 `b2cOcr`、shipment 只解析不比對、第 2 段寫「N 個檔已經 OCR 過，跳過」
   - 15：檔案開在 Excel 時重試後寫 ⚠、照常跑
   - 上一份交接列的：BPM 區間查詢、同一天兩個出廠日、新竹一次印 300 張、SG 大檔
3. 已知限制：工作程式一次只跑一個工作，先 OCR 旺季幾十分鐘期間後按的工作要排隊（Jay 已知道）。
4. `tests/test-giftbox-ledger.js` 在 Windows 因 CRLF 出錯（舊問題，與這次無關）。

## 這次加的測試（xintea-tools/tests）

test-detail-split.js（給 shipment.html 和心茶自動化資料夾）、test-ocr-progress.js、test-ocr-early.js（給 shipment 資料夾和 B2B 資料夾）、test-nostock-move.js（給 B2B 資料夾）；test-ship-web.js 加了 ④ 檢查。

## 建議用的 skills

- `mattpocock-skills:diagnosing-bugs`：真實流程驗證出問題時（先查環境差異、檔案鎖、版本有沒有重啟）
- `mattpocock-skills:tdd`：要改工作程式／shipment 時（規格要求先紅燈再改）
- `xintea-daily-shipment:xintea-daily-shipment`：要實際跑心茶每日出貨
- `mattpocock-skills:code-review`：合併到 main 前檢查分支
