// 規格 14-3 ②：shipment.html「產生訂單明細」每 200 單切一個檔（600 單以上會超過 server.js /agent/file 300 MB 上限）
// 用法：node test-detail-split.js <shipment.html 路徑> [心茶自動化 資料夾（檢查 xintea_stage2.py 不會把切檔後的訂單明細再上傳）]
// 把 genDetailBtn 的按鈕程式從 shipment.html 抽出來，在 vm 裡用假的 pdf-lib／Storage／DOM 跑，不連 Firebase、不開瀏覽器。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = path.resolve(process.argv[2] || 'shipment.html');
const html = fs.readFileSync(HTML, 'utf8');
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

const START = 'document.getElementById("genDetailBtn").addEventListener("click", ';
const from = html.indexOf(START), to = html.indexOf('\n});\n\n/* ---- 確認出貨', from);
if (from < 0 || to < 0) { check('找得到 genDetailBtn 的按鈕程式', false); process.exit(1); }
const handlerSrc = html.slice(from, to + 4);
const twFn = (html.match(/function getTodayTW\(\)\s*\{[\s\S]*?\n\}/) || [])[0] || '';

// 台灣今天（測試自己算，不用 toISOString）
const twToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function run(n, { missing = [] } = {}) {
  const downloads = [], creates = [], stamps = [];
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, textContent: '', value: id === 'startSeqInput' ? '1' : '',
    addEventListener: (ev, fn) => { el(id)._fn = fn; } });
  const blobs = new Map(); let bseq = 0;
  const orders = Array.from({ length: n }, (_, i) => ({ orderNo: 'X' + (i + 1), vendor: '心茶',
    detailSource: missing.includes(i + 1) ? null : { fileName: 'd.pdf', pageIndex: (i % 5) + 1, storagePath: 'p/d.pdf' } }));
  const PDFLib = {
    StandardFonts: { HelveticaBold: 'HB' }, rgb: () => ({}),
    PDFDocument: {
      load: async () => ({ src: true }),
      create: async () => { const d = { pages: [], embedFont: async () => 'font', copyPages: async (src, idx) => idx.map((i) => ({ i })),
        addPage: (p) => d.pages.push(p), save: async () => new TextEncoder().encode(JSON.stringify({ pages: d.pages.length })) }; creates.push(d); return d; },
    },
  };
  const ctx = {
    console, Blob, TextEncoder, Intl, Date, Map, Set, Promise, JSON, parseInt, Math, String, Number, Array, Object, RegExp,
    alert: (m) => { throw new Error('alert: ' + m); },
    document: { getElementById: el, createElement: () => { const a = { click: () => downloads.push({ name: a.download, blob: blobs.get(a.href) }) }; return a; } },
    URL: { createObjectURL: (b) => { const u = 'blob:' + (++bseq); blobs.set(u, b); return u; }, revokeObjectURL: () => {} },
    storage: { ref: () => ({ getDownloadURL: async () => 'https://x' }) },
    fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
    PDFLib,
    getSelectedOrders: () => orders,
    buildSiblingMap: async () => ({}),
    getSiblingLabels: () => [],
    stampSeqOnPdfPage: (page, label) => { page.label = label; stamps.push(label); },
    stampSiblingWarningOnPdfPage: () => {},
    setTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(twFn + '\n' + handlerSrc, ctx);
  await el('genDetailBtn')._fn();
  const files = [];
  for (const d of downloads) files.push({ name: d.name, pages: JSON.parse(await d.blob.text()).pages });
  return { files, creates, stamps, log: el('genLog').textContent };
}

(async () => {
  check('版本號有更新（> v2026-11-16-126）', (() => { const v = (html.match(/v(2026-11-\d+-\d+)<\/span>/) || [])[1]; return v && v > '2026-11-16-126'; })());
  check('檔名日期不用 toISOString（用台灣時區 getTodayTW）', !/toISOString/.test(handlerSrc) && !!twFn);

  let r;
  try { r = await run(450); } catch (e) { r = { files: [], creates: [], stamps: [], log: '', err: e.message }; }
  const names = r.files.map((f) => f.name + ':' + f.pages).join(' ');
  check('450 單 → 3 個檔（200／200／50）', r.files.length === 3 && r.files.map((f) => f.pages).join() === '200,200,50', names || r.err);
  check('分檔檔名 訂單明細_台灣日期-1／-2／-3.pdf', r.files.map((f) => f.name).join() === [1, 2, 3].map((k) => `訂單明細_${twToday}-${k}.pdf`).join(), names);
  check('每檔各用一份新的 PDF（不在記憶體裡疊 450 頁）', r.creates.length === 3 && Math.max(...r.creates.map((d) => d.pages.length)) <= 200, String(r.creates.length));
  check('#順序 戳記維持全部連號（#201/450 在第 2 檔第 1 頁）', r.stamps[0] === '#1/450' && r.stamps[200] === '#201/450' && r.stamps[449] === '#450/450', r.stamps.slice(199, 202).join());
  check('完成訊息寫分成幾個檔', /3 個檔/.test(r.log), r.log.split('\n').slice(-3).join(' / '));

  r = await run(250, { missing: [5] });
  check('250 單、第 5 單缺明細 → 2 個檔（199／50），照單的順序切', r.files.map((f) => f.pages).join() === '199,50', r.files.map((f) => f.name + ':' + f.pages).join(' '));

  r = await run(200);
  check('剛好 200 單 → 1 個檔，檔名不加 -1（跟以前一樣）', r.files.length === 1 && r.files[0].name === `訂單明細_${twToday}.pdf` && r.files[0].pages === 200, r.files.map((f) => f.name).join());
  r = await run(3);
  check('3 單 → 1 個檔，檔名不加 -1', r.files.length === 1 && r.files[0].name === `訂單明細_${twToday}.pdf`, r.files.map((f) => f.name).join());
  check('檔名符合 print_config 的 ^訂單明細_', r.files.every((f) => /^訂單明細_/.test(f.name)));

  // xintea_stage2.py 的 GENERATED_RE 要認得切檔後的檔名，不然會把產生的訂單明細當成心茶的明細再上傳解析
  const SCRIPTS = process.argv[3];
  if (SCRIPTS) {
    const names = [`訂單明細_${twToday}.pdf`, `訂單明細_${twToday}-1.pdf`, `訂單明細_${twToday}-12.pdf`, `訂單明細_${twToday} (1).pdf`, `託運單_超商_${twToday}.pdf`, '20261124_官網訂單_711 訂單.pdf'];
    let out = '';
    try {
      out = require('child_process').execFileSync('py', ['-3', '-c', `import sys,json; sys.path.insert(0, sys.argv[1]); import xintea_stage2 as m
print(json.dumps([bool(m.GENERATED_RE.match(n)) for n in json.loads(sys.argv[2])]))`, SCRIPTS, JSON.stringify(names)], { encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }) }).trim();
    } catch (e) { out = 'ERR ' + e.message.slice(0, 200); }
    check('xintea_stage2.py 認得切檔後的 訂單明細_日期-N.pdf 是產生的檔（不再上傳）', out.replace(/\s/g, '') === '[true,true,true,true,true,false]', out);
  } else console.log('（沒給心茶自動化資料夾，略過 xintea_stage2.py 檢查）');

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
