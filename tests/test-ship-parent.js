// 規格第 13 節：第 2 段選第 1 段那次（b2cShip 帶 parent＝第 1 段工作 id），用 parent 找資料夾和出廠日，對不上 出廠日.txt 就停
// 用法：node test-ship-parent.js <放 b2c-ship.js 的資料夾>
// 跑真的 b2c-ship.js 的 b2cShip；找到資料夾之後的第一步（SG 入庫）用假的 sgReady 擋下來，只看前面找資料夾的部分。
// 只在暫存資料夾讀寫（DL 換掉），不連 SG。
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { noUndefined } = require('./firestore-strict');
const SRC_DIR = path.resolve(process.argv[2]);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'shipparent-'));

function fakeDb() {
  const docs = new Map(); let seq = 0;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const mkRef = (id) => ({ id,
    get: async () => ({ exists: docs.has(id), id, data: () => (docs.has(id) ? clone(docs.get(id)) : undefined) }),
    update: (o) => { noUndefined(o, 'Update()'); docs.set(id, Object.assign(docs.get(id) || {}, clone(o))); return Promise.resolve(); },
    set: (o) => { noUndefined(o, 'Set()'); docs.set(id, clone(o)); return Promise.resolve(); } });
  return { docs, collection: () => ({ doc: (id) => mkRef(id), add: (o) => { noUndefined(o, 'Add()'); const id = 'd' + (++seq); docs.set(id, clone(o)); return Promise.resolve(mkRef(id)); } }) };
}

let n = 0;
async function run({ job, parent, folders = {} }) {
  const dir = path.join(ROOT, 's' + (++n)), DL = path.join(dir, 'DL');
  for (const [mmdd, ship] of Object.entries(folders)) {
    const d = path.join(DL, '心茶' + mmdd); fs.mkdirSync(d, { recursive: true });
    if (ship) fs.writeFileSync(path.join(d, '出廠日.txt'), ship);
  }
  let src = fs.readFileSync(path.join(SRC_DIR, 'b2c-ship.js'), 'utf8').replace(/const DL = '.*?';/, `const DL = ${JSON.stringify(DL)};`);
  const file = path.join(dir, 'b2c-ship.under-test.js'); fs.writeFileSync(file, src);
  const db = fakeDb();
  if (parent) await db.collection().doc('p1').set(parent);
  const S = require(file)({ db, COL_JOB: 'jobs', sgReady: async () => { throw new Error('STOP-SG（找資料夾通過）'); }, pageFor: async () => { throw new Error('x'); } });
  const realFetch = global.fetch;
  global.fetch = async (u) => { if (String(u).startsWith('http://127.0.0.1:8080')) return { json: async () => ({ ok: true, version: 'fake' }) }; throw new Error('測試不連網'); };
  const ref = await db.collection().add(Object.assign({ type: 'b2cShip', status: 'running' }, job));
  const logs = []; let err = null;
  try { await S.b2cShip(ref, job, async (m) => logs.push(m)); } catch (e) { err = e.message; }
  global.fetch = realFetch;
  return { err, logs, passed: /STOP-SG/.test(err || ''), partial: (db.docs.get(ref.id) || {}).partial || {} };
}
const P = (result, extra) => Object.assign({ type: 'b2cStart', status: 'done', label: '下午', mmdd: result.mmdd, result }, extra || {});

const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

(async () => {
  // a. 選第 1 段那次：用 parent 的資料夾（不管工作帶的 mmdd），記出廠日
  let r = await run({ job: { parent: 'p1', mmdd: '1124' }, parent: P({ mmdd: '1201', shipDate: '2026-12-01' }), folders: { '1124': '2026-11-30', '1201': '2026-12-01' } });
  check('a 用 parent 找到 心茶1201、出廠日 12/01', r.passed && r.logs.some((l) => /心茶1201/.test(l) && /2026-12-01/.test(l)), r.err + ' | ' + r.logs.join(' / '));
  check('a 結果記出廠日、資料夾', r.partial.mmdd === '1201' && r.partial.shipDate === '2026-12-01' && r.partial.parent === 'p1', JSON.stringify(r.partial).slice(0, 160));
  // b. 出廠日.txt 對不上 → 停
  r = await run({ job: { parent: 'p1', mmdd: '1201' }, parent: P({ mmdd: '1201', shipDate: '2026-12-01' }), folders: { '1201': '2026-12-02' } });
  check('b 出廠日.txt 對不上 → 停', !r.passed && /出廠日/.test(r.err || '') && /對不上/.test(r.err || ''), r.err);
  // c. 資料夾沒有出廠日.txt（第 1 段沒寫）→ 停
  r = await run({ job: { parent: 'p1', mmdd: '1201' }, parent: P({ mmdd: '1201', shipDate: '2026-12-01' }), folders: { '1201': null } });
  check('c 資料夾沒有出廠日.txt → 停', !r.passed && /出廠日\.txt/.test(r.err || ''), r.err);
  // d. parent 不是完成的第 1 段 → 停
  r = await run({ job: { parent: 'p1', mmdd: '1201' }, parent: P({ mmdd: '1201', shipDate: '2026-12-01' }, { status: 'error' }), folders: { '1201': '2026-12-01' } });
  check('d parent 沒有完成 → 停', !r.passed && /第 1 段/.test(r.err || ''), r.err);
  r = await run({ job: { parent: 'p1', mmdd: '1201' }, parent: P({ mmdd: '1201', shipDate: '2026-12-01' }, { dryRun: true }), folders: { '1201': '2026-12-01' } });
  check('d parent 是試跑 → 停', !r.passed && /試跑/.test(r.err || ''), r.err);
  r = await run({ job: { parent: 'nope', mmdd: '1201' }, folders: { '1201': '2026-12-01' } });
  check('d 找不到 parent → 停', !r.passed && /找不到/.test(r.err || ''), r.err);
  // e. 舊的打 MMDD（沒有 parent）→ 照舊
  r = await run({ job: { mmdd: '1124' }, folders: { '1124': null } });
  check('e 舊方式（只有 mmdd）照舊可以跑', r.passed, r.err);
  // f. 第 13 節以前的第 1 段（沒有 shipDate）→ 用它的資料夾、不檢查出廠日
  r = await run({ job: { parent: 'p1', mmdd: '1123' }, parent: P({ mmdd: '1123' }), folders: { '1123': null } });
  check('f 舊的第 1 段（沒有出廠日）：用它的資料夾、不檢查', r.passed && r.partial.mmdd === '1123', r.err);

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {}
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('測試本身出錯：', e); process.exit(2); });
