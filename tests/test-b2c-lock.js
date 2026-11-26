// B2C 採購單「全部接收、全部入庫」→ 標記為已完成（2026-11-26）：假 SG，跑真的 b2c-ship.js 的 stockIn、b2cLockSweep
// 用法：node test-b2c-lock.js <放 b2c-ship.js 的資料夾>
// 不連 SG、不動真的資料夾（DL 換成暫存資料夾）。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const SRC_DIR = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b2clock-'));
let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-ship.js'), 'utf8');
src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(path.join(TMP, 'DL'))};`);
const file = path.join(TMP, 'b2c-ship.under-test.js');
fs.writeFileSync(file, src);

let fail = 0;
const ok = (c, msg, info) => { console.log((c ? '✅ ' : '❌ ') + msg + (info ? '（' + info + '）' : '')); if (!c) fail++; };

// ---- 假 SG：採購單清單＋明細；stock_in 會把 in_stock 補到 received；sgUpdate(lock) 把 status 改 0 ----
const today = new Date(); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 10:00:00`;
const P = (id, po, ref, products, extra) => Object.assign({ id, po_id: po, vendor_reference: ref, status: 1, date_purchased: ymd, products }, extra || {});
const L = (isku, quantity, received, in_stock) => ({ id: isku + '-l', item_id: 1, isku, quantity, received, in_stock, unit_quantity: 1, rack_group_ids: [], cost: '0' });
let POS, calls;
function reset() {
  calls = { stockIn: [], lock: [] };
  POS = [
    P(101, 761, '2026-11-17心茶B2C增製作禮盒(補)', [L('AA00376', 10, 10, 10), L('AA00160', 5, 5, 5)]),          // 已全部入庫 → 鎖
    P(102, 762, '2026-11-24心茶B2C增製作禮盒', [L('AA00376', 10, 10, 6)]),                                       // 已接收、入庫 6 → 入庫後鎖
    P(103, 763, '2026-11-25心茶B2C增製作禮盒', [L('AA00376', 10, 8, 8)]),                                        // 收不滿 → 不鎖
    P(104, 764, '2026-11-25心茶B2B禮盒', [L('AA00376', 10, 10, 0)]),                                            // B2B → 不碰
    P(105, 765, '2026-11-20心茶B2C增製作禮盒', [L('AA00376', 3, 3, 3)], { status: 0 }),                        // 已鎖 → 不碰
    P(106, 640, '2026-08-01心茶B2C增製作禮盒', [L('AA00001', 2, 2, 2)], { date_purchased: '2026-08-01 10:00:00' }),  // 舊單（第 2 段不看、補做按鈕要看）
  ];
}
const byId = (id) => POS.find((p) => p.id === id);
const page = { evaluate: async (fn, a) => {
  const { method, url, body } = a;
  if (method === 'GET' && /^purchase_order\?/.test(url)) {
    const pg = Number((url.match(/page=(\d+)/) || [])[1] || 1), lim = Number((url.match(/limit=(\d+)/) || [])[1] || 20);
    const list = POS.slice().sort((x, y) => y.po_id - x.po_id).slice((pg - 1) * lim, pg * lim).map(({ products, ...p }) => p);
    return { status: 200, ok: true, json: { response: { data: list } }, text: '' };
  }
  let m = url.match(/^purchase_order\/(\d+)\/edit$/);
  if (method === 'GET' && m) { const p = byId(Number(m[1])); return { status: 200, ok: true, json: { response: { po_details: { status: p.status }, products: JSON.parse(JSON.stringify(p.products)) } }, text: '' }; }
  if (method === 'POST' && url === 'stock_adjustment/stock_in') {
    const p = byId(body.dataSource.id); calls.stockIn.push(p.po_id);
    body.products.forEach((x) => { const l = p.products.find((y) => y.isku === x.isku); l.in_stock += x.quantity_changed; });
    return { status: 200, ok: true, json: { response: { status: true, errors: {}, stock_adjustment_data: { sa_id: 1 } } }, text: '' };
  }
  throw new Error('假 SG 不認得 ' + method + ' ' + url);
} };
const W = {
  db: {}, COL_JOB: 'jobs', pageFor: async () => page, sgReady: async () => page,
  sgUpdate: async (pg, id, { lock }) => { const p = byId(id); if (p.status === 0) throw new Error('SG 採購單已經鎖定（已完成），不能再改'); if (lock) { p.status = 0; calls.lock.push(p.po_id); } return { changed: true, locked: p.status === 0 }; },
};
const S = require(file)(W);
const T = S._test || {};
const logs = []; const log = async (s) => { logs.push(s); };

(async () => {
  // ---- 純函式 ----
  ok(typeof T.poFullyStocked === 'function', '有 poFullyStocked');
  if (T.poFullyStocked) {
    ok(T.poFullyStocked([L('A', 10, 10, 10)]), '接收＝入庫＝採購 → 可以結案');
    ok(!T.poFullyStocked([L('A', 10, 10, 9)]), '入庫少一個 → 不結案');
    ok(!T.poFullyStocked([L('A', 10, 9, 9)]), '接收少一個 → 不結案');
    ok(!T.poFullyStocked([]), '沒有品項 → 不結案');
    ok(!T.poFullyStocked([L('A', 0, 0, 0)]), '採購數量 0 → 不結案');
    ok(!T.poFullyStocked([L('A', 10, 11, 11)]), '接收比採購多 → 不結案');
    ok(T.poNotDoneWhy([L('A', 10, 8, 8)])[0] === 'A 已接收 8/10', '原因：已接收 8/10');
  }

  // ---- 第 2 段 stockIn：入庫完順便結案 ----
  reset(); logs.length = 0;
  const r = await T.stockIn(page, log, false);
  ok(calls.stockIn.join() === '762', '只有 PO-0762 需要入庫', calls.stockIn.join());
  ok(calls.lock.sort().join() === '761,762', '結案 PO-0761（本來就入好）、PO-0762（剛入完）', calls.lock.join());
  ok(!calls.lock.includes(763), '收不滿的 PO-0763 不結案');
  ok(!calls.lock.includes(764), 'B2B 的 PO-0764 不碰');
  ok(!calls.lock.includes(640), '14 天前的 PO-0640 第 2 段不看');
  ok((r.locked || []).length === 2 && (r.lockErrors || []).length === 0, '結果有 locked 2 張、沒有錯誤');

  // 試跑：不入庫、不結案
  reset(); logs.length = 0;
  const rd = await T.stockIn(page, log, true);
  ok(calls.stockIn.length === 0 && calls.lock.length === 0, '試跑不入庫、不結案');
  ok((rd.locked || []).some((x) => x.po === 761 && x.dryRun), '試跑會列出 PO-0761 正式跑會結案');

  // 鎖單失敗不影響第 2 段
  reset(); logs.length = 0;
  const realUpd = W.sgUpdate; W.sgUpdate = async () => { throw new Error('SG 更新失敗 500'); };
  let threw = null; let rf;
  try { rf = await T.stockIn(page, log, false); } catch (e) { threw = e; }
  W.sgUpdate = realUpd;
  ok(!threw, '鎖單失敗時 stockIn 不丟錯（出貨流程照常）', threw && threw.message);
  ok(rf && rf.lockErrors.length === 2 && /500/.test(rf.lockErrors[0]), '鎖單失敗記在 lockErrors');

  // ---- 補做按鈕 b2cLockSweep ----
  ok(typeof S.b2cLockSweep === 'function', '有 b2cLockSweep 工作');
  reset(); logs.length = 0;
  POS.find((p) => p.po_id === 762).products[0].in_stock = 10;   // 假設已經入完
  const pv = await S.b2cLockSweep({}, {}, log);
  ok(calls.lock.length === 0, '預覽不改 SG');
  ok(pv.ready.map((x) => x.po).sort().join() === '640,761,762', '預覽：可以結案 640、761、762（含 14 天前的舊單）', pv.ready.map((x) => x.po).join());
  ok(pv.notDone.length === 1 && pv.notDone[0].po === 763 && /8\/10/.test(pv.notDone[0].why[0]), '預覽：763 收不滿，列出原因');
  ok(!pv.ready.concat(pv.notDone).some((x) => x.po === 764 || x.po === 765), '預覽不含 B2B、已鎖的單');

  // 確認：只鎖勾選的、再檢查一次
  POS.find((p) => p.po_id === 761).products[0].in_stock = 9;   // 預覽之後有人退庫
  const ap = await S.b2cLockSweep({}, { apply: true, pos: [761, 762, 763] }, log);
  ok(calls.lock.join() === '762', '確認：只鎖重新檢查仍符合的 762', calls.lock.join());
  ok(ap.notDone.map((x) => x.po).sort().join() === '761,763', '確認：761（入庫變少）、763 列為不符合');
  ok(!calls.lock.includes(640), '沒勾的 640 不鎖');

  let e2 = null; try { await S.b2cLockSweep({}, { apply: true, pos: [] }, log); } catch (e) { e2 = e; }
  ok(e2 && /沒有指定/.test(e2.message), '確認但沒帶 pos → 停下來');

  const ap2 = await S.b2cLockSweep({}, { apply: true, pos: [765] }, log);
  ok(ap2.errors.some((x) => /765/.test(x)), '指定已鎖的單 → 錯誤寫出「找不到或已經是已完成」');

  // 翻頁：超過 100 張也掃得到
  reset(); POS = [];
  for (let i = 0; i < 150; i++) POS.push(P(1000 + i, 1000 + i, '心茶B2C x', [L('A', 1, 1, 1)]));
  const big = await S.b2cLockSweep({}, {}, log);
  ok(big.ready.length === 150, '翻頁：150 張都掃到', big.ready.length);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail ? `\n❌ ${fail} 項失敗` : '\n✅ 全部通過');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
