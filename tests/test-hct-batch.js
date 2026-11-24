// 規格 14-3 ①：新竹列印（託運單）一批最多 300 單 → 分批勾、分批取 PDF、最後合併；等候時間照每批張數算
// 用法：node test-hct-batch.js <放 b2c-start.js 的資料夾>
// 假新竹「報表 → 標籤」頁（Playwright 攔截 apsweb.hct.com.tw，不連真的新竹）：
//   勾超過 300 列按「(P)標籤列印」→ 不給 PDF（跟新竹一樣有上限）；300 列以內 → 給那幾張的 PDF，那幾列移到「已列印」。
// 列上沒有託運單號（10 碼）→ 不會走「逐張取 PDF」，直接測按鈕那一條（11/23 實際走的就是按鈕）。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const SRC_DIR = path.resolve(process.argv[2]);
let chromium, launchOpt = {};
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(SRC_DIR, 'node_modules', 'playwright-core'))); launchOpt = { channel: 'chrome' }; }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hctbatch-'));
const DL = path.join(TMP, 'DL'); fs.mkdirSync(DL, { recursive: true });

// ---- 載入 b2c-start.js（DL、SCRIPT_DIR 換掉；補匯出 hctLabels）----
let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-start.js'), 'utf8');
src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(TMP)};`);
if (!/_test: \{[^}]*hctLabels/.test(src)) src = src.replace('_test: {', '_test: { hctLabels, ');
const file = path.join(TMP, 'b2c-start.under-test.js'); fs.writeFileSync(file, src);
const S = require(file)({ db: null, COL_JOB: 'jobs' });

// ---- N 頁的假 PDF ----
function pdfOf(n) {
  return execFileSync('py', ['-3', '-c', `import sys,io
from pypdf import PdfWriter
w=PdfWriter()
for i in range(int(sys.argv[1])): w.add_blank_page(width=283,height=425)
b=io.BytesIO(); w.write(b); sys.stdout.buffer.write(b.getvalue())`, String(n)], { maxBuffer: 64 * 1024 * 1024 });
}
const pagesOf = (f) => Number(execFileSync('py', ['-3', '-c', 'import sys\nfrom pypdf import PdfReader\nprint(len(PdfReader(sys.argv[1]).pages))', f]).toString().trim());

// ---- 假新竹 ----
const HCT = 'https://apsweb.hct.com.tw/SCTM/';
function site(cfg) {
  const st = { unprinted: [...(cfg.unprinted || [])], printed: [...(cfg.printed || [])], prints: [], refused: 0, other: [] };
  const html = (b) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset=utf-8>' + b });
  const row = (o, i) => `<tr><td><input type=checkbox id="cb_${i}" data-no="${o.no}"></td><td>HCT${o.no.slice(-6)}</td><td>${o.name}<br>(${o.phone})</td></tr>`;
  st.handle = async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.replace('/SCTM/', '');
    if (p === '' || p === 'Default.aspx') return route.fulfill(html(`<iframe id=fr style="width:900px;height:500px"></iframe>
      <script>var url2210='LabV2.aspx',p2210=2;function chgPage(u){document.getElementById('fr').src=u+'?t='+Date.now();}</script>`));
    if (p === 'LabV2.aspx') {
      const d = u.searchParams.get('d') || cfg.date, y = u.searchParams.get('y') || '0';
      const list = y === '0' ? st.unprinted : st.printed;
      return route.fulfill(html(`<form method=get action="LabV2.aspx"><input id=Date_TxtV2 name=d value="${d}"><input type=hidden name=y value="${y}"><input type=submit id=confirmCondition value=查詢></form>
        <input type=radio name=yet id=YetRdo_0 ${y === '0' ? 'checked' : ''} onclick="location='LabV2.aspx?d=${encodeURIComponent(d)}&y=0'"><label for=YetRdo_0>未列印[${st.unprinted.length}]</label>
        <input type=radio name=yet id=YetRdo_1 ${y === '1' ? 'checked' : ''} onclick="location='LabV2.aspx?d=${encodeURIComponent(d)}&y=1'"><label for=YetRdo_1>已列印[${st.printed.length}]</label>
        <table>${list.map(row).join('')}</table>
        <input type=button value="(P)標籤列印" onclick="const nos=[...document.querySelectorAll('input[type=checkbox]:checked')].map(b=>b.dataset.no);fetch('Report/getFromBuffer.aspx?jobid=J'+Date.now(),{method:'POST',body:nos.join(',')})">`));
    }
    if (p === 'Report/getFromBuffer.aspx') {
      const nos = (req.postData() || '').split(',').filter(Boolean);
      if (nos.length > 300) { st.refused++; return route.fulfill(html('一次最多列印 300 筆')); }
      st.prints.push(nos.length);
      const moved = st.unprinted.filter((o) => nos.includes(o.no));
      st.unprinted = st.unprinted.filter((o) => !nos.includes(o.no)); st.printed.push(...moved);
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdfOf(nos.length) });
    }
    st.other.push(p);
    return route.fulfill({ status: 404, body: 'nf' });
  };
  return st;
}
// 電話每一組都不同（新竹勾選靠電話後 9 碼或單號比對）
const orders = (n, base) => Array.from({ length: n }, (_, i) => ({ no: String(base + i), name: '測試' + i, phone: '09' + String((Math.floor(base / 1e5) % 100) * 1e6 + i).padStart(8, '0') }));

async function run(name, cfg, ords, expect) {
  const browser = await chromium.launch(Object.assign({ headless: true }, launchOpt));
  const ctx = await browser.newContext(); ctx.setDefaultTimeout(15000);
  const st = site(cfg);
  await ctx.route('https://apsweb.hct.com.tw/**', st.handle);
  const page = await ctx.newPage(); await page.goto(HCT);
  const logs = [], out = path.join(DL, name + '.pdf');
  const t0 = Date.now(); let res = null, err = null;
  try { res = await S._test.hctLabels(page, cfg.date, expect, out, async (m) => logs.push(m), ords); } catch (e) { err = e.message; }
  await browser.close();
  const files = res && res.files ? res.files.map((f) => path.join(DL, f)) : (fs.existsSync(out) ? [out] : []);
  return { st, res, err, logs, secs: Math.round((Date.now() - t0) / 1000), pages: files.reduce((a, f) => a + (fs.existsSync(f) ? pagesOf(f) : 0), 0), files };
}

const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

(async () => {
  // 等候時間（純函式）
  const W = S._test.hctLabelWaitSecs;
  check('等候時間照張數算：1 張 90 秒、300 張 ≥ 300 秒', typeof W === 'function' && W(1) === 90 && W(300) >= 300, typeof W === 'function' ? `${W(1)}／${W(300)} 秒` : '沒有 hctLabelWaitSecs');

  // A. 650 張（旺季）：未列印 → 分 3 批（300／300／50）、合併成 650 頁
  const A = orders(650, 20261130000000);
  let r = await run('A', { date: '2026/11/30', unprinted: A }, A, 650);
  check('A 650 張：每批都 ≤ 300（新竹沒有拒絕）', !r.st.refused && r.st.prints.length === 3 && r.st.prints.every((n) => n <= 300), `批次 ${JSON.stringify(r.st.prints)} 拒絕 ${r.st.refused} 次 err=${r.err} ${r.secs} 秒`);
  check('A 650 張：合併後 650 頁、一個檔', r.pages === 650 && r.files.length === 1, `頁數 ${r.pages}、${r.files.length} 個檔`);
  check('A 執行紀錄寫分幾批', r.logs.some((l) => /分 3 批/.test(l)), r.logs.filter((l) => /批/.test(l)).join(' / '));
  check('A 沒有連到別的新竹網址', !r.st.other.length, r.st.other.join(','));

  // B. 120 張：照舊一批
  const B = orders(120, 20261130100000);
  r = await run('B', { date: '2026/11/30', unprinted: B, printed: orders(5, 20261129000000) }, B, 120);
  check('B 120 張：一批、120 頁', !r.err && JSON.stringify(r.st.prints) === '[120]' && r.pages === 120, `批次 ${JSON.stringify(r.st.prints)} err=${r.err}`);

  // C. 重印（未列印找不到、已列印有 350 張）→ 已列印的不會移走，也要分 2 批、不重複
  const C = orders(350, 20261130200000);
  r = await run('C', { date: '2026/11/30', unprinted: [], printed: C }, C, 350);
  check('C 從已列印重印 350 張：分 2 批、350 頁', !r.err && r.st.prints.length === 2 && r.st.prints.every((n) => n <= 300) && r.pages === 350, `批次 ${JSON.stringify(r.st.prints)} 頁數 ${r.pages} err=${r.err}`);

  // D. 新竹清單上有別人的單：只勾這份物流表的
  const D = orders(310, 20261130300000), others = orders(40, 20261130900000);
  r = await run('D', { date: '2026/11/30', unprinted: [...others.slice(0, 20), ...D, ...others.slice(20)] }, D, 310);
  check('D 混了別人的單：只印這份的 310 張（2 批）', !r.err && r.st.prints.reduce((a, b) => a + b, 0) === 310 && r.st.prints.length === 2 && r.st.unprinted.length === 40, `批次 ${JSON.stringify(r.st.prints)} 剩未列印 ${r.st.unprinted.length} err=${r.err}`);

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
