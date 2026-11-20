// 新竹上傳／補上傳的回歸測試：假的新竹網站（Playwright 攔截 apsweb.hct.com.tw）＋假的 Firestore，跑真的 b2c-start.js
// 用法：node test-hct.js <放 b2c-start.js 的資料夾> <物流表 xlsx>
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright');
const SRC_DIR = path.resolve(process.argv[2]), XLSX = path.resolve(process.argv[3]);

// ---- 測試用工作資料夾：b2c-start.js 的 Windows 路徑在 Linux 會變成相對路徑，放在這個 cwd 底下 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hct-'));
process.chdir(TMP);
fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true });
const DL = path.join(TMP, 'DL');
fs.mkdirSync(path.join(DL, '心茶1120'), { recursive: true });
const LOGI_REL = '心茶1120/物流表B2C_20261120_110642-10.xlsx';
fs.copyFileSync(XLSX, path.join(DL, LOGI_REL));
fs.mkdirSync('bin'); fs.writeFileSync('bin/py', '#!/bin/sh\n[ "$1" = "-3" ] && shift\nexec python3 "$@"\n', { mode: 0o755 });
process.env.PATH = path.join(TMP, 'bin') + ':' + process.env.PATH;
fs.writeFileSync('credentials.json', JSON.stringify({ hct: { company: 'TEST', user: 'test', pass: 'test' } }));   // 假帳密，只給假新竹用

// ---- 載入 b2c-start.js（補匯出 hctLogin 給舊版測試用）----
function load() {
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-start.js'), 'utf8');
  if (!/_test: \{[^}]*hctLogin/.test(src)) src = src.replace('_test: {', '_test: { hctLogin, ');
  src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`).replace(/const SCRIPT_DIR = '.*?';/, `const SCRIPT_DIR = ${JSON.stringify(path.join(TMP, 'scripts'))};`);
  const file = path.join(TMP, 'b2c-start.under-test.js');
  fs.writeFileSync(file, src);
  delete require.cache[file];
  return require(file);
}
const realFetch = global.fetch;
global.fetch = async (u, o) => (String(u).startsWith('http://127.0.0.1:8080') ? { json: async () => ({ ok: true, version: 'fake' }) } : realFetch(u, o));

// ---- 假 Firestore ----
function fakeDb() {
  const docs = new Map(); let seq = 0;
  const mkRef = (id) => ({ id,
    get: async () => ({ exists: docs.has(id), id, data: () => JSON.parse(JSON.stringify(docs.get(id))) }),
    update: async (o) => { docs.set(id, Object.assign(docs.get(id) || {}, JSON.parse(JSON.stringify(o)))); },
    set: async (o) => { docs.set(id, JSON.parse(JSON.stringify(o))); } });
  const query = (filters) => ({
    where: (f, op, v) => query(filters.concat([[f, v]])),
    get: async () => ({ docs: [...docs.entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id, d]) => ({ id, data: () => JSON.parse(JSON.stringify(d)), ref: mkRef(id) })) }) });
  return { docs, collection: () => Object.assign(query([]), { doc: (id) => mkRef(id), add: async (o) => { const id = 'd' + (++seq); docs.set(id, JSON.parse(JSON.stringify(o))); return mkRef(id); } }) };
}

// ---- 假新竹 ----
const H = 'https://apsweb.hct.com.tw/SCTM/';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function hctSite(cfg) {
  const st = { loggedIn: false, loginServed: 0, uploads: 0, labelsPrinted: 0, unprinted: [...(cfg.unprinted || [])], printed: [...(cfg.printed || [])] };
  const html = (b) => ({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset=utf-8>' + b });
  const row = (r) => `<tr><td><input type=checkbox id="cb_${r.no}"></td><td>${r.track}</td><td>${r.name}<br>(${r.phone})</td></tr>`;
  st.handle = async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.replace('/SCTM/', '');
    if (p === 'Login' && req.method() === 'POST') { st.loggedIn = true; return route.fulfill(html(main())); }
    if (p === '' || p === 'Default.aspx') {
      if (st.loggedIn) return route.fulfill(html(main()));
      st.loginServed++;
      const expire = cfg.expireFirstLogin && st.loginServed === 1;   // 11/20 的情況：等驗證碼時登入頁已經變了
      return route.fulfill(html(`<form method=post action="Login"><input id=ctl00_Enterprise><input id=ctl00_username><input id=ctl00_password type=password>
        <img id=imgCode style="width:60px;height:20px" src="data:image/png;base64,${PNG}"><input id=ctl00_txt_input><input type=submit id=ctl00_Button1 value=登入></form>
        ${expire ? '<script>setTimeout(()=>{document.body.innerHTML="<h1>逾時，請重新登入</h1>"},2000)</script>' : ''}`));
    }
    if (p === 'Updata.aspx' && req.method() === 'GET') return route.fulfill(html(`<form method=post enctype="multipart/form-data" action="Updata.aspx">
        <input id=Date_Txt name=d><select id=ExeclDdl name=x><option value="">請選</option><option value="心茶">心茶上傳</option></select>
        <input type=file id=FileUpload1 name=f><input type=submit id=SendBtn value=上傳></form>`));
    if (p === 'Updata.aspx') {
      st.uploads++;
      for (const o of cfg.homeOrders) st.unprinted.push(Object.assign({ track: '38566' + (26000 + st.uploads) + o.no.slice(-3) }, o));
      return route.fulfill(html(`上傳完成，共 ${cfg.homeOrders.length} 筆<input id=batchid value="B${st.uploads}">`));
    }
    if (p === 'LabV2.aspx') {
      const d = u.searchParams.get('d') || '2026/11/19', y = u.searchParams.get('y') || '0';
      const list = y === '0' ? st.unprinted : st.printed;
      return route.fulfill(html(`<form method=get action="LabV2.aspx"><input id=Date_TxtV2 name=d value="${d}"><input type=hidden name=y value="${y}"><input type=submit id=confirmCondition value=查詢></form>
        <input type=radio name=yet id=YetRdo_0 ${y === '0' ? 'checked' : ''} onclick="location='LabV2.aspx?d=${encodeURIComponent(d)}&y=0'"><label for=YetRdo_0>未列印[${st.unprinted.length}]</label>
        <input type=radio name=yet id=YetRdo_1 ${y === '1' ? 'checked' : ''} onclick="location='LabV2.aspx?d=${encodeURIComponent(d)}&y=1'"><label for=YetRdo_1>已列印[${st.printed.length}]</label>
        <table>${list.map(row).join('')}</table><input type=button value="(P)標籤列印" onclick="fetch('Report/getFromBuffer.aspx?jobid=1')">`));
    }
    if (p === 'Report/getFromBuffer.aspx') { st.labelsPrinted++; st.printed.push(...st.unprinted); st.unprinted = []; return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4 fake' }); }
    return route.fulfill({ status: 404, body: 'nf ' + p });
  };
  function main() {
    return `<div id=m2140>寄貨</div><iframe id=fr style="width:900px;height:500px"></iframe>
      <script>var url2140='Updata.aspx',p2140=1,url2210='LabV2.aspx',p2210=2;function chgPage(u){document.getElementById('fr').src=u;}</script>`;
  }
  return st;
}

// ---- 一個情境 ----
async function scenario(name, cfg, run) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(); ctx.setDefaultTimeout(5000);
  const site = hctSite(cfg);
  await ctx.route('https://apsweb.hct.com.tw/**', site.handle);
  const page = await ctx.newPage();
  const db = fakeDb(), logs = [];
  const W = { db, COL_JOB: 'jobs', pageFor: async () => page, browser: async () => ctx };
  // 自動回答 ask：驗證碼回 1234；決定題照情境
  let stop = false; const asked = [];
  (async () => {
    while (!stop) {
      for (const [id, d] of db.docs) {
        if (d.ask && !d.ask._answered) {
          d.ask._answered = true; asked.push(d.ask.kind + ':' + d.ask.msg.split('\n')[0]);
          // 人直接在工作程式的 Chrome 輸入驗證碼登入（11/20 下午 Jay 的做法）；chromeThenWeb＝之後又在網頁回答一次
          if (d.ask.kind === 'captcha' && (cfg.chromeLogin || cfg.chromeThenWeb)) {
            await page.fill('#ctl00_txt_input', '9999').catch(() => {}); await page.click('#ctl00_Button1').catch(() => {});
            if (cfg.chromeLogin) continue;
            await new Promise((r) => setTimeout(r, 300));
          }
          const value = d.ask.kind === 'captcha' ? '1234' : (cfg.decide || (() => '停止'))(d.ask);
          db.docs.set('ans' + Date.now(), { type: 'b2cAnswer', parent: id, askId: d.ask.id, value, by: 'tester' });
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  let out, err;
  try { out = await run({ mod: load()(W), db, logs, log: async (s) => { logs.push(s); } }); } catch (e) { err = e; }
  stop = true; await browser.close();
  return { name, out, err, site, logs, asked, db };
}
const results = [];
const want = (k) => !process.env.ONLY || process.env.ONLY.includes(k);   // ONLY=A 只跑情境 A
function check(name, ok, detail) { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`); }

const ORDER = { no: '202611190380001162', name: '許鑫蓮', phone: '0965496840' };
async function parentJob(db, step) {
  const ref = await db.collection().add({ type: 'b2cStart', status: 'done', mmdd: '1120', label: '', by: 'Jay',
    result: { steps: Object.assign({ '整單': { ok: true, orders: 10, home: 1, file: LOGI_REL } }, step ? { '新竹上傳＋託運單': step } : {}) } });
  return ref.id;
}
async function runRetry({ mod, db, log }, pid) {
  const ref = await db.collection().add({ type: 'b2cStart', only: 'hct', parent: pid, status: 'running', mmdd: '1120', hctDate: '2026/11/20' });
  const job = (await ref.get()).data();
  return mod.handlers.b2cStart(ref, job, log);
}

(async () => {
  // A. 11/20 實際情況：等驗證碼時登入頁變了 → 舊版 page.fill 逾時；新版重開登入頁、再問一次就登入
  if (want('A')) {
    const r = await scenario('A', { expireFirstLogin: true, homeOrders: [ORDER] }, async ({ mod, db, log }) => {
      const ref = await db.collection().add({ type: 'b2cStart', status: 'running' });
      return mod._test.hctLogin(ref, log);
    });
    check('A 等驗證碼時登入頁過期，仍能登入', !r.err && r.site.loggedIn, r.err && r.err.message.split('\n')[0]);
  }
  // B. 補上傳：原本新竹步驟失敗（沒上傳）→ 上傳 1 次、託運單產生
  if (want('B')) {
    const r = await scenario('B', { homeOrders: [ORDER] }, async (c) => runRetry(c, await parentJob(c.db, { ok: false, error: "page.fill: Timeout 30000ms exceeded ... '#ctl00_txt_input'" })));
    const pdf = path.join(DL, '心茶1120', '心茶1120新竹託運單.pdf');
    check('B 補上傳：上傳 1 次＋託運單', !r.err && r.site.uploads === 1 && r.site.labelsPrinted === 1 && fs.existsSync(pdf),
      `err=${r.err && r.err.message} uploads=${r.site.uploads} labels=${r.site.labelsPrinted}\n      ${r.logs.slice(-4).join('\n      ')}`);
  }
  // C. 已經補上傳成功過 → 再按要擋下來，不上傳
  if (want('C')) {
    const r = await scenario('C', { homeOrders: [ORDER] }, async (c) => {
      const pid = await parentJob(c.db, { ok: false, error: 'x' });
      await c.db.collection().add({ type: 'b2cStart', only: 'hct', parent: pid, status: 'done', result: { steps: { '新竹上傳＋託運單': { ok: true, uploaded: { at: 't', orders: [ORDER.no] } } } } });
      return runRetry(c, pid);
    });
    check('C 補上傳成功過 → 擋下、不上傳', !!r.err && /已經完成/.test(r.err.message) && r.site.uploads === 0, `err=${r.err && r.err.message} uploads=${r.site.uploads}`);
  }
  // D. 上傳成功但託運單失敗 → 補上傳只補託運單，不再上傳
  if (want('D')) {
    const r = await scenario('D', { homeOrders: [ORDER], unprinted: [Object.assign({ track: '3856600001' }, ORDER)] }, async (c) =>
      runRetry(c, await parentJob(c.db, { ok: false, error: '新竹標籤 PDF 90 秒內沒有產生', uploaded: { at: '2026-11-20T03:00:00Z', orders: [ORDER.no], batch: 'B0' } })));
    check('D 已上傳只差託運單 → 不再上傳', !r.err && r.site.uploads === 0 && r.site.labelsPrinted === 1, `err=${r.err && r.err.message} uploads=${r.site.uploads}`);
  }
  // E. 有人在新竹手動上傳過（已列印清單有同電話）→ 問人；選「已經傳過了」→ 不上傳
  if (want('E')) {
    const r = await scenario('E', { homeOrders: [ORDER], printed: [Object.assign({ track: '3856609999' }, ORDER)], decide: () => '停止' }, async (c) =>
      runRetry(c, await parentJob(c.db, { ok: false, error: 'x' })));
    check('E 新竹已有同電話 → 先問人，選停止就不上傳', !!r.err && r.site.uploads === 0 && r.asked.some((a) => /已經有這些收件人/.test(a)),
      `err=${r.err && r.err.message} uploads=${r.site.uploads} asked=${r.asked.join(' | ')}`);
  }
  // F. 新竹清單沒有這張 → 不問、直接上傳（正常流程不多打擾）
  if (want('F')) {
    const r = await scenario('F', { homeOrders: [ORDER], printed: [{ no: '202611150370003841', name: '別人', phone: '0958716616', track: '3856626196' }] }, async (c) =>
      runRetry(c, await parentJob(c.db, { ok: false, error: 'x' })));
    check('F 新竹沒有重複 → 直接上傳、不多問', !r.err && r.site.uploads === 1 && !r.asked.some((a) => a.startsWith('decision')), `err=${r.err && r.err.message} asked=${r.asked.join(' | ')}`);
  }
  // G. 人直接在 Chrome 登入、網頁沒回答 → 不用等回答，直接上傳
  if (want('G')) {
    const r = await scenario('G', { homeOrders: [ORDER], chromeLogin: true }, async (c) => runRetry(c, await parentJob(c.db, { ok: false, error: 'x' })));
    check('G 在 Chrome 直接登入 → 繼續上傳', !r.err && r.site.uploads === 1, `err=${r.err && r.err.message}\n      ${r.logs.slice(-5).join('\n      ')}`);
  }
  // H. 11/20 下午實際情況：在 Chrome 登入，又在網頁回答 → 不能把已登入的頁面當成出錯
  if (want('H')) {
    const r = await scenario('H', { homeOrders: [ORDER], chromeThenWeb: true }, async (c) => runRetry(c, await parentJob(c.db, { ok: false, error: 'x' })));
    check('H 在 Chrome 登入又在網頁回答 → 繼續上傳', !r.err && r.site.uploads === 1, `err=${r.err && r.err.message}\n      ${r.logs.slice(-5).join('\n      ')}`);
  }
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 通過`);
  process.exit(fail ? 1 : 0);
})();
