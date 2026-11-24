// 規格 14-3 ③：OCR（shipment「PDF解析」）每頁寫進度到執行紀錄＋記錄「OCR 認出 X 張、要人工 Y 張」（R.shipment.steps[PDF解析].ocrManual）
// 用法：node test-ocr-progress.js <shipment 資料夾（shipment.html、agent-driver.js）> <放 b2c-ship.js 的資料夾>
// A. shipment.html 開始解析：在 vm 用假的 pdf.js／Firestore／OCR 跑按鈕程式，看 window.__shipParse 每頁更新、最後有 認出／要人工 張數
// B. agent-driver.js runStage2：PDF解析那一步帶出 ocr 張數，XA.progress() 讀得到目前進度
// C. b2c-ship.js：runStage2 跑很久時，每隔一段時間把進度寫進執行紀錄；結束寫「OCR 認出 X 張、要人工 Y 張」，結果有 ocrMatched／ocrManual
// 都不連網、不開瀏覽器。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { noUndefined } = require('./firestore-strict');
const SHIP_DIR = path.resolve(process.argv[2]), SRC_DIR = path.resolve(process.argv[3]);
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- A. shipment.html ---------------- */
async function partA() {
  const html = fs.readFileSync(path.join(SHIP_DIR, 'shipment.html'), 'utf8');
  const START = 'document.getElementById("startParseBtn").addEventListener("click", ';
  const from = html.indexOf(START), to = html.indexOf('\n});\n', from);
  if (from < 0 || to < 0) return check('A 找得到 startParseBtn 的按鈕程式', false);
  const src = html.slice(from, to + 4);
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', value: id === 'vendorInput' ? '心茶' : '', checked: false, disabled: false, addEventListener: (e, fn) => { els[id]._fn = fn; } });
  // 一個檔 6 頁：1～2 明細、3～6 託運單；3 認出 1 張、4 一頁 2 張都認出、5 比對不到、6 姓名同時符合（2 筆待人工）
  const TXT = ['D1', 'D2', 'W3', 'W4', 'W5', 'W6'];
  const snaps = [];
  const win = {};
  const snap = () => { snaps.push(win.__shipParse ? JSON.parse(JSON.stringify(win.__shipParse)) : null); };
  const fakeRef =() => ({ get: async () => ({ exists: false, data: () => ({}) }), set: async () => {} });
  const ctx = {
    console, Promise, Map, Set, JSON, Math, Object, Array, String, Number, Date, Blob,
    window: win, firebaseReady: true, selectedFiles: [{ name: 'f.pdf', arrayBuffer: async () => new ArrayBuffer(4) }],
    alert: (m) => { throw new Error('alert ' + m); }, confirm: () => true, localStorage: { setItem() {} },
    document: { getElementById: el },
    logLine: (id, t) => { el(id).textContent += t + '\n'; snaps.push(win.__shipParse ? JSON.parse(JSON.stringify(win.__shipParse)) : null); },
    loadVendorCaches: async () => {}, sha256Hex: async () => 'h', cleanId: (s) => s,
    COLLECTION_FILE_HASHES: 'h', COLLECTION_ORDERS: 'o', COLLECTION_UNMATCHED: 'u', STORAGE_ROOT: 'r',
    db: { collection: () => ({ doc: fakeRef, add: async () => {} }) },
    storage: { ref: () => ({ put: async () => {} }) },
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
    pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({ numPages: 6, getPage: async (p) => ({ p }) }) }) },
    extractPageTextAndThumbnail: async (page) => { snap(); return { text: TXT[page.p - 1], thumbnail: '', ocrUsed: true }; },
    classifyAndParsePage: (t) => (/^D/.test(t) ? { docType: 'detail', orderNo: 'O' + t } : { docType: 'waybill' }),
    docIdFor: (v, o) => v + o, cacheAddOrUpdateOrder: () => {}, looksLikeDetailContinuationPage: () => false, extractItemRows: () => [],
    classifyAndWriteWaybillJob: async (job) => snap() || ({
      W3: { status: 'matched', matchedOrderNos: ['O1'] }, W4: { status: 'matched', matchedOrderNos: ['O2', 'O3'] },
      W5: { status: 'unmatched', unmatchedDoc: { a: 1 } }, W6: { status: 'ambiguous', unmatchedDocs: [{ a: 1 }, { a: 2 }] } }[job.text]),
    refreshVendorList: () => {}, refreshPool: () => {}, refreshUnmatched: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  try { await els.startParseBtn._fn(); } catch (e) { return check('A 按鈕程式跑完', false, e.message); }
  const P = win.__shipParse || {};
  const pagesSeen = [...new Set(snaps.filter((s) => s && s.phase === 'OCR').map((s) => s.done))];
  check('A 讀頁時 window.__shipParse 每頁更新（已讀 1～6 頁）', pagesSeen.length >= 6 && Math.max(...pagesSeen) === 6, JSON.stringify(pagesSeen));
  check('A 進度有檔名、第幾頁／共幾頁', snaps.some((s) => s && s.file === 'f.pdf' && s.page === 3 && s.pages === 6), JSON.stringify(snaps.find((s) => s && s.page === 3)));
  check('A 託運單比對時有 第幾張／共幾張', snaps.some((s) => s && s.phase === '託運單比對' && s.waybills === 4), JSON.stringify(snaps.filter((s) => s && s.phase === '託運單比對').slice(-1)));
  check('A 結束：認出 3 張（一頁 2 張算 2）、要人工 3 張、phase=完成', P.phase === '完成' && P.matched === 3 && P.manual === 3, JSON.stringify(P));
  check('A 完成訊息寫「託運單 認出 3 張、要人工 3 張」', /託運單 OCR 認出 3 張、要人工 3 張/.test(els.parseLog.textContent), els.parseLog.textContent.trim().split('\n').slice(-2).join(' / '));
}

/* ---------------- B. agent-driver.js ---------------- */
async function partB() {
  let src = fs.readFileSync(path.join(SHIP_DIR, 'agent-driver.js'), 'utf8').replace(/export default XA;\s*$/, 'this.XA = XA;');
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, innerText: '', textContent: '', value: '', disabled: false, options: [],
    dispatchEvent() {}, click() { if (id === 'startParseBtn') onParse(); } });
  const win = {};
  let ticks = 0;
  function onParse() {   // 假的「開始解析」：慢慢跑 3 頁，最後寫完成
    el('startParseBtn').disabled = true;
    win.__shipParse = { phase: 'OCR', file: 'a.pdf', fileNo: 1, files: 1, page: 0, pages: 3, done: 0 };
    const t = setInterval(() => {
      ticks++;
      if (win.__shipParse.done < 3) { win.__shipParse.page++; win.__shipParse.done++; el('parseLog').innerText += 'p' + win.__shipParse.done + '\n'; return; }
      clearInterval(t);
      Object.assign(win.__shipParse, { phase: '完成', waybills: 3, matched: 2, manual: 1 });
      el('parseLog').innerText += '完成！\n'; el('startParseBtn').disabled = false;
    }, 300);
  }
  el('orderListInput').value = '';
  function A() {} A.prototype.click = function () {};
  const ctx = { console, Promise, JSON, Object, Array, String, Date, Math, setTimeout, clearTimeout, setInterval, clearInterval, Event: function () {},
    window: win, document: { getElementById: el, querySelectorAll: () => [] }, HTMLAnchorElement: A,
    DataTransfer: function () { this.items = { add() {} }; this.files = []; },
    File: function () {}, fetch: async () => ({ ok: true, blob: async () => ({}) }) };
  win.confirm = () => true; win.alert = () => {}; win.print = () => {};
  vm.createContext(ctx);
  try { vm.runInContext(src, ctx); } catch (e) { return check('B 載入 agent-driver', false, e.message); }
  const XA = ctx.XA;
  check('B 有 XA.progress()', typeof XA.progress === 'function');
  const run = XA.runStage2({ pdfs: ['心茶1124/a.pdf'] });
  await sleep(700);
  const mid = typeof XA.progress === 'function' ? XA.progress() : null;
  check('B 跑到一半 XA.progress() 讀得到 PDF解析、第幾頁', mid && mid.step === 'PDF解析' && mid.parse && mid.parse.done >= 1, JSON.stringify(mid));
  const R = await run;
  const st = (R.steps || []).find((s) => s.step === 'PDF解析') || {};
  check('B PDF解析那一步帶出 ocrMatched=2、ocrManual=1、ocrWaybills=3', st.ocrMatched === 2 && st.ocrManual === 1 && st.ocrWaybills === 3, JSON.stringify(st).slice(0, 200));
}

/* ---------------- C. b2c-ship.js ---------------- */
async function partC() {
  const S = require(path.join(SRC_DIR, 'b2c-ship.js'))({ db: null, COL_JOB: 'jobs', sgReady: null, pageFor: null, progressPollMs: 100 });
  const runShipment = S._test && S._test.runShipment;
  if (typeof runShipment !== 'function') return check('C 有 _test.runShipment（⑤ shipment 比對抽成函式）', false);
  // 假 shipment 分頁：runStage2 跑 1.2 秒，期間進度一直變
  let prog = { step: '總表' };
  const page = { evaluate: async (fn, arg) => {
    if (arg && arg.saveDir) {
      await sleep(150); prog = { step: 'PDF解析', parse: { phase: 'OCR', file: '黑貓.pdf', fileNo: 1, files: 2, page: 1, pages: 40, done: 1 } };
      for (let i = 2; i <= 8; i++) { await sleep(100); prog = { step: 'PDF解析', parse: Object.assign({}, prog.parse, { page: i * 5, done: i * 5 }) }; }
      prog = { step: 'PDF解析', parse: { phase: '託運單比對', waybillDone: 10, waybills: 30, matched: 8, manual: 2, done: 40, pages: 40, file: '黑貓.pdf', fileNo: 2, files: 2, page: 40 } };
      await sleep(250);
      prog = { step: '產生檔案' }; await sleep(150);
      return { ok: true, unmatched: 2, orderListCount: 28, autoTicked: [], match: { checked: 28, checkedOrders: ['A'] }, generated: [],
        steps: [{ step: '總表', ms: 1 }, { step: 'PDF解析', ms: 9, log: 'x', ocrMatched: 27, ocrManual: 3, ocrWaybills: 30 }] };
    }
    return prog;   // 進度查詢
  } };
  const logs = []; const R = {}; let saves = 0;
  await runShipment(page, { saveDir: '心茶1124' }, R, async (m) => logs.push(m), async () => { saves++; noUndefined(R, 'Update()'); });
  const prog1 = logs.filter((l) => /PDF解析/.test(l) && /頁/.test(l));
  check('C 跑的時候執行紀錄有 PDF解析 第幾頁 的進度（不只一行）', prog1.length >= 2, logs.join(' / '));
  check('C 進度寫檔名和 第 X/40 頁', prog1.some((l) => /黑貓\.pdf/.test(l) && /\d+\/40 頁/.test(l)), prog1[0]);
  check('C 託運單比對時寫 認出／要人工', logs.some((l) => /託運單比對 10\/30/.test(l) && /認出 8/.test(l) && /要人工 2/.test(l)), logs.join(' / '));
  check('C 同樣的進度不重複寫', logs.length === new Set(logs).size, String(logs.length));
  check('C 結束寫「OCR 認出 27 張、要人工 3 張」', logs.some((l) => /OCR 認出 27 張、要人工 3 張/.test(l)), logs.slice(-2).join(' / '));
  const st = ((R.shipment || {}).steps || []).find((s) => s.step === 'PDF解析') || {};
  check('C 結果 steps[PDF解析] 有 ocrMatched=27、ocrManual=3', st.ocrMatched === 27 && st.ocrManual === 3, JSON.stringify(st));
  check('C R.ocr 摘要 { matched, manual, waybills }', R.ocr && R.ocr.matched === 27 && R.ocr.manual === 3 && R.ocr.waybills === 30, JSON.stringify(R.ocr));
  // 舊版 shipment（沒有 ocr 張數、沒有 progress）也不能壞
  const logs2 = []; const R2 = {};
  const page2 = { evaluate: async (fn, arg) => { if (arg && arg.saveDir) { await sleep(250); return { ok: true, match: { checked: 1, checkedOrders: ['A'] }, generated: [], steps: [{ step: 'PDF解析', ms: 1, log: 'x' }] }; } return undefined; } };
  let err = null;
  try { await runShipment(page2, { saveDir: '心茶1124' }, R2, async (m) => logs2.push(m), async () => noUndefined(R2, 'Update()')); } catch (e) { err = e.message; }
  check('C 舊版 shipment（沒有張數）照樣跑完、R 不含 undefined', !err && R2.shipment && R2.shipment.ok === true, err || logs2.join(' / '));
}

/* ---------------- D. b2b-worker.js 執行紀錄只留 80 行：進度行要原地更新，不能把前面的紀錄擠掉 ---------------- */
async function partD() {
  const src = fs.readFileSync(path.join(SRC_DIR, 'b2b-worker.js'), 'utf8');
  const m = src.match(/function jobLogger\(ref\) \{[\s\S]*?\n\}/);
  if (!m) return check('D 找得到 jobLogger', false);
  const ctx = { console: { log() {} }, Date, now: () => 't' }; vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.f = jobLogger;', ctx);
  let saved = null; const log = ctx.f({ update: async (o) => { saved = o; } });
  await log('② SG出 上傳'); await log('SG出 成功 900');
  for (let i = 1; i <= 120; i++) await log(`⏳ PDF解析：第 ${i}/120 頁`);
  await log('OCR 認出 800 張、要人工 100 張');
  await log('⏳ shipment 進行中：產生檔案');
  const L = saved.log;
  check('D 120 行進度之後，前面的「SG出 成功」還在', L.some((l) => /SG出 成功 900/.test(l)), L.length + ' 行');
  check('D 連續的進度只留最新一行', L.filter((l) => /PDF解析/.test(l)).length === 1 && L.some((l) => /第 120\/120 頁/.test(l)), L.join(' / ').slice(0, 300));
  check('D 一般訊息後面的新進度另起一行（不蓋掉一般訊息）', /OCR 認出/.test(L[L.length - 2]) && /產生檔案/.test(L[L.length - 1]), L.slice(-3).join(' / '));
}

(async () => {
  await partD();
  await partA();
  await partB();
  await partC();
  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
