// 旺季單量模擬（規格第 14 節）：託運單 OCR 耗時
// 用法：node bench_ocr.js <playwright-core 所在的 node_modules> <託運單 PDF ...> --pages N
// 跟 shipment.html 一樣：pdf.js 以 scale 2 轉圖、tesseract.js 5.0.4「chi_tra+eng」、共用一個 worker（v123 起的做法）。
// 只開無頭 Chrome、不連 Firestore、不登入任何網站（只從 CDN 載 pdf.js、tesseract.js 和語言檔，跟正式頁面一樣）。
// shipment.html 每頁還會切塊、旋轉重試、數字區另跑 eng，正式的每頁次數比這裡多，所以這裡量的是「每頁最少要花的 OCR 時間」。
'use strict';
const path = require('path'), fs = require('fs');
const args = process.argv.slice(2);
const { chromium } = require(path.join(args[0], 'playwright-core'));
const pi = args.indexOf('--pages'); const PAGES = pi > 0 ? Number(args[pi + 1]) : 20;
const pdfs = args.slice(1, pi > 0 ? pi : undefined);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.setContent(`<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js"></script>`, { waitUntil: 'load' });
  const out = [];
  for (const f of pdfs) {
    const b64 = fs.readFileSync(f).toString('base64');
    const r = await page.evaluate(async ({ b64, PAGES }) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const bin = atob(b64), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const t0 = performance.now();
      window.__w = window.__w || await Tesseract.createWorker('chi_tra+eng');
      const init = performance.now() - t0;
      const times = []; let chars = 0;
      for (let i = 0; i < PAGES; i++) {
        const t = performance.now();
        const p = await pdf.getPage(1 + (i % pdf.numPages));
        const vp = p.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const { data } = await window.__w.recognize(c);
        chars = data.text.length;
        times.push(Math.round(performance.now() - t));
      }
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      return { init: Math.round(init), times, chars, mem, pdfPages: pdf.numPages };
    }, { b64, PAGES });
    const avg = r.times.reduce((a, b) => a + b, 0) / r.times.length;
    const first = r.times.slice(0, 5), last = r.times.slice(-5);
    out.push({ file: path.basename(f), pages: PAGES, initMs: r.init, avgMs: Math.round(avg), first5: first, last5: last, textChars: r.chars, heapMB: r.mem });
    console.log(JSON.stringify(out[out.length - 1]));
  }
  await browser.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
