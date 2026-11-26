// xintea-b2b.html（回報頁）結構檢查
// 用法：node test-b2b-web.js [xintea-b2b.html 路徑]
// 2026-11-26（Jay）：已完成的採購單預設隱藏（收在「已完成 N 張」裡，點開才看到；搜尋到已完成的單會自動展開）
'use strict';
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.resolve(process.argv[2] || path.join(__dirname, '..', 'xintea-b2b.html')), 'utf8');
const results = [];
const check = (name, ok, info) => { results.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${name}${info ? '（' + info + '）' : ''}`); };

check('已完成的單收在 <details>（預設不展開）', /<details id="doneBox"(?![^>]*\sopen)[^>]*>/.test(html));
check('摘要寫「已完成 N 張」', /已完成 \$\{doneAll\} 張/.test(html));
check('搜尋到已完成的單會自動展開', /if \(q && done\.length\) \$\('doneBox'\)\.open = true/.test(html));
check('不再直接列出「最近已回報」', !/<h3>最近已回報/.test(html));
check('未完成清單照舊（listOpen）', /id="listOpen"/.test(html) && /x\.p\.status !== 'done'/.test(html));
const ver = (html.match(/const APP_VERSION = '(v[\d-]+)'/) || [])[1];
check('版本號有更新', ver && ver > 'v2026-11-24-1', ver);

const bad = results.filter((x) => !x).length;
console.log(bad ? `失敗 ${bad}/${results.length}` : `全部通過 ${results.length}/${results.length}`);
process.exit(bad ? 1 : 0);
