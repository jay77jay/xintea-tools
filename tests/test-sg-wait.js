// SG出 上傳等 SG 匯入的時間（規格 14-2 第 1 項）：假 SG＋快轉的 sleep，跑真的 b2c-ship.js 的 uploadOrders
// 用法：node test-sg-wait.js <放 b2c-ship.js 的資料夾>
// 情境：900 單（約 1,650 列）的 SG出，SG 要 5 分鐘才處理完 → 舊版只等 3 分鐘就報錯；要等到、拿到結果。
// 只在暫存資料夾讀寫（DL 換成暫存資料夾，不會動到真的無庫存資料夾），不連 SG。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const SRC_DIR = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sgwait-'));
const DL = path.join(TMP, 'DL');

// ---- 載入 b2c-ship.js（DL 換成暫存；舊版沒有 _test 就補匯出 uploadOrders）----
let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-ship.js'), 'utf8');
src = src.replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`);
if (!/_test:/.test(src)) src = src.replace('return { b2cShip, b2cPrint, b2cConfirm };', 'return { b2cShip, b2cPrint, b2cConfirm, _test: { uploadOrders } };');
const file = path.join(TMP, 'b2c-ship.under-test.js');
fs.writeFileSync(file, src);

// ---- 快轉時間：setTimeout 立刻執行，但記下「假裝過了多久」----
let fakeMs = 0;
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { fakeMs += ms || 0; return setImmediate(fn); };

// ---- SG出 檔：N 列 ----
function sgOut(dayDir, name, rows) {
  fs.mkdirSync(dayDir, { recursive: true });
  const f = path.join(dayDir, name);
  execFileSync('py', ['-3', '-c', `import openpyxl,sys
wb=openpyxl.Workbook(); ws=wb.active; ws.append(['訂單編號'])
for i in range(int(sys.argv[2])): ws.append(['O%05d' % (i // 2)])
wb.save(sys.argv[1])`, f, String(rows)]);
  return f;
}

// ---- 假 SG：上傳後要 doneAfterMs（假時間）才處理完 ----
function fakeSG(doneAfterMs) {
  let upAt = null; const fp = 'store/9108/import/123_x.xlsx';
  return {
    page: { evaluate: async (fn, a) => {
      if (a && a.b64) { upAt = fakeMs; return { status: 200, json: { filepath: fp }, text: '' }; }
      if (a && a.url === 'orders/import/list') {
        const done = upAt != null && fakeMs - upAt >= doneAfterMs;
        const rec = upAt == null ? [] : [{ file_name: fp, created_at: new Date().toISOString(), completed_at: done ? 'now' : null,
          result_file_url: done ? 'https://sg.example/result.xlsx' : null, result_file_name: 'order_import_result_sim.xlsx', completed_rows: 800, failed_rows: 100, total_rows: 900 }];
        return { status: 200, ok: true, json: { response: { data: rec } }, text: '' };
      }
      throw new Error('假 SG 沒有這個呼叫：' + JSON.stringify(a).slice(0, 80));
    } },
  };
}
global.fetch = async (u) => { if (String(u).startsWith('https://sg.example/')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; throw new Error('測試不連網 ' + u); };

const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

async function run(n, rows, doneAfterMs) {
  const dayDir = path.join(DL, '心茶11' + n);
  sgOut(dayDir, '心茶202611' + n + 'SG出-1.xlsx', rows);
  delete require.cache[file];
  const S = require(file)({ db: null, COL_JOB: 'jobs' });
  const sg = fakeSG(doneAfterMs), logs = [];
  fakeMs = 0;
  try { const out = await S._test.uploadOrders(sg.page, async (m) => logs.push(m), dayDir, false, false); return { out, logs, waited: fakeMs }; }
  catch (e) { return { err: e.message, logs, waited: fakeMs }; }
}

(async () => {
  // 900 單：SG 5 分鐘處理完
  let r = await run(30, 1650, 5 * 60e3);
  check('900 單（1,650 列）SG 5 分鐘處理完：等到、拿到結果', r.out && r.out.length === 1 && r.out[0].ok === 800, r.err || `等了 ${Math.round(r.waited / 1000)} 秒`);
  check('等的時候每分鐘左右寫進度，不像當機', r.logs.filter((l) => /還在等 SG/.test(l)).length >= 3, r.logs.filter((l) => /還在等 SG/.test(l)).length + ' 行');
  // 900 單：SG 一直沒處理完 → 最後還是要停（不會無限等），訊息寫等了多久
  r = await run(31, 1650, 99 * 60e3);
  check('SG 一直沒處理完：最後報錯、不會無限等', !!r.err && /SG 還沒處理完/.test(r.err), r.err);
  check('1,650 列最多等約 14 分鐘（至少 3 分、每列 0.5 秒）', r.waited >= 13 * 60e3 && r.waited <= 15 * 60e3, `等了 ${Math.round(r.waited / 1000)} 秒`);
  check('錯誤訊息寫實際等了多久', !!r.err && /13 分 45 秒/.test(r.err), r.err);
  // 平常 10 單：照舊最多 3 分鐘
  r = await run(32, 18, 99 * 60e3);
  check('平常 10 單：最多還是等 3 分鐘', !!r.err && r.waited >= 170e3 && r.waited <= 190e3, `等了 ${Math.round(r.waited / 1000)} 秒`);
  r = await run(33, 18, 6e3);
  check('平常 10 單 SG 6 秒處理完：照常拿到結果', r.out && r.out.length === 1, r.err);

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  global.setTimeout = realSetTimeout;
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
