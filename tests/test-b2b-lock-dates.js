// b2b-worker.js（2026-11-26）：
//  A. 找配送單用生產單大表「現在」的到貨日（withFreshDates）— PO-0747 建單 12/09、生產單大表現在 12/05，配送單 20261123-1 被判成不是這批
//  B. B2B 鎖單條件改成「已完成＋每個品項 SG 已接收＝採購數量」（b2bFullyReceived）
// 用法：node test-b2b-lock-dates.js <放 b2b-worker.js 的資料夾>
// 從 b2b-worker.js 抽出純函式跑（不啟動工作程式、不連網）。
'use strict';
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(path.resolve(process.argv[2]), 'b2b-worker.js'), 'utf8');
const one = (re, what) => { const m = src.match(re); if (!m) throw new Error('b2b-worker.js 找不到 ' + what); return m[0]; };
const fn = (name) => one(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`), name);
const code = [
  one(/const num = .*;/, 'num'), one(/const stripNo = .*;/, 'stripNo'), one(/const dateOf = .*;/, 'dateOf'),
  one(/const addDays = .*;/, 'addDays'), one(/const shortDate = .*;/, 'shortDate'), one(/const SHIP_PREFIX = .*;/, 'SHIP_PREFIX'),
  one(/const SHIP_DATE_BUFFER = .*;/, 'SHIP_DATE_BUFFER'), fn('batchRange'), one(/const rangeTxt = .*;/, 'rangeTxt'), fn('pickBatch'),
  fn('withFreshDates'), fn('b2bFullyReceived'),
].join('\n');
const F = new Function(code + '\nreturn { batchRange, pickBatch, withFreshDates, b2bFullyReceived };')();

let fail = 0;
const ok = (c, msg, info) => { console.log((c ? '✅ ' : '❌ ') + msg + (info ? '（' + info + '）' : '')); if (!c) fail++; };

// ---- A. PO-0747 ----
const src747 = [{ prodNo: '心茶禮盒生產單_代開-20261030-7', sku: 'AA00342', qty: 76, earliest: '2026-12-09', latest: '2026-12-11', mat: null }];
const rows = [{ no: '20261123-1', arrive: '2026-12-05', dateCol: true, prods: [] }];
const old = F.pickBatch(rows, F.batchRange(src747), [], 'PO-0747');
ok(old.keep.length === 0 && /12\/6～12\/11/.test(old.note), '舊日期（12/09）：20261123-1 被判成不在這批（重現問題）', old.note);
const pd = { '20261030-7': { earliest: '2026-12-05', latest: '2026-12-07' }, '20261101-2': { earliest: '2026-12-09', latest: '2026-12-11' } };
const fr = F.withFreshDates(src747, pd);
ok(fr.changes.length === 1 && fr.changes[0].prodNo === '20261030-7' && fr.changes[0].from === '12/9～12/11' && fr.changes[0].to === '12/5～12/7', '換成生產單大表現在的日期 12/5～12/7', JSON.stringify(fr.changes));
ok(fr.src[0].mat === null && fr.src[0].qty === 76 && fr.src[0].sku === 'AA00342', '其他欄位（用料、數量）不變');
ok(src747[0].earliest === '2026-12-09', '不改到原本的物件');
const now = F.pickBatch(rows, F.batchRange(fr.src), [], 'PO-0747');
ok(now.keep.map((r) => r.no).join() === '20261123-1', '新日期：找到配送單 20261123-1');

const same = F.withFreshDates(src747, { '20261030-7': { earliest: '2026-12-09', latest: '2026-12-11' } });
ok(same.changes.length === 0 && same.src[0] === src747[0], '日期沒變 → 原樣');
const none = F.withFreshDates(src747, {});
ok(none.changes.length === 0, '生產單大表查不到這張 → 照舊');
const noLatest = F.withFreshDates(src747, { '20261030-7': { earliest: '2026-12-05', latest: '' } });
ok(noLatest.src[0].earliest === '2026-12-05' && noLatest.src[0].latest === '2026-12-11', '大表沒有最晚到貨日 → 只換最早到貨日');
ok(F.withFreshDates(undefined, pd).src.length === 0, 'src 沒有 → 空陣列不報錯');

// 分批喜餅（江虹曄 5-14 的例子）照舊只留這一批
const jsrc = [{ prodNo: '心茶禮盒生產單_代開-20260910-7', earliest: '2026-11-25', latest: '2026-11-27' }];
const jrows = [{ no: '20261022-1', arrive: '2026-10-29', dateCol: true, prods: [] }, { no: '20261111-2', arrive: '2026-11-25', dateCol: true, prods: [] }];
const jk = F.pickBatch(jrows, F.batchRange(F.withFreshDates(jsrc, {}).src), [], 'PO-x');
ok(jk.keep.map((r) => r.no).join() === '20261111-2', '分批出貨照舊只留這一批');

// ---- B. 鎖單條件 ----
const L = [{ sku: 'AA00342', qty: 76 }, { sku: 'YY000077', qty: 76 }];
ok(F.b2bFullyReceived(L, { AA00342: 76, YY000077: 76 }), '每個品項 已接收＝採購數量 → 鎖');
ok(!F.b2bFullyReceived(L, { AA00342: 76, YY000077: 70 }), '有一項沒收滿 → 不鎖');
ok(!F.b2bFullyReceived(L, { AA00342: 76 }), '有一項沒有接收紀錄 → 不鎖');
ok(!F.b2bFullyReceived([], {}), '沒有品項 → 不鎖');
ok(!F.b2bFullyReceived([{ sku: 'A', qty: 0 }], { A: 0 }), '採購數量 0 → 不鎖');
ok(/if \(p\.status === 'done' && !sgLocked && fullRecv\)/.test(src), 'scanSG 鎖單只看「已完成＋已接收＝採購數量」，不再要求配送單寄出');
ok(/unsynced\(p\) \|\| \(p\.status === 'done' && !p\.sgLocked\)/.test(src), '啟動時已完成但沒鎖的單也排 scanSG');

console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過');
process.exit(fail ? 1 : 0);
