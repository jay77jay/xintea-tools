// 旺季單量模擬（規格第 14 節）：shipment.html 產生「訂單明細」列印檔的耗時、大小、記憶體
// 用法：node bench_pdf.js <playwright-core 所在的 node_modules> <訂單明細 PDF 範本> 300 600 900
// 跟 shipment.html 一樣用 pdf-lib 1.17.1：原始檔載入一次（pdfLibCache），每單 copyPages 一頁到新文件，最後 save()。
// 只開無頭 Chrome，不連 Firestore、不存檔、不送印。
'use strict';
const path = require('path'), fs = require('fs');
const [nm, tpl, ...sizes] = process.argv.slice(2);
const { chromium } = require(path.join(nm, 'playwright-core'));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-precise-memory-info'] });
  for (const n of sizes.map(Number)) {
    const page = await browser.newPage();   // 每個單量開新分頁，跟每天重新開 shipment.html 一樣
    await page.setContent('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>', { waitUntil: 'load' });
    const b64 = fs.readFileSync(tpl).toString('base64');
    const t0 = Date.now();
    const r = await page.evaluate(async ({ b64, n }) => {
      const bin = atob(b64), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const src = await PDFLib.PDFDocument.load(buf);
      const out = await PDFLib.PDFDocument.create();
      const t = performance.now();
      for (let i = 0; i < n; i++) { const [cp] = await out.copyPages(src, [i % src.getPageCount()]); out.addPage(cp); }
      const tCopy = performance.now() - t;
      const heapCopy = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      const bytes = await out.save();
      return { copyS: +(tCopy / 1000).toFixed(1), saveS: +((performance.now() - t - tCopy) / 1000).toFixed(1), mb: Math.round(bytes.length / 1048576), heapMB: heapCopy };
    }, { b64, n }).catch((e) => ({ error: e.message.slice(0, 200) }));
    console.log(JSON.stringify(Object.assign({ orders: n, totalS: +((Date.now() - t0) / 1000).toFixed(1) }, r)));
    await page.close().catch(() => {});
  }
  await browser.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
