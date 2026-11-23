// 禮盒工具增加數（逐筆帳本）的回歸測試：從 xintea-giftbox.html 取出比對核心，用假快照跑各種情況
// 用法：node test-giftbox-ledger.js [xintea-giftbox.html 路徑]
// 看的是「採購單會請購多少」（每一組的 inc 加總）和「紅框會出現多少減少」（dec 加總）
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = path.resolve(process.argv[2] || path.join(__dirname, '..', 'xintea-giftbox.html'));
const html = fs.readFileSync(HTML, 'utf8');
const from = html.indexOf('function itemsForThreshold('), to = html.indexOf('// ---------- Parse xlsx ----------');
const fromB = html.indexOf('function baseOrderNo(');
const toB = html.indexOf('\n}\n', fromB) + 3;
if (from < 0 || to < 0 || fromB < 0) throw new Error('找不到比對核心的程式碼');
const code = 'var snapshots = [];\n' + html.slice(from, to) + '\n' + html.slice(fromB, toB) +
  '\n;this.run = (s) => { snapshots = s; _ledgerCache = { sig: null, pairs: null }; return s.slice(1).map((x, i) => pairDelta(s[i], x)); };';
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);

// ---- 假資料 ----
let t = 0;
// lines: [key, sku, qty, permitDate, status]；orderNo 從 key 拿（#單號-N → 單號）
function snap(date, shipTo, lines, extra) {
  return Object.assign({ date, shipTo, uploadedAt: `${date}T${String(10 + (t++ % 10)).padStart(2, '0')}:00:${String(t).padStart(2, '0')}Z`,
    rawLines: lines.map(([key, sku, qty, permitDate, status, orderNo]) => ({ key, sku, name: sku, qty, permitDate, status: status || '新增',
      orderNo: orderNo || String(key).replace(/^#/, '').replace(/-\d+$/, '') })) }, extra || {});
}
const sum = (pairs, side, sku) => pairs.reduce((a, p) => a + (p[side][sku] || 0), 0);
const results = [];
function check(name, snaps, sku, wantInc, wantDec) {
  const pairs = ctx.run(snaps);
  const inc = sum(pairs, 'inc', sku), dec = sum(pairs, 'dec', sku);
  const ok = inc === wantInc && dec === wantDec;
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}：請購 ${inc}（應 ${wantInc}）、紅框減少 ${dec}（應 ${wantDec}）`);
}
const BASE = [['#900-1', 'X', 1, '2026-11-17']];   // 帳本起點那一筆

// ---- 天數變化 ----
check('天數 14→3→14→3，訂單都在 11/25：只請購一次', [
  snap('2026-11-16', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-17', '2026-11-20', [...BASE]),
  snap('2026-11-18', '2026-12-02', [...BASE, ['#100-1', 'A', 10, '2026-11-25']]),
  snap('2026-11-19', '2026-11-22', [...BASE, ['#100-1', 'A', 10, '2026-11-25']]),
  snap('2026-11-20', '2026-12-04', [...BASE, ['#100-1', 'A', 10, '2026-11-25']]),
], 'A', 10, 0);
check('天數 3→14：範圍外的訂單進到範圍才請購', [
  snap('2026-11-16', '2026-11-19', BASE, { isBaseline: true }),
  snap('2026-11-17', '2026-11-20', [...BASE, ['#101-1', 'A', 5, '2026-11-28']]),
  snap('2026-11-18', '2026-12-02', [...BASE, ['#101-1', 'A', 5, '2026-11-28']]),
], 'A', 5, 0);
check('天數 14→3：範圍外的不算減少', [
  snap('2026-11-16', '2026-11-19', BASE, { isBaseline: true }),
  snap('2026-11-17', '2026-12-01', [...BASE, ['#102-1', 'A', 5, '2026-11-28']]),
  snap('2026-11-18', '2026-11-21', [...BASE, ['#102-1', 'A', 5, '2026-11-28']]),
], 'A', 5, 0);
check('起點抓 14 天、下一次 3 天：交集外的之後進到範圍要請購', [
  snap('2026-11-16', '2026-11-30', [...BASE, ['#103-1', 'A', 7, '2026-11-25']], { isBaseline: true }),
  snap('2026-11-17', '2026-11-20', [...BASE, ['#103-1', 'A', 7, '2026-11-25']]),
  snap('2026-11-22', '2026-11-26', [...BASE, ['#103-1', 'A', 7, '2026-11-25']]),
], 'A', 7, 0);

// ---- 重拋單（11/23 #20261108143031221）----
check('重拋：同一份總表看到 -1 刪除、-2 新增，數量一樣', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#221-1', 'A020011', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#221-1', 'A020011', 150, '2026-11-20', '訂單刪除'], ['#221-2', 'A020011', 150, '2026-11-24']]),
], 'A020011', 150, 0);
check('重拋：上午只看到 -1 刪除，下午才看到 -2 新增', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#222-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#222-1', 'A', 150, '2026-11-20', '訂單刪除']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#222-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#222-2', 'A', 150, '2026-11-24']]),
], 'A', 150, 0);
check('重拋：數量 150→120，只算減少 30', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#223-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#223-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#223-2', 'A', 120, '2026-11-24']]),
], 'A', 150, 30);
check('重拋：數量 150→200，只多請購 50', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#224-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#224-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#224-2', 'A', 200, '2026-11-24']]),
], 'A', 200, 0);
check('重拋：換料號 A→B，A 減少、B 請購', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#225-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#225-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#225-2', 'B', 150, '2026-11-24']]),
], 'A', 150, 150);
check('重拋：新的那列在範圍外，之後進到範圍也不再請購', [
  snap('2026-11-20', '2026-11-25', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-25', [...BASE, ['#226-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-25', [...BASE, ['#226-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#226-2', 'A', 150, '2026-11-28']]),
  snap('2026-11-25', '2026-11-30', [...BASE, ['#226-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#226-2', 'A', 150, '2026-11-28']]),
], 'A', 150, 0);
check('重拋：舊的從來沒算過（一直在範圍外），新的照常請購', [
  snap('2026-11-20', '2026-11-22', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-22', [...BASE, ['#227-1', 'A', 150, '2026-11-28']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#227-1', 'A', 150, '2026-11-28', '訂單刪除'], ['#227-2', 'A', 150, '2026-11-28']]),
], 'A', 150, 0);
check('拆單重拋：644 刪除 → 644A 100 ＋ 644B 50', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#644-1', 'A', 150, '2026-11-20', '新增', '644']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#644-1', 'A', 150, '2026-11-20', '訂單刪除', '644'], ['#644A-1', 'A', 100, '2026-11-24', '新增', '644A'], ['#644B-1', 'A', 50, '2026-11-24', '新增', '644B']]),
], 'A', 150, 0);
check('真的取消（沒有新的那列）：照樣算減少', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#228-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#228-1', 'A', 150, '2026-11-20', '訂單刪除']]),
], 'A', 150, 150);
check('不同訂單同料號：一張刪除、另一張新增，不能互抵', [
  snap('2026-11-20', '2026-11-30', BASE, { isBaseline: true }),
  snap('2026-11-21', '2026-11-30', [...BASE, ['#229-1', 'A', 150, '2026-11-20']]),
  snap('2026-11-23', '2026-11-30', [...BASE, ['#229-1', 'A', 150, '2026-11-20', '訂單刪除'], ['#330-1', 'A', 150, '2026-11-24']]),
], 'A', 300, 150);

const bad = results.filter((x) => !x).length;
console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
process.exit(bad ? 1 : 0);
