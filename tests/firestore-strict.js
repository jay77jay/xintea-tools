// 假 Firestore 共用：碰到 undefined 就丟出跟真的 firebase-admin 一樣的錯（規格第 12 節）
// 真的 DocumentReference.update/set/add 是「同步」檢查參數、同步丟錯（不是回傳 rejected promise），
// 所以 `ref.update(x).catch(() => {})` 接不到，會讓外層的 async 函式失敗——11/24 第 1 段就是這樣卡住的。
// 假 Firestore 的 update/set/add 一定要是「非 async」函式，先呼叫 noUndefined()，再回傳 promise。
'use strict';
const seg = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : '`' + k + '`');
function findUndefined(v, p) {
  if (v === undefined) return p;
  if (v === null || typeof v !== 'object' || v instanceof Date) return null;
  for (const [k, x] of Object.entries(v)) {
    const r = findUndefined(x, p ? p + '.' + seg(k) : seg(k));
    if (r) return r;
  }
  return null;
}
/** op：'Update()'、'Set()'、'Add()' */
function noUndefined(data, op) {
  const at = findUndefined(data, '');
  if (at) {
    const what = op === 'Update()' ? 'Update() requires either a single JavaScript object or an alternating list of field/value pairs that can be followed by an optional precondition. Value for argument "dataOrField"'
      : `${op === 'Add()' ? 'Value for argument "data"' : 'Value for argument "data"'}`;
    throw new Error(`${what} is not a valid Firestore value. Cannot use "undefined" as a Firestore value (found in field "${at}"). If you want to ignore undefined values, enable \`ignoreUndefinedProperties\`.`);
  }
  return data;
}
module.exports = { noUndefined, findUndefined };
