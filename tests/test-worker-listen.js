// 工作程式監聽斷線的回歸測試（規格第 10 節）：假 Firestore＋假瀏覽器，跑真的 b2b-worker.js 的 main()
// 用法：node test-worker-listen.js <放 b2b-worker.js 的資料夾>
// 情境：11/23 網路斷線 → 監聽收到「Exceeded maximum number of retries allowed」→ 之後送出的工作要被執行，而且只執行一次。
'use strict';
const path = require('path'), Module = require('module');
const SRC = path.resolve(process.argv[2], 'b2b-worker.js');

// ---- 假 Firestore（只做 b2b-worker.js 用到的部分）----
const docs = new Map(); let seq = 0; const qListeners = [];
const clone = (o) => JSON.parse(JSON.stringify(o));
const { noUndefined } = require('./firestore-strict');
const snapDoc = (col, id) => ({ id, exists: docs.has(col + '/' + id), ref: ref(col, id), data: () => (docs.has(col + '/' + id) ? clone(docs.get(col + '/' + id)) : undefined) });
function ref(col, id) {
  const k = col + '/' + id;
  return { id,
    get: async () => snapDoc(col, id),
    // 非 async：跟真的一樣碰到 undefined 同步丟錯（規格第 12 節；原本 JSON 複製會默默丟掉 undefined）
    set: (o, opt) => { noUndefined(o, 'Set()'); docs.set(k, Object.assign(opt && opt.merge ? (docs.get(k) || {}) : {}, clone(o))); emit(); return Promise.resolve(); },
    update: (o) => { noUndefined(o, 'Update()'); docs.set(k, Object.assign(docs.get(k) || {}, clone(o))); emit(); return Promise.resolve(); },
    onSnapshot: (next) => { next(snapDoc(col, id)); return () => {}; } };
}
function query(col, filters) {
  const match = () => [...docs.keys()].filter((k) => k.startsWith(col + '/')).map((k) => k.slice(col.length + 1))
    .filter((id) => filters.every(([f, , v]) => docs.get(col + '/' + id)[f] === v));
  return {
    where: (f, op, v) => query(col, filters.concat([[f, op, v]])),
    get: async () => ({ docs: match().map((id) => snapDoc(col, id)) }),
    onSnapshot: (next, err) => {
      const L = { active: true, seen: new Set(), next, err, col, match };
      qListeners.push(L); setImmediate(() => deliver(L));
      return () => { L.active = false; };
    },
  };
}
function deliver(L) {
  if (!L.active) return;
  const now = L.match(), added = now.filter((id) => !L.seen.has(id));
  L.seen = new Set(now);
  if (added.length || !L.started) { L.started = true; const ch = added.map((id) => ({ type: 'added', doc: snapDoc(L.col, id) })); L.next({ docChanges: () => ch, docs: now.map((id) => snapDoc(L.col, id)) }); }
}
function emit() { for (const L of qListeners) setImmediate(() => deliver(L)); }
const db = {
  collection: (col) => Object.assign(query(col, []), { doc: (id) => ref(col, id), add: (o) => { noUndefined(o, 'Add()'); const id = 'j' + (++seq); docs.set(col + '/' + id, clone(o)); emit(); return Promise.resolve(ref(col, id)); } }),
};
// 模擬網路斷線：所有清單監聽收到錯誤（Firestore 給錯誤後監聽就結束，不會再送資料）
function breakListeners(msg) { for (const L of qListeners) if (L.active) { L.active = false; L.err(new Error(msg)); } }

// ---- 換掉外部套件 ----
let runs = 0;
const fakes = {
  'firebase-admin': { initializeApp() {}, credential: { cert: () => ({}) }, firestore: () => db },
  'playwright-core': { chromium: { launchPersistentContext: async () => ({ on() {}, pages: () => [], newPage: async () => ({}) }) } },
  './remote-screen': () => ({}),
  './b2c-ship': () => ({}),
  './b2c-start': () => ({ handlers: { b2cStart: async () => { runs++; return { ok: true }; } }, guard: (h) => h }),
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (fakes[req]) return fakes[req];
  if (/firebase-key\.json$/.test(req)) return {};
  return origLoad.apply(this, arguments);
};
global.fetch = async () => { throw new Error('測試不連網'); };
const quiet = console.log; console.log = () => {}; console.error = () => {};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  require(SRC);
  await wait(500);
  const results = [];
  const check = (name, ok, info) => { results.push(ok); quiet(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

  // 1. 斷線前：送出的工作會執行
  await db.collection('xintea_b2b_jobs').add({ type: 'b2cStart', status: 'queued' });
  await wait(500);
  check('斷線前送出的工作有執行', runs === 1, `執行 ${runs} 次`);

  // 2. 斷線 → 監聽出錯
  breakListeners('Exceeded maximum number of retries allowed.');
  await wait(300);
  const w = (docs.get('xintea_b2b_jobs/_worker') || {});
  check('斷線時 _worker 標成重試中', w.listen === 'retrying', `listen=${w.listen}`);

  // 3. 斷線後送出的工作（11/23 13:17 的第 2 段）
  const r2 = await db.collection('xintea_b2b_jobs').add({ type: 'b2cStart', status: 'queued' });
  for (let i = 0; i < 40 && runs < 2; i++) await wait(250);
  await wait(1500);
  const st = docs.get('xintea_b2b_jobs/' + r2.id).status;
  check('斷線後送出的工作有執行（11/23 卡在排隊中）', st === 'done', `狀態 ${st}`);
  check('沒有重複執行', runs === 2, `總共執行 ${runs} 次`);
  check('接回後 _worker 標成正常', (docs.get('xintea_b2b_jobs/_worker') || {}).listen === 'ok');

  quiet(results.every(Boolean) ? `全部通過 ${results.length}/${results.length}` : `失敗 ${results.filter((x) => !x).length}/${results.length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch((e) => { quiet('測試本身出錯：', e); process.exit(2); });
