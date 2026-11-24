// 規格 14-3 ④：拿到託運單 PDF 就先 OCR（Jay 手動時的順序）
// 用法：node test-ocr-early.js <shipment 資料夾（shipment.html、agent-driver.js）> <放 b2c-start.js、b2c-ship.js 的資料夾>
// Jay 2026-11-24 選：另外排一個工作（type b2cOcr，parent＝第 1 段），第 1 段正式跑完、資料夾有 PDF 就自動排；網頁另有按鈕「再抓 Drive＋先 OCR」（drive:true）。
// S1 b2c-start：第 1 段結束自動排 b2cOcr（試跑、沒有 PDF 不排）；關卡權限跟 ① 一樣
// S2 b2c-ship b2cOcr：找資料夾、核對出廠日、（drive）重抓 Drive、裁切清單、shipment 只解析（parseOnly）、寫認出／要人工
// S3 agent-driver runStage2 parseOnly：解析完就結束，不比對、不產生
// S4 shipment.html：已解析過（雜湊相同）跳過的檔數記在 window.__shipParse.dup
// 都在暫存資料夾、不連網、不開瀏覽器。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { execFileSync } = require('child_process');
const { noUndefined } = require('./firestore-strict');
const SHIP_DIR = path.resolve(process.argv[2]), SRC_DIR = path.resolve(process.argv[3]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ocrearly-'));
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tw = (addDays) => new Date(Date.now() + 8 * 3600e3 + (addDays || 0) * 86400e3).toISOString().slice(0, 10);
const T0 = tw(0), T6 = tw(6);
const MD = (ymd) => ymd.slice(5, 7) + ymd.slice(8, 10);
const slash = (ymd) => ymd.replace(/-/g, '/');

function fakeDb() {
  const docs = new Map(); let seq = 0;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mkRef = (id) => ({ id,
    get: async () => ({ exists: docs.has(id), id, data: () => (docs.has(id) ? clone(docs.get(id)) : undefined) }),
    update: (o) => { noUndefined(o, 'Update()'); docs.set(id, Object.assign(docs.get(id) || {}, clone(o))); return Promise.resolve(); },
    set: (o) => { noUndefined(o, 'Set()'); docs.set(id, clone(o)); return Promise.resolve(); } });
  const query = (fl) => ({ where: (f, op, v) => query(fl.concat([[f, v]])),
    get: async () => ({ docs: [...docs.entries()].filter(([, d]) => fl.every(([f, v]) => d[f] === v)).map(([id, d]) => ({ id, data: () => clone(d), ref: mkRef(id) })) }) });
  return { docs, collection: () => Object.assign(query([]), { doc: (id) => mkRef(id),
    add: (o) => { noUndefined(o, 'Add()'); const id = 'd' + (++seq); docs.set(id, clone(o)); return Promise.resolve(mkRef(id)); } }) };
}

/* ---------------- S1 b2c-start ---------------- */
const H = ['單號', '訂單日期', '收件人', '收件人電話', '收件人地址', '收件人Email', '付款方式', '物流方式', '訂單備註', '訂單金額', '發票抬頭', '統一編號',
  '商品編號', '商品名稱', '數量', '小計', '單位', '明細備註', '寄件人', '寄件人電話', '心茶訂單key值', '最早可出廠日', '生產廠商', '訂單狀態'];
const ROW = (no, date) => ['#' + no, '2026/11/20', '測試', '0912345678', '新北市汐止區測試路1號', null, 'Apple Pay', '7-11 取貨', null, '100', null, null,
  'A020011', '茶包', '1', null, null, null, '心茶', '03-8900198', '#' + no + '-1', slash(date), '俬儲空間', '新增'];
const XT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function xlsxB64(rows, tmp) {
  const f = path.join(tmp, 'bpm-' + Date.now() + Math.random().toString(36).slice(2) + '.xlsx');
  execFileSync('py', ['-3', '-c', `import openpyxl,json,sys
wb=openpyxl.Workbook(); ws=wb.active
for r in json.loads(sys.argv[2]): ws.append(r)
wb.save(sys.argv[1])`, f, JSON.stringify([H, ...rows])]);
  return fs.readFileSync(f).toString('base64');
}
let n = 0;
async function runStart({ job = {}, rows = [], setup } = {}) {
  const dir = path.join(ROOT, 's' + (++n)); const DL = path.join(dir, 'DL'), SCR = path.join(dir, 'scripts');
  fs.mkdirSync(DL, { recursive: true }); fs.mkdirSync(SCR, { recursive: true });
  fs.writeFileSync(path.join(SCR, 'xintea_zhengdan.py'), `import sys,json,openpyxl
ws=openpyxl.load_workbook(sys.argv[1]).worksheets[0]
nos=set(str(r[0]) for r in ws.iter_rows(min_row=2,values_only=True) if r[0])
print('RESULT_JSON: '+json.dumps({'orders':len(nos),'lines':len(nos),'宅配(自建單)':0,'outputs':[]}))`);
  if (setup) setup(DL);
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-start.js'), 'utf8');
  src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(SCR)};`);
  const file = path.join(dir, 'b2c-start.under-test.js'); fs.writeFileSync(file, src);
  const db = fakeDb(), logs = []; let confirmed = 0;
  const page = { url: () => 'https://xintea.jwcpas.com.tw/xin_tea/common/main_menu',
    evaluate: async (fn, arg) => {
      if (arg === undefined) return true;
      if (Array.isArray(arg)) { confirmed++; return { status: 200, text: '{"msg":"確認成功"}' }; }
      if (arg.cond) {
        const c = arg.cond;
        if (arg.download === 'summary') return { rows: Array.from({ length: 3000 }, (_, i) => ({ key: '#s' + i + '-1', vc: 0, st: '新增', date: slash(T0) })), file: { name: '_20261124_100000.xlsx', type: XT, b64: xlsxB64([ROW('1', T0)], dir) } };
        const sel = rows.filter((r) => (!c.dateFrom || r[21].replace(/\//g, '-') >= c.dateFrom) && (!c.dateTo || r[21].replace(/\//g, '-') <= c.dateTo)).filter(() => !confirmed);
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
  const jobDoc = Object.assign({ type: 'b2cStart', status: 'running', label: '上午', mmdd: MD(T0), by: '測試', byEmail: 't@x' }, job);
  const ref = await db.collection().add(jobDoc);
  let out = null, err = null;
  try { out = await S.handlers.b2cStart(ref, Object.assign({ id: ref.id }, jobDoc), async (m) => logs.push(m)); } catch (e) { err = e.message; }
  global.fetch = realFetch;
  const ocrJobs = [...db.docs.entries()].filter(([, d]) => d.type === 'b2cOcr').map(([id, d]) => Object.assign({ id }, d));
  return { R: out || {}, err, logs, ocrJobs, refId: ref.id, src };
}

async function s1() {
  const rawSetTimeout = global.setTimeout; global.setTimeout = (fn) => setImmediate(fn);
  try {
    const putPdf = (DL) => { const d = path.join(DL, '心茶' + MD(T0)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, '20261124_官網訂單_711 訂單.pdf'), '%PDF-1.4 x'); };
    let r = await runStart({ job: { shipFrom: T0, shipTo: T6 }, rows: [ROW('20261120000000001', T6)], setup: putPdf });
    const j = r.ocrJobs[0] || {};
    check('S1 第 1 段跑完、資料夾有 PDF → 自動排 1 個 b2cOcr', r.ocrJobs.length === 1 && !r.err, `${r.ocrJobs.length} 個 err=${r.err}`);
    check('S1 b2cOcr 帶 parent＝第 1 段、排隊中、auto、資料夾', j.parent === r.refId && j.status === 'queued' && j.auto === true && j.mmdd === MD(T0), JSON.stringify(j).slice(0, 200));
    check('S1 b2cOcr 記送出的人（關卡權限用）', j.byEmail === 't@x' && !!j.by, `${j.by} ${j.byEmail}`);
    check('S1 執行紀錄寫已排先 OCR', r.logs.some((l) => /先 OCR/.test(l)), r.logs.slice(-3).join(' / '));
    check('S1 結果記 ocrJob（網頁找得到）', !!j.id && r.R.ocrJob === j.id, String(r.R.ocrJob));
    r = await runStart({ job: { shipFrom: T0, shipTo: T6 }, rows: [ROW('20261120000000002', T6)] });
    check('S1 資料夾沒有 PDF → 不排', r.ocrJobs.length === 0 && !r.err, `${r.ocrJobs.length} err=${r.err}`);
    r = await runStart({ job: { shipFrom: T0, shipTo: T6, dryRun: true }, rows: [ROW('20261120000000003', T6)], setup: putPdf });
    check('S1 試跑 → 不排', r.ocrJobs.length === 0, String(r.ocrJobs.length));
    check('S1 關卡權限：b2cOcr 跟 ① 出貨開始同一關（start1）', /b2cOcr: 'start1'/.test(r.src));
  } finally { global.setTimeout = rawSetTimeout; }
}

/* ---------------- S2 b2c-ship b2cOcr ---------------- */
async function runOcr({ job, parent, ship = T6, txt = T6, pdfs = ['心茶MMDD/a 訂單.pdf', '心茶MMDD/託運單_7-11裁切.pdf'], st } = {}) {
  const dir = path.join(ROOT, 'o' + (++n)); const DL = path.join(dir, 'DL'), SCR = path.join(dir, 'scripts');
  const mmdd = MD(T0), day = path.join(DL, '心茶' + mmdd);
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(SCR, { recursive: true });
  if (txt) fs.writeFileSync(path.join(day, '出廠日.txt'), txt);
  const pl = pdfs.map((p) => p.replace('MMDD', mmdd));
  fs.writeFileSync(path.join(SCR, 'xintea_stage2.py'), `import sys,json
print('ARGS', sys.argv[1:])
print('RESULT_JSON: '+json.dumps({'step':'pdfs','master':'心茶${mmdd}/廠商訂單確認_x.xlsx','pdfs':${JSON.stringify(pl)},'cut':[],'warnings':[]}, ensure_ascii=False))`);
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-ship.js'), 'utf8')
    .replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(SCR)};`);
  const file = path.join(dir, 'b2c-ship.under-test.js'); fs.writeFileSync(file, src);
  const db = fakeDb();
  await db.collection().doc('p1').set(parent || { type: 'b2cStart', status: 'done', mmdd, label: '上午', result: { mmdd, shipDate: ship } });
  const calls = { drive: [], stage2: [] };
  const page = { url: () => 'http://localhost:8080/shipment.html', bringToFront: async () => {}, goto: async () => {},
    evaluate: async (fn, arg) => {
      if (arg && arg.saveDir) { calls.stage2.push(arg); await sleep(30); return st || { ok: true, unmatched: 2, steps: [{ step: '總表', ms: 5 }, { step: 'PDF解析', ms: 60000, ocrMatched: 40, ocrManual: 2, ocrWaybills: 42, pages: 50, ocrDup: 0 }] }; }
      return true;
    } };
  const W = { db, COL_JOB: 'jobs', progressPollMs: 1000, sgReady: async () => { throw new Error('b2cOcr 不該用 SG'); }, pageFor: async () => page,
    drivePdfs: async (log, dayDir, ymd8, dryRun) => { calls.drive.push({ dayDir, ymd8, dryRun }); return { found: ['a.pdf'], downloaded: ['a.pdf'], skipped: [] }; } };
  const S = require(file)(W);
  const realFetch = global.fetch;
  global.fetch = async (u) => { if (String(u).startsWith('http://127.0.0.1:8080')) return { json: async () => ({ ok: true, version: 'fake' }) }; throw new Error('測試不連網'); };
  const ref = await db.collection().add(Object.assign({ type: 'b2cOcr', status: 'running' }, job));
  const logs = []; let R = null, err = null;
  try {
    if (typeof S.b2cOcr !== 'function') throw new Error('b2c-ship 沒有 b2cOcr');
    R = await S.b2cOcr(ref, job, async (m) => logs.push(m));
  } catch (e) { err = e.message; }
  global.fetch = realFetch;
  return { R: R || {}, err, logs, calls, day, partial: (db.docs.get(ref.id) || {}).partial };
}

async function s2() {
  let r = await runOcr({ job: { parent: 'p1', auto: true } });
  const a = r.calls.stage2[0] || {};
  check('S2 自動排的：shipment 只解析（parseOnly）、帶總表和 PDF', !r.err && a.parseOnly === true && /廠商訂單確認/.test(a.master || '') && (a.pdfs || []).length === 2 && !a.generate && !a.sgResult, (r.err || '') + JSON.stringify(a).slice(0, 200));
  check('S2 存檔資料夾是第 1 段那次的資料夾', a.saveDir === '心茶' + MD(T0), a.saveDir);
  check('S2 自動排的不重抓 Drive（第 1 段剛抓過）', r.calls.drive.length === 0);
  check('S2 結果有 R.ocr、執行紀錄寫認出／要人工', r.R.ocr && r.R.ocr.matched === 40 && r.R.ocr.manual === 2 && r.logs.some((l) => /OCR 認出 40 張、要人工 2 張/.test(l)), JSON.stringify(r.R.ocr) + ' ' + r.logs.slice(-2).join(' / '));
  check('S2 結果記資料夾、出廠日、parent', r.R.mmdd === MD(T0) && r.R.shipDate === T6 && r.R.parent === 'p1', JSON.stringify({ m: r.R.mmdd, s: r.R.shipDate, p: r.R.parent }));
  r = await runOcr({ job: { parent: 'p1', drive: true } });
  check('S2 按鈕（drive）：先重抓 Drive 到那個資料夾，再解析', r.calls.drive.length === 1 && r.calls.drive[0].dayDir === r.day && r.calls.stage2.length === 1, JSON.stringify(r.calls.drive));
  r = await runOcr({ job: { parent: 'p1' }, txt: T0 });
  check('S2 出廠日.txt 對不上 → 停、不解析', !!r.err && /對不上/.test(r.err) && !r.calls.stage2.length, r.err);
  r = await runOcr({ job: { parent: 'p1' }, parent: { type: 'b2cStart', status: 'done', dryRun: true, result: { mmdd: MD(T0) } } });
  check('S2 第 1 段是試跑 → 停', !!r.err && /試跑/.test(r.err), r.err);
  r = await runOcr({ job: { parent: 'p1' }, pdfs: [] });
  check('S2 資料夾沒有 PDF → 不開 shipment、寫沒有 PDF', !r.err && !r.calls.stage2.length && r.logs.some((l) => /沒有.*PDF/.test(l)), (r.err || '') + r.logs.join(' / '));
  r = await runOcr({ job: { parent: 'p1' }, st: { ok: true, unmatched: 0, steps: [{ step: 'PDF解析', ms: 9, ocrMatched: 0, ocrManual: 0, ocrWaybills: 0, pages: 0, ocrDup: 3 }] } });
  check('S2 全部解析過了：寫「3 個檔已經 OCR 過，跳過」', r.logs.some((l) => /3 個檔已經 OCR 過/.test(l)), r.logs.join(' / '));
  r = await runOcr({ job: { parent: 'p1' }, st: { ok: false, stoppedAt: 'PDF解析', log: '❌ 處理中斷', steps: [{ step: 'PDF解析', ms: 9 }] } });
  check('S2 shipment 解析出錯 → 工作失敗（網頁看得到）', !!r.err && /PDF解析/.test(r.err), r.err);
}

/* ---------------- S3 agent-driver parseOnly ---------------- */
async function s3() {
  const src = fs.readFileSync(path.join(SHIP_DIR, 'agent-driver.js'), 'utf8').replace(/export default XA;\s*$/, 'this.XA = XA;');
  const els = {}, clicks = [];
  const el = (id) => (els[id] = els[id] || { id, style: {}, innerText: '', textContent: '', value: '', disabled: false, options: [],
    dispatchEvent() {}, click() { clicks.push(id); if (id === 'startParseBtn') { el('parseLog').innerText = '完成！\n'; win.__shipParse = { phase: '完成', matched: 5, manual: 1, waybills: 6, done: 7, dup: 0 }; } if (id === 'startExcelBtn') el('excelLog').innerText = '總表完成\n'; } });
  const win = {};
  function A() {} A.prototype.click = function () {};
  const ctx = { console, Promise, JSON, Object, Array, String, Date, Math, setTimeout, clearTimeout, setInterval, clearInterval, Event: function () {},
    window: win, document: { getElementById: el, querySelectorAll: () => [] }, HTMLAnchorElement: A,
    DataTransfer: function () { this.items = { add() {} }; this.files = []; }, File: function () {}, fetch: async () => ({ ok: true, blob: async () => ({}) }) };
  win.confirm = () => true; win.alert = () => {}; win.print = () => {};
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const R = await ctx.XA.runStage2({ master: '心茶1124/m.xlsx', pdfs: ['心茶1124/a.pdf'], parseOnly: true });
  check('S3 parseOnly：解析完就 ok、不停在「可出貨清單是空的」', R.ok === true && !R.stoppedAt, JSON.stringify({ ok: R.ok, stop: R.stoppedAt, err: R.error }));
  check('S3 parseOnly：有上傳總表、解析，沒按比對、沒產生', clicks.includes('startExcelBtn') && clicks.includes('startParseBtn') && !clicks.includes('matchBtn') && !clicks.includes('genDetailBtn'), clicks.join(','));
  const st = (R.steps || []).find((s) => s.step === 'PDF解析') || {};
  check('S3 parseOnly：PDF解析帶出張數、已解析過跳過的檔數', st.ocrMatched === 5 && st.ocrManual === 1 && st.ocrDup === 0, JSON.stringify(st).slice(0, 200));
}

/* ---------------- S4 shipment.html 已解析過的檔數 ---------------- */
async function s4() {
  const html = fs.readFileSync(path.join(SHIP_DIR, 'shipment.html'), 'utf8');
  const START = 'document.getElementById("startParseBtn").addEventListener("click", ';
  const from = html.indexOf(START), to = html.indexOf('\n});\n', from);
  const src = html.slice(from, to + 4);
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', value: id === 'vendorInput' ? '心茶' : '', checked: false, disabled: false, addEventListener: (e, fn) => { els[id]._fn = fn; } });
  const win = {};
  const ctx = { console, Promise, Map, Set, JSON, Math, Object, Array, String, Number, Date, Blob, window: win, firebaseReady: true,
    selectedFiles: [{ name: 'old.pdf', arrayBuffer: async () => new ArrayBuffer(4) }, { name: 'old2.pdf', arrayBuffer: async () => new ArrayBuffer(4) }],
    alert: (m) => { throw new Error('alert ' + m); }, confirm: () => true, localStorage: { setItem() {} }, document: { getElementById: el },
    logLine: (id, t) => { el(id).textContent += t + '\n'; },
    loadVendorCaches: async () => {}, sha256Hex: async () => 'h', cleanId: (s) => s, COLLECTION_FILE_HASHES: 'h', COLLECTION_ORDERS: 'o', COLLECTION_UNMATCHED: 'u', STORAGE_ROOT: 'r',
    db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ fileName: 'old.pdf' }) }), set: async () => {} }), add: async () => {} }) },
    storage: { ref: () => ({ put: async () => {} }) }, firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
    refreshVendorList: () => {}, refreshPool: () => {}, refreshUnmatched: () => {} };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  try { await els.startParseBtn._fn(); } catch (e) { return check('S4 按鈕程式跑完', false, e.message); }
  const P = win.__shipParse || {};
  check('S4 兩個檔都解析過 → __shipParse.dup=2、phase 完成', P.dup === 2 && P.phase === '完成', JSON.stringify(P));
}

(async () => {
  await s1();
  await s2();
  await s3();
  await s4();
  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
