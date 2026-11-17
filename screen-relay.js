// 遠端畫面（screen-relay.js）— xintea-ship.html、xintea-b2b.html 共用
// 電腦上的 B2B 工作程式卡在需要人操作的網頁時（例如 EIP 登入），會把截圖寫在工作文件的 ask（kind:'screen'）。
// 這裡監聽執行中的工作，跳出畫面讓人點（手機也行）；點的位置、輸入的文字寫成 b2cAnswer，工作程式在電腦上照做。
(function () {
  'use strict';
  const VERSION = 'screen-relay-2026-11-17-1';
  const COL = 'xintea_b2b_jobs';
  let cur = null;        // { jobId, ask }
  let hiddenId = null;   // 按「縮小」時的 ask.id
  let sentFor = null;    // 已送出回答的 ask.id（等新畫面）
  let unsub = null;

  const css = `
  #sr-wrap{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:10px;box-sizing:border-box;font-family:system-ui,'Microsoft JhengHei',sans-serif}
  #sr-card{background:#fff;border-radius:12px;max-width:1000px;width:100%;padding:12px;box-sizing:border-box}
  #sr-card h3{margin:0 0 4px;font-size:16px}
  #sr-sub{color:#666;font-size:13px;margin-bottom:8px}
  #sr-scroll{overflow:auto;border:1px solid #ccc;border-radius:6px;max-height:70vh}
  #sr-imgbox{position:relative;cursor:crosshair;touch-action:manipulation;width:100%}
  #sr-imgbox.zoom{width:250%}
  #sr-img{display:block;width:100%;height:auto;user-select:none;-webkit-user-select:none}
  #sr-dot{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:3px solid #e53935;background:rgba(229,57,53,.25);display:none;pointer-events:none}
  #sr-busy{position:absolute;inset:0;background:rgba(255,255,255,.55);display:none;align-items:center;justify-content:center;font-weight:bold;color:#333}
  .sr-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
  .sr-row input{flex:1;min-width:140px;font-size:16px;padding:8px;border:1px solid #bbb;border-radius:6px}
  .sr-row button{font-size:15px;padding:8px 12px;border:0;border-radius:6px;background:#2e7d32;color:#fff;cursor:pointer}
  .sr-row button.g{background:#78909c}.sr-row button.r{background:#c62828}
  #sr-pill{position:fixed;right:12px;bottom:12px;z-index:99999;background:#e65100;color:#fff;border:0;border-radius:20px;padding:10px 16px;font-size:15px;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;display:none}`;

  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function setup() {
    if (document.getElementById('sr-wrap')) return;
    document.head.appendChild(el(`<style>${css}</style>`));
    const wrap = el(`<div id="sr-wrap" style="display:none"><div id="sr-card">
      <h3>📱 工作程式需要你操作畫面</h3><div id="sr-sub"></div>
      <div id="sr-scroll"><div id="sr-imgbox"><img id="sr-img" alt="工作程式畫面"><div id="sr-dot"></div><div id="sr-busy">已送出，等新畫面…</div></div></div>
      <div class="sr-row"><input id="sr-text" type="text" placeholder="要輸入的文字（先點畫面上的輸入框）" autocomplete="off" autocapitalize="off"><button id="sr-type">輸入</button></div>
      <div class="sr-row"><button class="g" data-key="Enter">Enter</button><button class="g" data-key="Tab">Tab</button><button class="g" data-key="Backspace">⌫ 刪除</button><button class="g" id="sr-reload">重新整理網頁</button><button class="g" id="sr-shot">重拍畫面</button><button class="g" id="sr-zoom">🔍 放大</button><span style="flex:1"></span><button class="g" id="sr-min">縮小</button><button class="r" id="sr-stop">停止這個工作步驟</button></div>
      <div id="sr-sub2" style="color:#888;font-size:12px;margin-top:6px">點畫面＝在電腦上點同一個位置。畫面約 20 秒自動更新一次；在電腦前直接操作也可以，完成後這個視窗會自動關掉。</div>
    </div></div>`);
    document.body.appendChild(wrap);
    document.body.appendChild(el(`<button id="sr-pill">📱 工作程式需要操作</button>`));
    const img = document.getElementById('sr-img');
    img.addEventListener('click', (e) => {
      if (!cur) return;
      const r = img.getBoundingClientRect();
      const x = Math.round((e.clientX - r.left) / r.width * (cur.ask.w || img.naturalWidth));
      const y = Math.round((e.clientY - r.top) / r.height * (cur.ask.h || img.naturalHeight));
      const dot = document.getElementById('sr-dot');
      dot.style.left = (e.clientX - r.left) + 'px'; dot.style.top = (e.clientY - r.top) + 'px'; dot.style.display = 'block';
      send({ act: 'click', x, y });
    });
    document.getElementById('sr-type').onclick = () => {
      const t = document.getElementById('sr-text'); if (!t.value) return;
      send({ act: 'type', text: t.value }); t.value = '';
    };
    document.getElementById('sr-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('sr-type').click(); });
    wrap.querySelectorAll('[data-key]').forEach((b) => { b.onclick = () => send({ act: 'key', key: b.dataset.key }); });
    document.getElementById('sr-reload').onclick = () => send({ act: 'reload' });
    document.getElementById('sr-zoom').onclick = (e) => { const z = document.getElementById('sr-imgbox').classList.toggle('zoom'); e.target.textContent = z ? '🔍 縮回' : '🔍 放大'; };
    document.getElementById('sr-shot').onclick = () => send({ act: 'shot' });
    document.getElementById('sr-stop').onclick = () => { if (confirm('停止這個步驟？工作會以失敗結束，之後可以重按一次。')) send({ act: 'stop' }); };
    document.getElementById('sr-min').onclick = () => { hiddenId = cur && cur.ask.id; render(); };
    document.getElementById('sr-pill').onclick = () => { hiddenId = null; render(); };
  }

  async function send(value) {
    if (!cur || sentFor === cur.ask.id) return;
    const u = firebase.auth().currentUser;
    if (!u) return alert('請先登入');
    sentFor = cur.ask.id; render();
    try {
      await firebase.firestore().collection(COL).add({ type: 'b2cAnswer', status: 'answer', parent: cur.jobId, askId: cur.ask.id, value,
        by: u.displayName || u.email, byEmail: u.email, createdAt: new Date().toISOString() });
    } catch (e) { sentFor = null; render(); alert('送出失敗：' + e.message); }
  }

  function render() {
    setup();
    const wrap = document.getElementById('sr-wrap'), pill = document.getElementById('sr-pill');
    if (!cur) { wrap.style.display = 'none'; pill.style.display = 'none'; return; }
    const hidden = hiddenId === cur.ask.id;
    wrap.style.display = hidden ? 'none' : 'flex'; pill.style.display = hidden ? 'block' : 'none';
    if (hidden) return;
    const img = document.getElementById('sr-img');
    if (img.dataset.id !== cur.ask.id) { img.src = cur.ask.img; img.dataset.id = cur.ask.id; document.getElementById('sr-dot').style.display = 'none'; }
    document.getElementById('sr-sub').textContent = `${cur.ask.msg || ''}（第 ${cur.ask.n || 1} 張畫面　${new Date(cur.ask.at).toLocaleTimeString('zh-TW', { hour12: false })}）`;
    document.getElementById('sr-busy').style.display = sentFor === cur.ask.id ? 'flex' : 'none';
  }

  function watch() {
    if (unsub) return;
    unsub = firebase.firestore().collection(COL).where('status', '==', 'running').onSnapshot((s) => {
      let found = null;
      s.forEach((d) => { const a = d.data().ask; if (a && a.kind === 'screen' && a.img) found = { jobId: d.id, ask: a }; });
      cur = found; render();
    }, (e) => console.warn('screen-relay 監聽失敗', e.message));
  }

  // 等頁面自己的 firebase 初始化＋登入完成
  const t = setInterval(() => {
    if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
    clearInterval(t);
    firebase.auth().onAuthStateChanged((u) => {
      if (u) watch(); else if (unsub) { unsub(); unsub = null; cur = null; render(); }
    });
  }, 500);
  window.SCREEN_RELAY_VERSION = VERSION;
})();
