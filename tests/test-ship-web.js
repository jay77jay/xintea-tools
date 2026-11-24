// 規格第 13 節：xintea-ship.html 的網頁部分
// 用法：node test-ship-web.js [xintea-ship.html 路徑]
// ① 有「最早可出廠日 從／到」、送出帶 shipFrom／shipTo；② 改成選第 1 段那次（run1Choices 純函式）、送出帶 parent；卡片顯示出廠日。
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = path.resolve(process.argv[2] || path.join(__dirname, '..', 'xintea-ship.html'));
const html = fs.readFileSync(HTML, 'utf8');
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

// ---- 頁面結構 ----
check('① 有 最早可出廠日 從／到 兩個日期欄', /id="shipFrom"/.test(html) && /id="shipTo"/.test(html));
check('① 送出的工作帶 shipFrom、shipTo', /type: 'b2cStart'[^\n]*shipFrom[^\n]*shipTo/.test(html));
check('① 今天用台灣時區（不用 toISOString 取日期）', /function todayTW\(/.test(html) && /Asia\/Taipei/.test(html));
check('② 有選第 1 段那次的選單', /id="run1"/.test(html));
check('② 送出的工作帶 parent', /type: 'b2cShip'[^\n]*parent/.test(html));
check('② 舊的打 MMDD 留在「進階」', /<details[^>]*>[\s\S]{0,300}id="mmdd"/.test(html));
check('卡片顯示出廠日', /出廠日 \$\{/.test(html) || /shipDate/.test(html.slice(html.indexOf('function renderStart'))));
const ver = (html.match(/const VERSION = '(xintea-ship-[\d-]+)'/) || [])[1];
check('版本號有更新', ver && ver > 'xintea-ship-2026-11-23-2', ver);
// 規格 14-3 ④：先 OCR（b2cOcr）
check('④ 監聽的工作類型含 b2cOcr', /'in', \[[^\]]*'b2cOcr'/.test(html));
check('④ 有「再抓 Drive＋先 OCR」按鈕，送出 b2cOcr 帶 parent、drive:true', /type: 'b2cOcr'[^\n]*parent[^\n]*drive: true/.test(html) || /type: 'b2cOcr'[^\n]*drive: true[^\n]*parent/.test(html));
check('④ 有先 OCR 的卡片（renderOcr）', /function renderOcr\(/.test(html));
check('④ 第 1 段卡片顯示先 OCR 的狀態（認出／要人工）', /要人工/.test(html.slice(html.indexOf('function renderStart'), html.indexOf('function renderShip'))));
check('④ 版本號 > xintea-ship-2026-11-24-1', ver && ver > 'xintea-ship-2026-11-24-1', ver);

// ---- run1Choices（純函式）----
const from = html.indexOf('function run1Choices('), to = html.indexOf('/* ---- end run1Choices ---- */');
if (from < 0 || to < 0) { check('找得到 run1Choices', false); }
else {
  const ctx = {}; vm.createContext(ctx); vm.runInContext(html.slice(from, to) + '\nthis.f = run1Choices;', ctx);
  const NOW = Date.parse('2026-11-24T08:00:00Z'), ago = (d) => new Date(NOW - d * 86400e3).toISOString();
  const S = (id, o) => Object.assign({ id, type: 'b2cStart', status: 'done', label: '上午', createdAt: ago(0) }, o);
  const jobs = [
    S('a', { mmdd: '1124', createdAt: ago(0.2), result: { mmdd: '1124', shipDate: '2026-11-30' } }),
    S('b', { mmdd: '1201', label: '下午', createdAt: ago(0.1), result: { mmdd: '1201', shipDate: '2026-12-01' } }),
    S('c', { mmdd: '1123', createdAt: ago(1), result: { mmdd: '1123' } }),                       // 第 13 節以前（沒有出廠日）
    S('d', { mmdd: '1124', dryRun: true, result: { mmdd: '1124', shipDate: '2026-11-24' } }),   // 試跑
    S('e', { mmdd: '1124', status: 'error' }),                                                   // 失敗
    S('f', { mmdd: '1124', only: 'giftbox', result: { mmdd: '1124' } }),                         // 重跑禮盒
    S('g', { mmdd: '1124', only: 'hct', result: { mmdd: '1124' } }),                             // 補上傳新竹
    S('h', { mmdd: '1101', createdAt: ago(20), result: { mmdd: '1101' } }),                      // 太舊
    { id: 's1', type: 'b2cShip', status: 'done', parent: 'a', mmdd: '1124', createdAt: ago(0.05) },
  ];
  const out = ctx.f(jobs, NOW);
  check('只列完成、非試跑、一般的第 1 段（14 天內）', JSON.stringify(out.map((x) => x.id)) === '["b","a","c"]', JSON.stringify(out.map((x) => x.id)));
  const b = out.find((x) => x.id === 'b') || {};
  check('選項文字：心茶1201（下午）→ 出廠日 12/01', /心茶1201（下午）→ 出廠日 12\/01/.test(b.text || ''), b.text);
  check('mmdd 用實際資料夾（result.mmdd）', b.mmdd === '1201', b.mmdd);
  const a = out.find((x) => x.id === 'a') || {};
  check('第 2 段已跑過的那次有標示', /第 2 段已跑過/.test(a.text || '') && !/第 2 段已跑過/.test(b.text || ''), a.text);
  const c = out.find((x) => x.id === 'c') || {};
  check('沒有出廠日的舊紀錄也列出（不寫出廠日）', /心茶1123（上午）/.test(c.text || '') && !/出廠日/.test(c.text || ''), c.text);
}

const bad = results.filter((x) => !x).length;
console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
process.exit(bad ? 1 : 0);
