# B2B 工作程式（b2b-worker.js）要配合的規格

網頁 `xintea-b2b.html`（v2026-11-17-2）送到 Firestore `xintea_b2b_jobs` 的工作與欄位。
工作程式不在這個 repo，以下是它要支援的變更。

## 1. 搜尋新訂單（`type: 'scanNew'`）開單範圍

工作文件多了 `arriveTo`（`YYYY-MM-DD`）：**最早到貨日在這天（含）以前**的未列印生產單才開單。

- 預設今天＋10 天（Jay 2026-11-17：原則 10 天；大單需要更長製作期、或遇到國定假日時，在回報頁把截止日往後拉）。
- 沒帶 `arriveTo` 時工作程式也用今天＋10 天。
- 按「確認建立」時（`apply: true`）帶同樣的 `arriveTo`。
- （v2026-11-17-2 曾用 `dateFrom`／`dateTo` 依訂單日期篩選，已改掉，工作程式不再讀這兩個欄位。）

## 2. 不管有沒有生產單、託運單，都建立資料

- 以前「EIP 還查不到的生產單」會跳過；現在要一樣放進 `result.plannedData`，並加上
  `missing: ['prod']`／`['ship']`／`['prod','ship']`。
- 網頁的「確認建立」按鈕會把有 `missing` 的也放進 `approve`（只排除 `trial` 和有 `noItem` 的）。
- 正式建立時照常建 SG 採購單、寫入 `xintea_b2b_po`；缺的單據跳過就好（沒有生產單就先用 BOM 估算）。
- 建立後把缺的單據寫到採購單文件：`missing: ['prod','ship']`（有缺才寫）。
- `result.createdMissing`：字串陣列，例如 `PO-0745 缺託運單`，網頁會另外列出來。

## 3. 缺單據顯示＋之後搜尋下載（新工作 `type: 'fetchDocs'`）

採購單文件（`xintea_b2b_po/{PO}`）欄位：

| 欄位 | 說明 |
|---|---|
| `missing` | `['prod','ship']` 的子集合；空陣列或沒有＝不缺 |
| `missingCheckedAt` | ISO 時間，最後一次搜尋的時間 |
| `docs` | 選填，`{prod:[{no,url}], ship:[{no,url}]}`，網頁會顯示成可點的連結 |

工作文件：

| 欄位 | 說明 |
|---|---|
| `pos` | 要找的採購單號陣列，例如 `['PO-0743']` |
| `need` | 選填，只找這幾種（`prod`／`ship`）；沒有就依各採購單的 `missing` |

工作程式要做的事：
1. 依採購單的 `prodNos` 到 EIP 找生產單、找託運單，找到就下載（生產單要解析用料寫回 `src[].mat`，託運單號寫回 `shipNos`）。
2. 找到的從 `missing` 移除，更新 `missingCheckedAt`，有檔案連結就寫 `docs`。
3. `result`：`found`（例如 `PO-0743 託運單 1234567890`）、`still`（例如 `PO-0718 缺生產單`）、`errors`，都是字串陣列。

## 實作狀態（b2b-worker-2026-11-17-5，2026-11-17）

- 以上 1～3 都已實作。
- 開單範圍用 `arriveTo`（最早到貨日截止日），見第 1 節；b2b-worker-2026-11-17-5 起。
- 「缺託運單」的判斷：配送大表找不到這張銷售訂單的配送單，或有配送單但「物流單下載連結」是空的。物流方式是 Lalamove／專車／自取的，本來就沒有託運單，不算缺。
- 缺生產單時：料號、數量、客製說明先用生產單大表的資料；不寫 `src[].mat`（用料分頁會改用 BOM 估算）；不印生產單、不回填列印日期。
- `fetchDocs` 找到生產單時：補 `src[].mat`／`matNote`，**印出生產單並回填列印日期**；數量和系統不同時不自動改，只加 `alerts`（卡片亮紅條）。
- `fetchDocs` 找到託運單時：寫 `shipNos`、`docs.ship`（Drive 連結）；託運單**不自動列印**（黑貓要先放厚紙）。
