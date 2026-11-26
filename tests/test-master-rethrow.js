// shipment.html 廠商總表「重開單」判斷（pickLiveRows，v2026-11-26-130）
// 用法：node test-master-rethrow.js <shipment.html 所在資料夾> [廠商訂單確認_xxx.xlsx（選填，用真實總表統計）]
// 情境：心茶改訂單時，舊的列標「訂單刪除」、同一個電商單號再拋新的列（#20261108143031221，2026-11-26 被當成取消、第 2 段停下來）。
// 訂單key值的 -N 是第幾個品項，不是第幾版，所以用拋轉時間分新舊。
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const html = fs.readFileSync(path.join(path.resolve(process.argv[2]), 'shipment.html'), 'utf8');
const grab = (re, what) => { const m = html.match(re); if (!m) throw new Error('shipment.html 找不到 ' + what); return m[0]; };
const code = [
  grab(/const CANCEL_STATUSES = \[.*?\];/, 'CANCEL_STATUSES'),
  grab(/const ITEM_LEVEL_ISSUE_STATUSES = \[.*?\];/, 'ITEM_LEVEL_ISSUE_STATUSES'),
  grab(/const CLOSED_STATUSES = \[.*?\];/, 'CLOSED_STATUSES'),
  grab(/function pickLiveRows\(entries\)\{[\s\S]*?\n\}/, 'pickLiveRows'),
].join('\n');
const { pickLiveRows } = new Function(code + '\nreturn { pickLiveRows };')();

let fail = 0;
const ok = (c, msg) => { console.log((c ? '✅ ' : '❌ ') + msg); if (!c) fail++; };
const E = (st, tt, sku) => ({ st, tt, sku });

// 1. 今天這張：-1 訂單刪除（11/09）、-2 異動（11/23）→ 重開單，只用 -2
let r = pickLiveRows([E('訂單刪除', '2026-11-09 09:31:24', 'A020011'), E('異動', '2026-11-23 13:03:36', 'A020011')]);
ok(r.rethrow && r.rows.length === 1 && r.rows[0].st === '異動', '20261108143031221：訂單刪除＋之後的異動 → 重開單，只用新的那列');

// 2. 真的整張取消：只有刪除列
r = pickLiveRows([E('訂單刪除', '2026-11-09 09:31:24'), E('訂單刪除', '2026-11-09 09:31:24')]);
ok(!r.rethrow && r.rows.length === 2, '只有刪除列 → 照舊（取消）');

// 3. 訂單刪除＋同時間的品項刪除（#20260708023806644）→ 整張刪除，不算重開
r = pickLiveRows([E('訂單刪除', '2026-07-15 09:54'), E('訂單刪除', '2026-07-15 09:54'), E('品項刪除', '2026-07-15 09:54'), E('訂單刪除', '2026-07-15 09:54')]);
ok(!r.rethrow, '訂單刪除＋同時間的品項刪除 → 不算重開');

// 4. 刪除＋之後結案（#20260521012402822）→ 重開單，新的列是結案
r = pickLiveRows([E('刪除', '2026-05-26 15:38'), E('刪除', '2026-05-26 15:22'), E('結案', '2026-05-26 15:39'), E('結案', '2026-05-26 15:39')]);
ok(r.rethrow && r.rows.length === 2 && r.rows.every((e) => e.st === '結案'), '刪除＋之後結案 → 重開單，用結案的列');

// 5. 舊版的品項刪除要丟掉、新版的品項刪除要留（#20260806104921451）
r = pickLiveRows([E('訂單刪除', '2026-08-07 09:27'), E('品項刪除', '2026-08-07 09:27'), E('訂單刪除', '2026-08-07 09:27'),
  E('品項刪除', '2026-08-17 16:41'), E('結案', '2026-08-17 17:22'), E('結案', '2026-08-17 17:22'), E('結案', '2026-08-17 20:31'), E('結案', '2026-08-18 09:39')]);
ok(r.rethrow && r.rows.length === 5 && r.rows.filter((e) => e.st === '品項刪除').length === 1, '舊版的品項刪除丟掉、新版的留下');

// 6. 新列只有品項刪除（沒有真正的新版）→ 不算重開
r = pickLiveRows([E('訂單刪除', '2026-08-07 09:27'), E('品項刪除', '2026-08-10 10:00')]);
ok(!r.rethrow, '刪除之後只有品項刪除 → 不算重開');

// 7. 刪除列比其他列晚（先有新增、後來整張刪）→ 取消
r = pickLiveRows([E('新增', '2026-11-01 09:00'), E('訂單刪除', '2026-11-05 09:00')]);
ok(!r.rethrow, '新增之後才刪除 → 照舊（取消）');

// 8. 拋轉時間缺漏 → 保守，照舊
r = pickLiveRows([E('訂單刪除', ''), E('異動', '2026-11-23 13:03:36')]);
ok(!r.rethrow, '刪除列沒有拋轉時間 → 照舊（取消）');

// 9. 沒有刪除列 → 原封不動
const plain = [E('新增', '2026-11-13 09:28'), E('新增', '2026-11-13 09:28')];
r = pickLiveRows(plain);
ok(!r.rethrow && r.rows === plain, '沒有刪除列 → 原封不動');

// 10. 異動刪除＋訂單刪除同時間、之後結案（#20260815084322257）
r = pickLiveRows([E('異動刪除', '2026-08-17 09:59'), E('訂單刪除', '2026-08-17 09:59'), E('訂單刪除', '2026-08-17 09:59'), E('異動刪除', '2026-08-17 09:59'),
  E('結案', '2026-08-18 09:39'), E('結案', '2026-08-18 09:39')]);
ok(r.rethrow && r.rows.length === 2, '異動刪除＋訂單刪除，之後結案 → 重開單');

// 選填：真實總表，看還沒結案的重開單有哪些、整張取消有幾張
if (process.argv[3]) {
  const rows = JSON.parse(execFileSync('python', ['-c', `import openpyxl,json,sys
ws=openpyxl.load_workbook(sys.argv[1],read_only=True).worksheets[0]
rows=[['' if x is None else str(x) for x in r] for r in ws.iter_rows(values_only=True)]
sys.stdout.reconfigure(encoding='utf-8'); print(json.dumps(rows,ensure_ascii=False))`, process.argv[3]], { maxBuffer: 1 << 28 }).toString('utf8'));
  const h = rows[0].map((x) => x.trim()), io = h.indexOf('電商平台訂單單號'), ist = h.indexOf('訂單狀態'), itt = h.indexOf('拋轉時間');
  const g = {};
  for (const row of rows.slice(1)) { const no = String(row[io] || '').replace(/^#/, '').split('-')[0]; if (no) (g[no] = g[no] || []).push(E(row[ist].trim(), row[itt].trim())); }
  let re = 0, cancel = 0; const open = [];
  const CANCEL = ['刪除', '訂單刪除', '異動刪除'];
  for (const [no, es] of Object.entries(g)) {
    const p = pickLiveRows(es);
    if (p.rethrow) { re++; if (!p.rows.some((e) => e.st === '結案')) open.push(no); }
    else if (p.rows.some((e) => CANCEL.includes(e.st))) cancel++;
  }
  console.log(`真實總表：${Object.keys(g).length} 張單；重開單 ${re} 張（還沒結案：${open.join('、') || '無'}）；仍算取消 ${cancel} 張`);
  ok(open.includes('20261108143031221'), '真實總表：20261108143031221 判成重開單');
}

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過');
process.exit(fail ? 1 : 0);
