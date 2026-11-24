// 重拋單（規格第 11 節）的測試：假 Firestore＋真的 xlsx，跑 b2c-start.js 的 handleRethrows
// 用法：node test-rethrow.js <放 b2c-start.js 的資料夾>
// 物流表欄位照 Jay 給的 物流表B2C_20261123_151536.xlsx（24 欄；單號開頭有 #；心茶訂單key值的 -N 是第幾個品項）
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const SRC_DIR = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rethrow-'));
process.chdir(TMP);
fs.mkdirSync('bin'); fs.writeFileSync('bin/py', '#!/bin/sh\n[ "$1" = "-3" ] && shift\nexec python3 "$@"\n', { mode: 0o755 });
process.env.PATH = path.join(TMP, 'bin') + ':' + process.env.PATH;
const DL = path.join(TMP, 'DL');

let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-start.js'), 'utf8');
src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(TMP)};`);
fs.writeFileSync(path.join(TMP, 'b2c-start.under-test.js'), src);

const H = ['單號', '訂單日期', '收件人', '收件人電話', '收件人地址', '收件人Email', '付款方式', '物流方式', '訂單備註', '訂單金額', '發票抬頭', '統一編號',
  '商品編號', '商品名稱', '數量', '小計', '單位', '明細備註', '寄件人', '寄件人電話', '心茶訂單key值', '最早可出廠日', '生產廠商', '訂單狀態'];
// R(單號, 數量, 料號, 地址, 狀態, 第幾品項, 備註)：單號不帶 #，這裡補上（跟真的物流表一樣）
const R = (no, qty, sku, addr, st, n, note) => ['#' + no, '2026-11-08', '林小姐', '958710211', addr || 'TW 300 新竹市北區湳雅街216號4樓', null, 'SHOP', '黑貓宅配 (常溫)',
  note || '指定出貨日：11/30', 1, null, null, sku || 'A020011', '【蜜香風味選】茶主題綜合茶包4入', qty, null, null, null, '心茶', '03-8', '#' + String(no).replace(/-\d+$/, '') + '-' + (n || 1), '2026-11-30', '俬儲空間', st || '新增'];
function xlsx(rel, rows) {
  const f = path.join(DL, rel); fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('python3', ['-c', `import openpyxl,json,sys
wb=openpyxl.Workbook(); ws=wb.active
for r in json.loads(sys.argv[2]): ws.append(r)
wb.save(sys.argv[1])`, f, JSON.stringify([H, ...rows])]);
  return f;
}
const readNos = (f) => JSON.parse(execFileSync('python3', ['-c', `import openpyxl,json,sys
ws=openpyxl.load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([str(r[0]) for r in ws.iter_rows(min_row=2,values_only=True) if r[0]]))`, f]).toString());

// 假 Firestore：只有 where().get()
let JOBS = [];
const db = { collection: () => { const q = (fl) => ({ where: (f, o, v) => q(fl.concat([[f, v]])),
  get: async () => ({ docs: JOBS.filter((j) => fl.every(([f, v]) => j[f] === v)).map((j) => ({ id: j.id, data: () => j })) }) }); return q([]); } };
const S = require(path.join(TMP, 'b2c-start.under-test.js'))({ db, COL_JOB: 'jobs' });
const T = S._test;
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };
// 跟真的一樣：碰到 undefined 同步丟錯（規格第 12 節；原本 async () => {} 什麼都收）
const { noUndefined } = require('./firestore-strict');
const ref = { id: 'cur', update: (o) => { noUndefined(o, 'Update()'); return Promise.resolve(); } };
const log = async () => {};
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const prevJob = (id, mmdd, file) => ({ id, type: 'b2cStart', status: 'done', mmdd, createdAt: ago(5), result: { mmdd, steps: { '整單': { file } } } });
const BASE = '20261108143031221';
const ROWS = [{ key: `#${BASE}-1`, st: '訂單刪除' }, { key: `#${BASE}-2`, st: '新增' }, { key: '#20261120000000001-1', st: '新增' }];
let n = 0;
async function run(name, { prevRows, ship, answer, dryRun, cur }) {
  n++;
  JOBS = [];
  if (prevRows) { xlsx(`心茶112${n}/物流表B2C_prev${n}-3.xlsx`, prevRows); JOBS.push(prevJob('p' + n, '112' + n, `心茶112${n}/物流表B2C_prev${n}-3.xlsx`)); }
  if (ship) JOBS.push({ id: 's' + n, type: 'b2cShip', status: 'done', mmdd: '112' + n });
  const full = xlsx(`心茶1130/物流表B2C_cur${n}.xlsx`, cur || [R(BASE, 150), R('20261120000000001', 2, 'AA00376')]);
  const logi = { full, fileRows: (cur || [1, 2]).length, rethrows: T.findRethrows(ROWS) };
  let asked = null;
  const askFn = async (r, l, q) => { asked = q; const v = typeof answer === 'number' ? q.options[answer] : answer; return { value: v, by: '測試' }; };
  try { const out = await T.handleRethrows(ref, log, logi, { dryRun: !!dryRun, stamp: 'T' + n }, askFn); return { out, asked, logi, nos: readNos(full), full }; }
  catch (e) { return { err: e.message, asked, nos: readNos(full) }; }
}

// 跑真的 b2c-start.js 第 1 段（試跑）：假 BPM（page.evaluate）、假本機服務（fetch）、嚴格的假 Firestore
// 回傳 BPM 物流表那一步最後寫進 partial 的內容
async function runStart(logiRows) {
  const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 跟 b2c-start.js 的 todayYMD() 一樣（台北日期）
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  const XT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sumFile = xlsx(`_bpm/summary${++n}.xlsx`, [R('1', 1)]);
  const logiFile = xlsx(`_bpm/logi${n}.xlsx`, logiRows);
  const page = { url: () => 'https://xintea.jwcpas.com.tw/xin_tea/common/main_menu',
    evaluate: async (fn, arg) => {
      if (!arg) return true;   // bpmOk
      if (arg.download === 'summary') return { rows: Array.from({ length: 3000 }, (_, i) => ({ key: '#s' + i + '-1', vc: 0, st: '新增', date: ymd })), file: { name: '_20261124_102500.xlsx', type: XT, b64: b64(sumFile) } };
      if (arg.download === 'logistics') return { rows: logiRows.map((r) => ({ auto: 1, key: r[20], vc: 0, st: r[23], date: ymd })), file: { name: '_20261124_102526.xlsx', type: XT, b64: b64(logiFile) } };
      return { rows: [] };
    } };
  const docs = {};
  const sref = { id: 'start' + n, update: (o) => { noUndefined(o, 'Update()'); Object.assign(docs, JSON.parse(JSON.stringify(o))); return Promise.resolve(); } };
  const W = { db, COL_JOB: 'jobs', browser: async () => ({ pages: () => [page], newPage: async () => { throw new Error('測試沒有瀏覽器'); } }),
    pageFor: async () => { throw new Error('測試沒有瀏覽器'); }, sgReady: async () => { throw new Error('測試沒有 SG'); }, eipReady: async () => { throw new Error('測試沒有 EIP'); } };
  const S2 = require(path.join(TMP, 'b2c-start.under-test.js'))(W);
  const realFetch = global.fetch;
  global.fetch = async (u, o) => (String(u).startsWith('http://127.0.0.1:8080') ? { json: async () => ({ ok: true, version: 'fake' }) } : realFetch(u, o));
  JOBS = [];
  let err = null;
  try { await S2.handlers.b2cStart(sref, { type: 'b2cStart', label: '上午', dryRun: true }, async () => {}); } catch (e) { err = e.message; }
  global.fetch = realFetch;
  return { st: ((docs.partial || {}).steps || {})['BPM 物流表'], err };
}

(async () => {
  const rt = T.findRethrows(ROWS);
  check('認出重拋單（-1 訂單刪除＋-2 新增）', rt.length === 1 && rt[0].base === BASE, JSON.stringify(rt));
  check('只有刪除、沒有新的那列不算重拋', T.findRethrows([{ key: '#9-1', st: '訂單刪除' }]).length === 0);

  let r = await run('new', {});
  check('之前沒下載過：照常整單，檔案不動（單號帶 #）', r.out && r.out.orders[0].case === 'new' && r.nos.length === 2 && r.nos.includes('#' + BASE), JSON.stringify(r.nos));

  r = await run('a', { prevRows: [R(BASE, 150)], cur: [R(BASE, 150, null, null, '新增', 2, '指定出貨11/30 婚宴使用'), R('20261120000000001', 2, 'AA00376')] });
  check('內容沒變、只有備註改（11/23 這張）：只確認，從這次物流表拿掉', r.out && r.out.orders[0].case === 'a' && !r.nos.includes('#' + BASE) && r.nos.length === 1 && !r.asked, JSON.stringify(r.nos));
  check('改之前有備份', fs.existsSync(path.join(path.dirname(r.full), '_重拋前備份')));
  check('批次確認要對的列數跟著減 1', r.logi.fileRows === 1, `fileRows=${r.logi && r.logi.fileRows}`);

  r = await run('a-only', { prevRows: [R(BASE, 150)], cur: [R(BASE, 150)] });
  check('拿掉以後沒有單：標成不用整單', r.logi && r.logi.empty === true);

  r = await run('b1', { prevRows: [R(BASE, 150)], cur: [R(BASE, 120), R('20261120000000001', 2, 'AA00376')], answer: 0 });
  check('數量 150→120、SG 還沒上傳：停下來問', r.asked && /數量：150 → 120/.test(r.asked.msg) && /無庫存/.test(r.asked.msg), r.asked && r.asked.msg.split('\n').slice(0, 2).join(' / '));
  check('選「舊版已移除」：新的照常整單、檔案不動', r.out && r.out.orders[0].case === 'b1' && r.nos.includes('#' + BASE));

  r = await run('b2', { prevRows: [R(BASE, 150)], ship: true, cur: [R(BASE, 150, 'A020012'), R('20261120000000001', 2, 'AA00376')], answer: 0 });
  check('換料號、第 2 段已跑過：問的選項要先到 SG 刪除', r.asked && /SG 刪除舊單/.test(r.asked.options[0]));
  check('新單號改成 -1（保留 #）', r.out && r.out.orders[0].sgOrderNo === BASE + '-1' && r.nos.includes('#' + BASE + '-1'), JSON.stringify(r.nos));

  r = await run('b2-again', { prevRows: [R(BASE + '-1', 150)], ship: true, cur: [R(BASE, 100), R('20261120000000001', 2, 'AA00376')], answer: 0 });
  check('SG 已經有 -1：改成 -2', r.out && r.out.orders[0].sgOrderNo === BASE + '-2' && r.nos.includes('#' + BASE + '-2'), JSON.stringify(r.nos));

  r = await run('skip', { prevRows: [R(BASE, 150)], cur: [R(BASE, 120), R('20261120000000001', 2, 'AA00376')], answer: 1 });
  check('選「這次先不整單」：從物流表拿掉', r.out && r.out.orders[0].case === 'skip' && !r.nos.includes('#' + BASE));

  r = await run('stop', { prevRows: [R(BASE, 150)], cur: [R(BASE, 120), R('20261120000000001', 2, 'AA00376')], answer: '停止' });
  check('選「停止」：丟錯（還沒批次確認），檔案不動', r.err && /停止/.test(r.err) && r.nos.length === 2, r.err);

  r = await run('dry', { prevRows: [R(BASE, 150)], cur: [R(BASE, 120), R('20261120000000001', 2, 'AA00376')], dryRun: true });
  check('試跑：不問、不改檔案', r.out && r.out.orders[0].case === 'dry' && !r.asked && r.nos.length === 2);

  r = await run('addr', { prevRows: [R(BASE, 150)], cur: [R(BASE, 150, null, '台北市'), R('20261120000000001', 2, 'AA00376')], answer: 1 });
  check('地址改了也算有改', r.asked && /地址/.test(r.asked.msg));

  // 多品項的單：舊的 3 個品項都刪除、新開 3 個，內容一樣
  r = await run('multi', { prevRows: [R(BASE, 15, 'AA00338', null, '新增', 1), R(BASE, 15, 'XX00004', null, '新增', 2), R(BASE, 1, 'YY000077', null, '新增', 3)],
    cur: [R(BASE, 15, 'XX00004', null, '新增', 5), R(BASE, 1, 'YY000077', null, '新增', 6), R(BASE, 15, 'AA00338', null, '新增', 4), R('20261120000000001', 2, 'AA00376')] });
  check('多品項重拋（順序不同、內容一樣）：只確認', r.out && r.out.orders[0].case === 'a' && r.nos.length === 1, JSON.stringify(r.nos));

  // 從檔案拿掉「訂單狀態」含刪除的列
  const f = xlsx('心茶1130/物流表B2C_drop.xlsx', [R(BASE, 150, null, null, '訂單刪除', 1), R(BASE, 150, null, null, '新增', 2), R('20261120000000001', 2, 'AA00376', null, '品項刪除'), R('20261120000000002', 3, 'AA00377')]);
  const e = await T.editOrders(f, { dropDeleted: true }, 'D');
  const e2 = await T.editOrders(f, { remove: [BASE] }, 'D');
  const bk = path.join(path.dirname(f), '_重拋前備份', '物流表B2C_drop-重拋前-D.xlsx');
  check('拿掉訂單刪除、品項刪除的列', e.dropped === 2 && e.left === 2, JSON.stringify(e));
  check('同一次改兩遍，備份是最原始的那份', readNos(bk).length === 4 && readNos(f).length === 1, `備份 ${readNos(bk).length} 列、現在 ${readNos(f).length} 列`);

  // 第 12 節（11/24 10:25）：物流表沒有刪除列，跑完整的第 1 段到「BPM 物流表」，寫 partial 不能有 undefined
  {
    const lg = await runStart([R('20261120000000011', 2, 'AA00376'), R('20261120000000012', 1, 'A020011')]);
    check('物流表沒有刪除列：BPM 物流表步驟成功', lg.st && lg.st.ok === true, lg.st ? JSON.stringify(lg.st) : lg.err);
    check('物流表沒有刪除列：沒有 undefined 寫入錯誤', !/undefined/.test(lg.err || '') && !/undefined/.test(JSON.stringify(lg.st || {})), lg.err);
    check('物流表沒有刪除列：deleted、rethrows 記 0', lg.st && lg.st.deleted === 0 && lg.st.rethrows === 0, lg.st && `deleted=${lg.st.deleted} rethrows=${lg.st.rethrows}`);
  }
  {
    const lg = await runStart([R(BASE, 150, null, null, '訂單刪除', 1), R('20261120000000011', 2, 'AA00376')]);
    check('物流表有刪除列：BPM 物流表步驟成功、deleted=1', lg.st && lg.st.ok === true && lg.st.deleted === 1, lg.st ? JSON.stringify(lg.st) : lg.err);
  }

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  process.chdir(os.tmpdir());   // Windows 不能刪自己所在的資料夾
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
