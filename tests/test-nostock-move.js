// 無庫存舊單重傳後搬到「已重傳」被鎖住（EBUSY，2026-11-24 14:29 Jay 實測：檔案開在 Excel）
// 用法：node test-nostock-move.js <放 b2c-ship.js 的資料夾>
// SG 已經匯入成功（不能復原）之後，搬檔失敗不能讓整個工作失敗：
//   先寫 sg_uploads.json → 搬檔被鎖就隔幾秒重試 → 還是不行就寫 ⚠ 請手動搬、繼續；下一次第 2 段看到「傳過、還留在資料夾」的檔 → 先搬走、不再傳。
// 跑真的 b2c-ship.js 的 uploadOrders；DL 換成暫存資料夾、假 SG、假鎖（攔 fs.renameSync），快轉 sleep。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const SRC_DIR = path.resolve(process.argv[2]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nostockmove-'));
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => setImmediate(fn);
global.fetch = async (u) => { if (String(u).startsWith('https://sg.example/')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; throw new Error('測試不連網 ' + u); };

// 假鎖：檔名含 lockName 的 rename 前 lockTimes 次丟 EBUSY（lockTimes = Infinity 一直鎖）
const realRename = fs.renameSync;
let lock = { name: null, times: 0, tries: 0, onTry: null };
fs.renameSync = function (a, b) {
  if (lock.name && String(a).includes(lock.name)) {
    lock.tries++; if (lock.onTry) lock.onTry();
    if (lock.tries <= lock.times) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${a}' -> '${b}'`), { code: 'EBUSY' });
  }
  return realRename.apply(this, arguments);
};

let n = 0;
async function run({ lockTimes = 0, manifest = null, olds = ['無庫存訂單 心茶1124-1單.xlsx'], uploadedRecently = true } = {}) {
  const dir = path.join(TMP, 's' + (++n)), DL = path.join(dir, 'DL'), day = path.join(DL, '心茶1124'), NS = path.join(DL, '無庫存訂單--------');
  fs.mkdirSync(day, { recursive: true }); fs.mkdirSync(NS, { recursive: true });
  for (const o of olds) fs.writeFileSync(path.join(NS, o), 'x');
  if (manifest) fs.writeFileSync(path.join(day, 'sg_uploads.json'), JSON.stringify(manifest));
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-ship.js'), 'utf8').replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`);
  const file = path.join(dir, 'b2c-ship.under-test.js'); fs.writeFileSync(file, src);
  const S = require(file)({ db: null, COL_JOB: 'jobs' });
  const uploads = [];
  // 假 SG：檔名兩天內傳過 → 匯入清單有完成紀錄（沿用、不重傳）
  const rec = (name) => ({ file_name: '123_' + name, created_at: new Date().toISOString(), completed_at: 'now', result_file_url: 'https://sg.example/r.xlsx',
    result_file_name: 'order_import_result_' + name.replace(/\W/g, '') + '.xlsx', completed_rows: 1, failed_rows: 0, total_rows: 1 });
  const page = { evaluate: async (fn, a) => {
    if (a && a.b64) { uploads.push(a.name); return { status: 200, json: { filepath: '123_' + a.name }, text: '' }; }
    if (a && a.url === 'orders/import/list') return { status: 200, ok: true, json: { response: { data: (uploadedRecently ? olds : uploads).map(rec) } }, text: '' };
    throw new Error('假 SG 沒有這個呼叫');
  } };
  lock = { name: olds[0], times: lockTimes, tries: 0, onTry: () => { lock.manifestAtTry = fs.existsSync(path.join(day, 'sg_uploads.json')) ? JSON.parse(fs.readFileSync(path.join(day, 'sg_uploads.json'), 'utf8')) : null; } };
  const logs = []; let out = null, err = null;
  try { out = await S._test.uploadOrders(page, async (m) => logs.push(m), day, false, true); } catch (e) { err = e.message; }
  const man = fs.existsSync(path.join(day, 'sg_uploads.json')) ? JSON.parse(fs.readFileSync(path.join(day, 'sg_uploads.json'), 'utf8')) : null;
  const inNS = (x) => fs.existsSync(path.join(NS, x)), inResent = (x) => fs.existsSync(path.join(NS, '已重傳', x));
  return { out, err, logs, man, uploads, tries: lock.tries, manifestAtTry: lock.manifestAtTry, inNS, inResent };
}

(async () => {
  const F = '無庫存訂單 心茶1124-1單.xlsx';
  // a. 一直鎖住（Excel 開著）→ 工作不失敗、有結果、紀錄寫了、⚠ 請手動搬
  let r = await run({ lockTimes: Infinity });
  check('a 一直被鎖：只重傳無庫存不會失敗，照樣回傳匯入結果', !r.err && r.out && r.out.length === 1 && r.out[0].ok === 1, r.err || '');
  check('a 這一批有寫進 sg_uploads.json', r.man && r.man.batches.length === 1 && r.man.batches[0][0].name === F, JSON.stringify(r.man).slice(0, 160));
  check('a 搬檔前就先寫好紀錄（SG 已經匯入，不能因為搬檔沒記到）', r.manifestAtTry && r.manifestAtTry.batches.length === 1, JSON.stringify(r.manifestAtTry).slice(0, 120));
  check('a 有重試（不是一次失敗就放棄）', r.tries >= 3, r.tries + ' 次');
  check('a 執行紀錄寫 ⚠ 搬不動、請關掉檔案手動搬', r.logs.some((l) => /⚠/.test(l) && /已重傳/.test(l) && /手動/.test(l)), r.logs.join(' / '));
  check('a 結果記搬不動的檔（moveFailed）', r.out && r.out.moveFailed && r.out.moveFailed.includes(F), JSON.stringify(r.out && r.out.moveFailed));
  check('a 檔案還在無庫存資料夾（沒有不見）', r.inNS(F) && !r.inResent(F));
  // b. 鎖 2 次後放開 → 重試後搬成功、沒有 ⚠
  r = await run({ lockTimes: 2 });
  check('b 被鎖 2 次後放開：重試搬成功', !r.err && r.inResent(F) && !r.inNS(F), r.err || `tries=${r.tries}`);
  check('b 搬成功就沒有 ⚠', !r.logs.some((l) => /⚠/.test(l)), r.logs.join(' / '));
  // c. 沒鎖：照舊
  r = await run({});
  check('c 沒被鎖：照舊搬到已重傳、寫紀錄', !r.err && r.inResent(F) && r.man && r.man.batches.length === 1);
  // d. 上一批傳過、當時搬不動、還留在資料夾 → 這次先搬走、不再傳、不算進這一批
  const prev = { batches: [[{ kind: '無庫存舊單', name: F, ok: 1, fail: 0, total: 1, result: 'x.xlsx', at: '2026-11-24T06:29:00Z' }]] };
  r = await run({ manifest: prev, olds: [F, '無庫存訂單 心茶1124-2-3單.xlsx'], uploadedRecently: false });
  check('d 上次傳過、還留著的檔：這次不再傳', !r.uploads.includes(F) && r.uploads.includes('無庫存訂單 心茶1124-2-3單.xlsx'), JSON.stringify(r.uploads) + ' ' + (r.err || ''));
  check('d 上次傳過的檔：這次先搬到已重傳', r.inResent(F) && !r.inNS(F));
  check('d 這一批只算新的那個檔', r.out && r.out.length === 1 && r.out[0].name === '無庫存訂單 心茶1124-2-3單.xlsx', JSON.stringify((r.out || []).map((x) => x.name)));
  check('d 執行紀錄寫明', r.logs.some((l) => l.includes(F) && /傳過/.test(l)), r.logs.join(' / '));
  // e. 只有上次留下的檔 → 不用重傳（不能把它當成新的一批）
  r = await run({ manifest: prev, olds: [F], uploadedRecently: false });
  check('e 只剩上次傳過的檔：搬走後說沒有要重傳的檔', !!r.err && /沒有/.test(r.err) && r.inResent(F) && !r.uploads.length, r.err);

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  global.setTimeout = realSetTimeout; fs.renameSync = realRename;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
