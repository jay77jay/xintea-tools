// 規格第 13 節：最早可出廠日區間、一個資料夾一個出廠日、資料夾命名（第 1 段 b2cStart）
// 用法：node test-shipdate.js <放 b2c-start.js 的資料夾>
// 跑真的 b2c-start.js 第 1 段：假 BPM（page.evaluate）、假本機服務、嚴格的假 Firestore（含自動回答 ask）、整單用假腳本。
// 只在暫存資料夾讀寫（DL、SCRIPT_DIR 都換掉），不連 BPM／SG／新竹，不送印。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const { noUndefined } = require('./firestore-strict');
const SRC_DIR = path.resolve(process.argv[2]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shipdate-'));

// ---- 日期：跟 b2c-start.js 一樣用台北日期 ----
const tw = (addDays) => new Date(Date.now() + 8 * 3600e3 + (addDays || 0) * 86400e3).toISOString().slice(0, 10);
const T0 = tw(0), T6 = tw(6), T7 = tw(7), T8 = tw(8);
const MD = (ymd) => ymd.slice(5, 7) + ymd.slice(8, 10);
const slash = (ymd) => ymd.replace(/-/g, '/');

// ---- 快轉時間（ask 每 3 秒查一次回答）----
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => setImmediate(fn);

// ---- 物流表（24 欄，跟真的一樣）----
const H = ['單號', '訂單日期', '收件人', '收件人電話', '收件人地址', '收件人Email', '付款方式', '物流方式', '訂單備註', '訂單金額', '發票抬頭', '統一編號',
  '商品編號', '商品名稱', '數量', '小計', '單位', '明細備註', '寄件人', '寄件人電話', '心茶訂單key值', '最早可出廠日', '生產廠商', '訂單狀態'];
const ROW = (no, date, st) => ['#' + no, '2026/11/20', '測試', '0912345678', '新北市汐止區測試路1號', null, 'Apple Pay', '7-11 取貨', null, '100', null, null,
  'A020011', '茶包', '1', null, null, null, '心茶', '03-8900198', '#' + no + '-1', slash(date), '俬儲空間', st || '新增'];
function xlsxB64(rows, tmp) {
  const f = path.join(tmp, 'bpm-' + Date.now() + Math.random().toString(36).slice(2) + '.xlsx');
  execFileSync('py', ['-3', '-c', `import openpyxl,json,sys
wb=openpyxl.Workbook(); ws=wb.active
for r in json.loads(sys.argv[2]): ws.append(r)
wb.save(sys.argv[1])`, f, JSON.stringify([H, ...rows])]);
  return fs.readFileSync(f).toString('base64');
}
const XT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---- 嚴格的假 Firestore ----
function fakeDb() {
  const docs = new Map(); let seq = 0;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mkRef = (id) => ({ id,
    get: async () => ({ exists: docs.has(id), id, data: () => clone(docs.get(id)) }),
    update: (o) => { noUndefined(o, 'Update()'); docs.set(id, Object.assign(docs.get(id) || {}, clone(o))); return Promise.resolve(); },
    set: (o) => { noUndefined(o, 'Set()'); docs.set(id, clone(o)); return Promise.resolve(); } });
  const query = (fl) => ({ where: (f, op, v) => query(fl.concat([[f, v]])),
    get: async () => ({ docs: [...docs.entries()].filter(([, d]) => fl.every(([f, v]) => d[f] === v)).map(([id, d]) => ({ id, data: () => clone(d), ref: mkRef(id) })) }) });
  return { docs, collection: () => Object.assign(query([]), { doc: (id) => mkRef(id),
    add: (o) => { noUndefined(o, 'Add()'); const id = 'd' + (++seq); docs.set(id, clone(o)); return Promise.resolve(mkRef(id)); } }) };
}

// ---- 跑一次第 1 段 ----
let n = 0;
async function run({ job = {}, rows = [], setup, decide, parent } = {}) {
  const dir = path.join(ROOT, 's' + (++n)); const DL = path.join(dir, 'DL'), SCR = path.join(dir, 'scripts');
  fs.mkdirSync(DL, { recursive: true }); fs.mkdirSync(SCR, { recursive: true });
  // 假整單：回報單數，不改檔
  fs.writeFileSync(path.join(SCR, 'xintea_zhengdan.py'), `import sys,json,openpyxl
ws=openpyxl.load_workbook(sys.argv[1]).worksheets[0]
nos=set(str(r[0]) for r in ws.iter_rows(min_row=2,values_only=True) if r[0])
print('RESULT_JSON: '+json.dumps({'orders':len(nos),'lines':len(nos),'宅配(自建單)':0,'outputs':[]}))`);
  if (setup) setup(DL);
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-start.js'), 'utf8');
  src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(SCR)};`);
  const file = path.join(dir, 'b2c-start.under-test.js'); fs.writeFileSync(file, src);

  const db = fakeDb(), logs = [], queries = [], confirmed = [], asked = [];
  const page = { url: () => 'https://xintea.jwcpas.com.tw/xin_tea/common/main_menu',
    evaluate: async (fn, arg) => {
      if (arg === undefined) return true;                                                   // bpmOk
      if (Array.isArray(arg)) { confirmed.push(arg.map((r) => r.key)); return { status: 200, text: '{"msg":"確認成功"}' }; }   // bpmBatchCheck
      if (arg.cond) {
        const c = arg.cond; queries.push({ from: c.dateFrom, to: c.dateTo, download: arg.download || null });
        if (arg.download === 'summary') return { rows: Array.from({ length: 3000 }, (_, i) => ({ key: '#s' + i + '-1', vc: 0, st: '新增', date: slash(T0) })), file: { name: '_20261124_100000.xlsx', type: XT, b64: xlsxB64([ROW('1', T0)], dir) } };
        const sel = rows.filter((r) => (!c.dateFrom || r[21].replace(/\//g, '-') >= c.dateFrom) && (!c.dateTo || r[21].replace(/\//g, '-') <= c.dateTo))
          .filter(() => !confirmed.length);   // 批次確認之後就不是待確認
        const out = { rows: sel.map((r, i) => ({ auto: i + 1, key: r[20], vc: 0, st: r[23], date: r[21] })), file: null };
        if (arg.download === 'logistics') out.file = { name: '_20261124_100100.xlsx', type: XT, b64: xlsxB64(sel, dir) };
        return out;
      }
      throw new Error('假 BPM 沒有這個呼叫');
    } };
  const W = { db, COL_JOB: 'jobs', browser: async () => ({ pages: () => [page], newPage: async () => { throw new Error('測試沒有瀏覽器'); } }),
    pageFor: async () => { throw new Error('測試沒有瀏覽器'); }, sgReady: async () => { throw new Error('測試沒有 SG'); }, eipReady: async () => { throw new Error('測試沒有 EIP'); } };
  delete require.cache[file];
  const S = require(file)(W);
  const realFetch = global.fetch;
  global.fetch = async (u) => { if (String(u).startsWith('http://127.0.0.1:8080')) return { json: async () => ({ ok: true, version: 'fake' }) }; throw new Error('測試不連網'); };
  if (parent) await db.collection().doc('p1').set(parent);
  const jobDoc = Object.assign({ type: 'b2cStart', status: 'running', label: '上午', mmdd: MD(T0) }, job);
  const ref = await db.collection().add(jobDoc);
  // 自動回答 ask
  let stop = false;
  (async () => {
    while (!stop) {
      const d = db.docs.get(ref.id);
      if (d && d.ask && !d.ask._seen) {
        d.ask._seen = true; asked.push(d.ask);
        db.docs.set('ans' + asked.length, { type: 'b2cAnswer', parent: ref.id, askId: d.ask.id, value: decide ? decide(d.ask) : '停止', by: '測試' });
      }
      await new Promise((r) => setImmediate(r));
    }
  })();
  let out = null, err = null;
  try { out = await S.handlers.b2cStart(ref, Object.assign({ id: ref.id }, jobDoc), async (m) => logs.push(m)); } catch (e) { err = e.message; }
  stop = true; global.fetch = realFetch;
  const R = out || (db.docs.get(ref.id) || {}).partial || {};
  const txt = (mmdd) => { try { return fs.readFileSync(path.join(DL, '心茶' + mmdd, '出廠日.txt'), 'utf8').trim(); } catch (e) { return null; } };
  return { R, err, logs, queries, confirmed, asked, DL, txt, jobDoc: db.docs.get(ref.id) };
}

const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };
const mkFolder = (DL, mmdd, ship, withMaster) => { const d = path.join(DL, '心茶' + mmdd); fs.mkdirSync(d, { recursive: true }); if (ship) fs.writeFileSync(path.join(d, '出廠日.txt'), ship); if (withMaster) fs.writeFileSync(path.join(d, '物流表B2C_20261124_080000.xlsx'), 'x'); };

(async () => {
  // 1. 舊工作（沒有 shipFrom、shipTo）→ 當成今天，行為不變；記出廠日
  let r = await run({ rows: [ROW('20261120000000001', T0)] });
  const lq = r.queries.find((q) => q.download === 'logistics') || {};
  check('1 舊工作：物流表條件照舊是今天', lq.from === T0 && lq.to === T0, JSON.stringify(lq));
  check('1 舊工作：R.shipDate＝今天、資料夾 心茶今天、出廠日.txt', r.R.shipDate === T0 && r.R.mmdd === MD(T0) && r.txt(MD(T0)) === T0, `shipDate=${r.R.shipDate} mmdd=${r.R.mmdd} txt=${r.txt(MD(T0))} err=${r.err}`);

  // 2. 區間：抓之後的出廠日；資料夾先用今天；新竹日期＝出廠日；批次確認不能說「不是今天」
  r = await run({ job: { shipFrom: T0, shipTo: T7 }, rows: [ROW('20261120000000001', T6), ROW('20261120000000002', T6)] });
  const q2 = r.queries.find((q) => q.download === 'logistics') || {};
  check('2 區間：物流表條件是 shipFrom～shipTo', q2.from === T0 && q2.to === T7, JSON.stringify(q2));
  check('2 區間：出廠日 T+6、資料夾用今天、寫出廠日.txt', r.R.shipDate === T6 && r.R.mmdd === MD(T0) && r.txt(MD(T0)) === T6, `shipDate=${r.R.shipDate} mmdd=${r.R.mmdd} txt=${r.txt(MD(T0))} err=${r.err}`);
  check('2 區間：新竹出貨日期＝出廠日', r.R.hctDate === slash(T6), `hctDate=${r.R.hctDate}`);
  check('2 區間：批次確認沒有「不是今天」的問題、直接確認 2 列', r.confirmed.length === 1 && r.confirmed[0].length === 2 && !r.asked.length, `confirmed=${JSON.stringify(r.confirmed)} asked=${r.asked.map((a) => a.msg.split('\n')[0]).join('|')}`);

  // 3. 規則 2：今天的資料夾已經是同一個出廠日 → 同一個資料夾
  r = await run({ job: { shipFrom: T6, shipTo: T6 }, rows: [ROW('20261120000000003', T6)], setup: (DL) => mkFolder(DL, MD(T0), T6, true) });
  check('3 規則 2：同一個出廠日 → 同一個資料夾', r.R.mmdd === MD(T0) && !r.err, `mmdd=${r.R.mmdd} err=${r.err}`);

  // 4. 規則 3：今天的資料夾出廠日不同 → 用出廠日命名；總表跟著複製；工作的 mmdd 改成實際的資料夾
  r = await run({ job: { shipFrom: T7, shipTo: T7 }, rows: [ROW('20261120000000004', T7)], setup: (DL) => mkFolder(DL, MD(T0), T6, true) });
  check('4 規則 3：出廠日不同 → 心茶(出廠日MMDD)', r.R.mmdd === MD(T7) && r.R.shipDate === T7 && r.txt(MD(T7)) === T7, `mmdd=${r.R.mmdd} txt=${r.txt(MD(T7))} err=${r.err}`);
  check('4 規則 3：今天資料夾的出廠日.txt 不動', r.txt(MD(T0)) === T6);
  check('4 規則 3：總表也複製到新資料夾（第 2 段找得到）', fs.existsSync(path.join(r.DL, '心茶' + MD(T7))) && fs.readdirSync(path.join(r.DL, '心茶' + MD(T7))).some((x) => /^廠商訂單確認_/.test(x)));
  check('4 規則 3：物流表存在新資料夾', fs.existsSync(path.join(r.DL, '心茶' + MD(T7))) && fs.readdirSync(path.join(r.DL, '心茶' + MD(T7))).some((x) => /^物流表B2C_/.test(x)));
  check('4 規則 3：工作文件的 mmdd 改成實際資料夾', r.jobDoc.mmdd === MD(T7), `job.mmdd=${r.jobDoc.mmdd}`);

  // 5. 規則 4：出廠日命名的資料夾也有、出廠日又不同 → 停下來，不批次確認
  r = await run({ job: { shipFrom: T7, shipTo: T7 }, rows: [ROW('20261120000000005', T7)], setup: (DL) => { mkFolder(DL, MD(T0), T6, true); mkFolder(DL, MD(T7), T8, true); } });
  check('5 規則 4：兩個資料夾出廠日都不同 → 停、不批次確認', !!r.err && /出廠日/.test(r.err) && !r.confirmed.length, `err=${r.err} confirmed=${r.confirmed.length}`);

  // 6. 抓到兩個出廠日 → 停下來問（還沒批次確認）；選一天 → 只做那天
  r = await run({ job: { shipFrom: T6, shipTo: T7 }, rows: [ROW('20261120000000006', T6), ROW('20261120000000007', T7), ROW('20261120000000008', T7)],
    decide: (q) => q.options.find((o) => o.includes(T7)) || '停止' });
  check('6 兩個出廠日：先問、選項列出每天', r.asked.length >= 1 && r.asked[0].options.some((o) => o.includes(T6)) && r.asked[0].options.some((o) => o.includes(T7)), r.asked.map((a) => a.options.join('/')).join(' | '));
  check('6 選 T+7：只確認 T+7 的 2 列、出廠日 T+7', r.confirmed.length === 1 && r.confirmed[0].length === 2 && r.R.shipDate === T7, `confirmed=${JSON.stringify(r.confirmed)} shipDate=${r.R.shipDate} err=${r.err}`);
  r = await run({ job: { shipFrom: T6, shipTo: T7 }, rows: [ROW('20261120000000006', T6), ROW('20261120000000007', T7)], decide: () => '停止' });
  check('6 選停止：不批次確認', !!r.err && !r.confirmed.length, `err=${r.err}`);

  // 7. 刪除的列不算出廠日（只確認）→ 不用問
  r = await run({ job: { shipFrom: T6, shipTo: T7 }, rows: [ROW('20261120000000009', T6), ROW('20261120000000010', T7, '訂單刪除')] });
  check('7 刪除的列日期不同：不用問、出廠日 T+6、兩列都確認', !r.asked.length && r.R.shipDate === T6 && r.confirmed.length === 1 && r.confirmed[0].length === 2,
    `asked=${r.asked.map((a) => a.msg.split('\n')[0]).join('|')} shipDate=${r.R.shipDate} confirmed=${JSON.stringify(r.confirmed)} err=${r.err}`);

  // 8. 試跑：不寫出廠日.txt
  r = await run({ job: { shipFrom: T6, shipTo: T6, dryRun: true }, rows: [ROW('20261120000000011', T6)] });
  check('8 試跑：記 shipDate 但不寫出廠日.txt', r.R.shipDate === T6 && r.txt(MD(T0)) === null, `shipDate=${r.R.shipDate} txt=${r.txt(MD(T0))} err=${r.err}`);

  // 9. 補上傳新竹：沒指定日期時用原本那次的出廠日
  r = await run({ job: { only: 'hct', parent: 'p1' }, setup: (DL) => { mkFolder(DL, MD(T0), T6); fs.writeFileSync(path.join(DL, '心茶' + MD(T0), '物流表B2C_x-1.xlsx'), 'x'); },
    parent: { type: 'b2cStart', status: 'done', mmdd: MD(T0), label: '上午', result: { mmdd: MD(T0), shipDate: T6, steps: { '整單': { ok: true, orders: 1, home: 1, file: '心茶' + MD(T0) + '/物流表B2C_x-1.xlsx' } } } } });
  check('9 補上傳新竹：出貨日期用原本的出廠日', r.logs.some((l) => l.includes('出貨日期 ' + slash(T6))), r.logs.find((l) => /補上傳新竹/.test(l)));

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  global.setTimeout = realSetTimeout;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
