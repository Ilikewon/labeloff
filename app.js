(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = $('#app');

  const LAST_DAY = new Date('2026-12-31T00:00:00+09:00');
  const END = new Date('2027-01-01T00:00:00+09:00');
  const MAX_PICK = 3;
  const CRISIS_RE = /죽고\s*싶|자살|자해|사라지고\s*싶|살기\s*싫|죽어\s*버리/;
  const POST_COLORS = ['p1', 'p2', 'p3', 'p4', 'p5'];

  const Store = {
    get(k, d) { try { const v = localStorage.getItem('labeloff:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('labeloff:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // Shared storage is Firestore when firebase-config.js has a projectId; otherwise everything stays in this browser.
  const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const isShared = () => !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);
  let remote;
  function getRemote() {
    if (!isShared()) return Promise.resolve(null);
    if (!remote) {
      remote = Promise.all([import(FIREBASE_SDK + 'firebase-app.js'), import(FIREBASE_SDK + 'firebase-firestore.js')])
        .then(([app, fs]) => ({ fs, db: fs.getFirestore(app.initializeApp(window.FIREBASE_CONFIG)) }))
        .catch(() => null);
    }
    return remote;
  }
  const localListeners = {};

  const Api = {
    async getSpace(id) {
      const r = await getRemote();
      if (r) {
        try {
          const snap = await r.fs.getDoc(r.fs.doc(r.db, 'spaces', id));
          if (snap.exists()) return { id, ...snap.data() };
        } catch { /* fall back to the local copy */ }
      }
      return Store.get('space:' + id, null);
    },
    async saveSpace(s) {
      const r = await getRemote();
      const data = { nick: s.nick, text: s.text, k: s.k, t: s.t };
      if (s.img) data.img = s.img;
      if (s.cap) data.cap = s.cap;
      if (s.theme) data.theme = s.theme;
      if (s.labels && s.labels.length) data.labels = s.labels;
      if (r) await r.fs.setDoc(r.fs.doc(r.db, 'spaces', s.id), data);
      Store.set('space:' + s.id, s);
      const mine = Store.get('mySpaces', []);
      if (!mine.includes(s.id)) Store.set('mySpaces', [...mine, s.id]);
    },
    isMine: (id) => Store.get('mySpaces', []).includes(id),
    async watchList(key, path, cb, extra = []) {
      const r = await getRemote();
      const local = () => cb([...Store.get(key, []), ...extra]);
      if (!r) {
        (localListeners[key] = localListeners[key] || new Set()).add(local);
        local();
        return () => localListeners[key].delete(local);
      }
      const q = r.fs.query(r.fs.collection(r.db, ...path), r.fs.orderBy('t', 'desc'), r.fs.limit(200));
      return r.fs.onSnapshot(q, (snap) => cb([...snap.docs.map((d) => d.data()), ...extra]), local);
    },
    async addTo(key, path, n) {
      const r = await getRemote();
      if (r) { await r.fs.addDoc(r.fs.collection(r.db, ...path), n); return; }
      Store.set(key, [n, ...Store.get(key, [])]);
      (localListeners[key] || []).forEach((f) => f());
    },
  };
  const seedsFor = (lid) => (SEED_BOARD[lid] || []).map((n) => ({ ...n, seed: true }));

  const byId = (id) => LABELS.find((l) => l.id === id);
  const rot = (i) => ((i * 37) % 11) - 5;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
  const daysLeft = () => Math.max(0, Math.ceil((LAST_DAY - Date.now()) / 86400000));
  const dLabel = () => (daysLeft() ? `D-${daysLeft()}` : 'D-DAY');
  const baseUrl = () => location.href.split('#')[0];
  // Keep a number glued to the word it belongs to, so a line never breaks between "최대" and "3개".
  const GLUE = [
    [/(^|[\s('"“‘])(최대|최소|하루|매일|매주|주|총|약|첫|\d+년|\d+월) (\d)/g, '$1$2 $3'],
    [/(\d\S*) (이상|이하|미만|이내|동안|정도|중)(?=[\s,.)'"”’]|$)/g, '$1 $2'],
    [/(\d) (일|주|개월|시간|회|점|개|명)/g, '$1 $2'],
    [/(\S) (수|때|줄|뿐|듯|만큼)(?=[\s,.]|$)/g, '$1 $2'],
    [/(수|줄) (있|없|알)/g, '$1 $2'],
    [/([가-힣A-Za-z])·([가-힣A-Za-z])/g, '$1⁠·⁠$2'],
  ];
  // Short guide text starts each sentence on its own line (these elements use white-space: pre-line).
  const SENTENCE_BLOCKS = '.sub, .lead, .group-sub, .sw-note, .hint-note, .after-box > p, .invite p, .newyear p, .advice p, .peel-after, .lec-body p:not(.lec-meta)';
  function glue(root) {
    if (!root) return;
    if (root.nodeType === 3) root = root.parentNode;
    if (!root || !root.ownerDocument) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let t = n.nodeValue;
      GLUE.forEach(([re, to]) => { t = t.replace(re, to); });
      if (n.parentElement && n.parentElement.closest(SENTENCE_BLOCKS)) t = t.replace(/([.…?!]["”']?)[  ]+(?=\S)/g, '$1\n');
      if (t !== n.nodeValue) n.nodeValue = t;
    }
  }
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(glue))).observe(document.body, { childList: true, subtree: true });
  glue(document.body);

  let tick;
  let renderId = 0;
  let cleanups = [];
  // Subscriptions resolve asynchronously; drop any that land after the view has changed.
  function keep(stopPromise) {
    const mine = renderId;
    stopPromise.then((stop) => { if (mine === renderId) cleanups.push(stop); else stop(); }, () => {});
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch { window.prompt('아래 내용을 복사하세요', text); }
  }

  async function share({ title, text, url }) {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    copy(`${text}\n${url}`, '링크를 복사했어요. 친구에게 붙여넣어 보내보세요.');
  }

  const encode = (obj) => {
    let bin = '';
    new TextEncoder().encode(JSON.stringify(obj)).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const decode = (str) => {
    try {
      const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    } catch { return null; }
  };

  const crisisHtml = () => `<div class="crisis" role="alert"><b>혼자 견디지 않아도 돼요.</b> 지금 많이 힘들다면 <a href="tel:109">109</a> (자살예방상담전화, 24시간) 또는 <a href="tel:15770199">1577-0199</a> (정신건강위기상담)로 연락해 주세요. 당신의 이야기를 들어줄 사람이 있어요.</div>`;
  function showCrisis(text, host) {
    const hit = CRISIS_RE.test(text);
    host.innerHTML = hit ? crisisHtml() : '';
    host.hidden = !hit;
    return hit;
  }

  const BOWS = [
    '<svg class="bow" viewBox="0 0 112 44" aria-hidden="true"><path d="M56 36 C42 12 10 4 12 24 C14 40 38 42 56 36 Z"/><path d="M56 36 C70 12 102 4 100 24 C98 40 74 42 56 36 Z"/><rect x="49" y="27" width="14" height="17" rx="5"/></svg>',
    '<svg class="bow" viewBox="0 0 112 44" aria-hidden="true"><polygon points="4,44 16,10 30,34 42,2 56,30 70,0 82,30 96,6 106,34 110,44"/></svg>',
  ];
  const notesHtml = (list) => (list.length
    ? list.map((n, i) => `<article class="note ${POST_COLORS.includes(n.c) ? n.c : 'p1'}" style="--r:${rot(i) * 0.5}deg">${BOWS[i % 2]}<div class="gift-box"><p class="gift-name">${esc(n.from || '익명')}</p><p class="gift-msg">${esc(n.text)}</p><p class="gift-meta">${n.seed ? '예시 글' : n.t ? fmtDate(n.t) : ''}</p></div></article>`).join('')
    : '<p class="empty-note">아직 남겨진 메시지가 없어요. 첫 번째로 남겨주세요.</p>');

  const colorPicker = (name, label = '포스트잇 색') => `<div class="opts colors" role="radiogroup" aria-label="${label}">${POST_COLORS.map((c, i) => `<label class="opt ${c}"><input type="radio" name="${name}" value="${c}" ${i === 0 ? 'checked' : ''} aria-label="색 ${i + 1}"><span></span></label>`).join('')}</div>`;

  const IMG_PREFIX = 'data:image/jpeg;base64,';
  const stateOf = (text, k) => (k && STATES.find((x) => x.key === k)) || STATES.find((x) => x.re.test(text || '')) || STATES[STATES.length - 1];

  // c: { nick, text, k?, img?, cap?, theme?, labels? }
  function cardHtml(c) {
    const s = stateOf(c.text, c.k);
    const theme = POST_COLORS.includes(c.theme) ? c.theme : 'p1';
    const img = typeof c.img === 'string' && c.img.startsWith(IMG_PREFIX) ? c.img : '';
    const labels = (c.labels || []).map(byId).filter(Boolean);
    return `<article class="mycard ${theme}">
      <div class="mc-photo">${img
        ? `<img src="${esc(img)}" alt="${esc(c.nick || '')}님이 고른 요즘 기분 사진">`
        : `<div class="mc-photo-empty" aria-hidden="true"><span class="sticker c-${s.color}">${esc(s.name)}</span></div>`}</div>
      ${c.cap ? `<p class="mc-cap">${esc(c.cap)}</p>` : ''}
      <div class="mc-body">
        <div class="mc-top"><span class="mc-nick">${esc(c.nick || '나')}의 요즘</span><span class="sticker sm c-${s.color}">${esc(s.name)}</span></div>
        <p class="mc-text">"${esc(c.text || '')}"</p>
        ${labels.length ? `<div class="mc-labels"><span class="mc-sub">나를 설명하는 말</span>${labels.map((l) => `<span class="mc-tag">${esc(l.soft || l.name)}</span>`).join('')}</div>` : ''}
        <div class="hp"><span>마음 에너지</span><span class="hp-bar"><i style="width:${s.hp}%"></i></span><span class="hp-num">${s.hp}</span></div>
        <dl class="mc-rows">
          <div><dt>효과</dt><dd>${esc(s.effect)}</dd></div>
          <div><dt>회복 퀘스트</dt><dd>${esc(s.quest)}</dd></div>
          <div><dt>지속 시간</dt><dd>일시적 · 상태는 지나가요</dd></div>
        </dl>
      </div>
    </article>`;
  }

  /* ---------- Instagram story image (1080x1920) ---------- */
  const CARD_HEX = { p1: '#FFF6DF', p2: '#F3C9C4', p3: '#D3E2CF', p4: '#F5DE9B', p5: '#E2ECF1' };
  const STICKER_HEX = { coral: '#E8844A', yellow: '#F2C14E', mint: '#CFE3CB', lilac: '#F3C3BE', sky: '#C9DDEA' };
  const FONT = '"Pretendard Variable", Pretendard, "Noto Sans KR", "Malgun Gothic", sans-serif';
  const HAND = 'Gaegu, "Pretendard Variable", sans-serif';
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapText(ctx, text, maxW, maxLines) {
    const lines = [];
    let line = '';
    for (const ch of text) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        const cut = line.lastIndexOf(' ');
        if (cut > 0) { lines.push(line.slice(0, cut)); line = line.slice(cut + 1) + ch; } else { lines.push(line); line = ch; }
      } else line = test;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, -1)}…`;
      return kept;
    }
    return lines;
  }

  async function storyImage(c) {
    await Promise.all([`800 40px ${FONT}`, `600 32px ${FONT}`, `700 52px ${HAND}`].map((f) => document.fonts.load(f).catch(() => {})));
    const W = 1080;
    const H = 1920;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const s = stateOf(c.text, c.k);
    const labels = (c.labels || []).map(byId).filter(Boolean);
    const img = typeof c.img === 'string' && c.img.startsWith(IMG_PREFIX) ? await loadImg(c.img).catch(() => null) : null;
    const flower = await loadImg('img/poinsettia.svg').catch(() => null);

    ctx.fillStyle = '#1E3A2D';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    for (let y = 20; y < H; y += 40) for (let x = 20; x < W; x += 40) { ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill(); }
    if (flower) {
      ctx.save(); ctx.translate(W - 120, 150); ctx.rotate(0.4); ctx.drawImage(flower, -210, -210, 420, 420); ctx.restore();
      ctx.save(); ctx.translate(90, H - 330); ctx.rotate(-0.3); ctx.drawImage(flower, -130, -130, 260, 260); ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#F2C14E';
    ctx.font = `700 56px ${HAND}`;
    ctx.fillText('나의 요즘 상태카드', W / 2, 225);

    // card geometry: Instagram covers roughly the top and bottom 250px, so keep content between them
    const cardW = 768;
    const pad = 34;
    const cx = (W - cardW) / 2;
    const cy = 270;
    const inner = cardW - pad * 2;
    ctx.font = `600 32px ${FONT}`;
    const textLines = wrapText(ctx, `"${c.text || ''}"`, inner, 2);
    ctx.font = `700 50px ${HAND}`;
    const capLines = c.cap ? wrapText(ctx, c.cap, inner, 2) : [];
    const cardH = pad + inner + (capLines.length ? 24 + capLines.length * 58 : 0) + 36 + 64 + textLines.length * 46 + (labels.length ? 104 : 0) + 58 + pad;

    ctx.save();
    ctx.translate(W / 2, cy + cardH / 2);
    ctx.rotate(-0.02);
    ctx.translate(-W / 2, -(cy + cardH / 2));
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 50;
    ctx.shadowOffsetY = 24;
    ctx.fillStyle = CARD_HEX[c.theme] || CARD_HEX.p1;
    roundRect(ctx, cx, cy, cardW, cardH, 10);
    ctx.fill();
    ctx.shadowColor = 'transparent';

    let y = cy + pad;
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx + pad, y, inner, inner);
    const ph = inner - 36;
    if (img) {
      const scale = Math.max(ph / img.width, ph / img.height);
      const sw = ph / scale;
      const sh = ph / scale;
      ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, cx + pad + 18, y + 18, ph, ph);
    } else {
      ctx.fillStyle = CARD_HEX[c.theme] || CARD_HEX.p1;
      ctx.fillRect(cx + pad + 18, y + 18, ph, ph);
      ctx.save();
      ctx.beginPath(); ctx.rect(cx + pad + 18, y + 18, ph, ph); ctx.clip();
      ctx.strokeStyle = 'rgba(43,38,32,.07)'; ctx.lineWidth = 20;
      for (let d = -ph; d < ph * 2; d += 56) { ctx.beginPath(); ctx.moveTo(cx + pad + 18 + d, y + 18); ctx.lineTo(cx + pad + 18 + d + ph, y + 18 + ph); ctx.stroke(); }
      ctx.restore();
      ctx.font = `800 46px ${FONT}`;
      const tw = ctx.measureText(s.name).width + 64;
      ctx.fillStyle = '#FFF8E8';
      roundRect(ctx, W / 2 - tw / 2 - 6, y + inner / 2 - 46, tw + 12, 92, 18); ctx.fill();
      ctx.fillStyle = STICKER_HEX[s.color] || STICKER_HEX.mint;
      roundRect(ctx, W / 2 - tw / 2, y + inner / 2 - 40, tw, 80, 14); ctx.fill();
      ctx.fillStyle = '#2B2620';
      ctx.fillText(s.name, W / 2, y + inner / 2 + 16);
    }
    y += inner;

    ctx.fillStyle = '#2B2620';
    if (capLines.length) {
      y += 24;
      ctx.font = `700 50px ${HAND}`;
      capLines.forEach((l) => { y += 50; ctx.fillText(l, W / 2, y); y += 8; });
    }

    y += 36;
    ctx.strokeStyle = 'rgba(43,38,32,.25)';
    ctx.lineWidth = 3;
    ctx.setLineDash([12, 10]);
    ctx.beginPath(); ctx.moveTo(cx + pad, y); ctx.lineTo(cx + cardW - pad, y); ctx.stroke();
    ctx.setLineDash([]);

    y += 56;
    ctx.textAlign = 'left';
    ctx.font = `800 36px ${FONT}`;
    ctx.fillText(`${c.nick || '나'}의 요즘`, cx + pad, y);
    ctx.font = `800 30px ${FONT}`;
    const sw2 = ctx.measureText(s.name).width + 36;
    const sx = cx + cardW - pad - sw2;
    ctx.fillStyle = '#FFF8E8'; roundRect(ctx, sx - 5, y - 41, sw2 + 10, 58, 14); ctx.fill();
    ctx.fillStyle = STICKER_HEX[s.color] || STICKER_HEX.mint; roundRect(ctx, sx, y - 36, sw2, 48, 10); ctx.fill();
    ctx.fillStyle = '#2B2620'; ctx.fillText(s.name, sx + 18, y - 1);

    ctx.font = `600 32px ${FONT}`;
    textLines.forEach((l) => { y += 46; ctx.fillText(l, cx + pad, y + 8); });
    y += 8;

    if (labels.length) {
      y += 48;
      ctx.fillStyle = '#4A3F35';
      ctx.font = `800 24px ${FONT}`;
      ctx.fillText('나를 설명하는 말', cx + pad, y);
      y += 14;
      let tx = cx + pad;
      ctx.font = `800 26px ${FONT}`;
      labels.forEach((l) => {
        const name = l.soft || l.name;
        const w = ctx.measureText(name).width + 32;
        ctx.fillStyle = 'rgba(255,255,255,.75)'; roundRect(ctx, tx, y, w, 44, 22); ctx.fill();
        ctx.strokeStyle = 'rgba(43,38,32,.18)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#2B2620'; ctx.fillText(name, tx + 16, y + 31);
        tx += w + 10;
      });
      y += 42;
    }

    y += 54;
    ctx.fillStyle = '#4A3F35';
    ctx.font = `800 24px ${FONT}`;
    ctx.fillText('회복 퀘스트', cx + pad, y);
    ctx.fillStyle = '#2B2620';
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(wrapText(ctx, s.quest, inner - 150, 1)[0], cx + pad + 150, y);
    ctx.restore();

    // brand block, kept above Instagram's bottom reply bar
    const by = Math.min(cy + cardH + 120, 1600);
    ctx.textAlign = 'left';
    ctx.font = `900 46px ${FONT}`;
    const lw = ctx.measureText('LABEL').width;
    const ow = ctx.measureText('OFF').width + 28;
    const lx = W / 2 - (lw + 10 + ow) / 2;
    ctx.fillStyle = '#F5EEDD';
    ctx.fillText('LABEL', lx, by);
    ctx.save();
    ctx.translate(lx + lw + 10 + ow / 2, by - 16);
    ctx.rotate(-0.1);
    ctx.fillStyle = '#FFF8E8'; roundRect(ctx, -ow / 2 - 4, -34, ow + 8, 68, 12); ctx.fill();
    ctx.fillStyle = '#C8372D'; roundRect(ctx, -ow / 2, -30, ow, 60, 10); ctx.fill();
    ctx.fillStyle = '#FFF8E8'; ctx.textAlign = 'center'; ctx.fillText('OFF', 0, 16);
    ctx.restore();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#F5EEDD';
    ctx.font = `800 38px ${FONT}`;
    ctx.fillText('당신에게는 어떤 라벨이 붙어있나요?', W / 2, by + 72);
    ctx.fillStyle = '#BCCCBD';
    ctx.font = `600 30px ${FONT}`;
    ctx.fillText(location.host + location.pathname.replace(/\/$/, ''), W / 2, by + 120);

    return new Promise((res) => cv.toBlob(res, 'image/png'));
  }

  // Shrink a photo to fit comfortably inside one Firestore document.
  function photoToDataUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('type')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const r = Math.min(1, 1080 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * r);
        cv.height = Math.round(img.height * r);
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        // Firestore documents cap at 1 MiB; keep the base64 photo under ~700 KB to leave room.
        const LIMIT = 700000;
        let q = 0.85;
        let out = cv.toDataURL('image/jpeg', q);
        while (out.length > LIMIT && q > 0.4) { q -= 0.08; out = cv.toDataURL('image/jpeg', q); }
        if (out.length > LIMIT) reject(new Error('big')); else resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  }

  /* ---------- views ---------- */

  function viewHome() {
    const cloud = LABELS.map((l, i) => `<a class="sticker c-${l.color}" style="--r:${rot(i)}deg" href="#/pick?add=${l.id}">${esc(l.name)}</a>`).join('');
    return {
      html: `
      <section class="hero wrap">
        <div>
          <h1>당신에게는<br>어떤 <em>라벨</em>이<br>붙어있나요?</h1>
          <p class="lead">우울증, ADHD, 회피형, 외모정병, 에겐·테토… 요즘 우리는 나를 한 단어로 너무 쉽게 설명해요. 붙이기 전에, 제대로 알아봐요.</p>
          <div class="cta-row">
            <a class="btn primary" href="#/pick">내 라벨 고르기</a>
            <a class="btn ghost" href="#/state">상태카드 만들기</a>
          </div>
        </div>
        <div class="cloud-wrap">
          <p class="hand-note">여기서 바로 눌러도 돼요 ↓</p>
          <div class="cloud" aria-label="자주 쓰이는 라벨">${cloud}</div>
        </div>
      </section>

      <section class="wrap section split">
        <div>
          <h2 class="sec-title">요즘 어때요? 한 줄이면 돼요</h2>
          <p class="sub">"나 우울증인가 봐" 대신 "요즘 잠을 못 자서 피곤해"처럼요. 사진과 한마디로 꾸민 상태카드를 보내면 친구들이 선물상자에 한마디씩 넣어 줘요.</p>
          <a class="btn primary" href="#/state">상태카드 만들기</a>
        </div>
        ${cardHtml({ nick: '예시', text: '요즘 바빠서 잠을 많이 못 자서 피곤하다', cap: '오늘은 일찍 잘 거야', theme: 'p2', labels: ['glass', 'introvert'] })}
      </section>

      <section class="wrap section">
        <div class="criteria">
          <h2>병원에서 먼저 묻는 세 가지</h2>
          <div class="crit-pills"><span>언제부터?</span><span>얼마나 자주?</span><span>생활이 흔들렸나?</span></div>
          <p>체크리스트에 몇 개 해당되는지는 그다음 문제예요. 의사들은 그 상태가 얼마나 오래 갔는지, 얼마나 자주 그런지, 그것 때문에 학교나 일, 사람 관계가 얼마나 힘들어졌는지를 먼저 봐요.</p>
          <a class="btn glow" href="#/learn">관련 영상 보기</a>
        </div>
      </section>

      <section class="wrap section" style="margin-bottom:88px">
        <div class="newyear">
          <p class="script">Happy New Year</p>
          <h2>12월 31일, 이 사이트는 문을 닫아요.</h2>
          <div class="countdown" id="countdown" role="timer">${countdownHtml()}</div>
          <p>올해 붙은 라벨은 여기 두고, 새해는 가볍게 시작해요.</p>
        </div>
      </section>`,
      mount() {
        tick = setInterval(() => {
          if (Date.now() >= END) { render(); return; }
          const el = $('#countdown');
          if (el) el.innerHTML = countdownHtml();
        }, 60000);
      },
    };
  }

  function countdownHtml() {
    const left = Math.max(0, END - Date.now());
    const d = Math.floor(left / 86400000);
    const h = Math.floor((left % 86400000) / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    const unit = (n, label) => `<span><b>${pad(n)}</b><i>${label}</i></span>`;
    const units = d ? unit(d, '일') + unit(h, '시간') + unit(m, '분') : unit(h, '시간') + unit(m, '분');
    const label = d ? '문 닫기까지' : '오늘이 마지막 날이에요';
    const spoken = d ? `${d}일 ${h}시간 ${m}분` : `${h}시간 ${m}분`;
    return `<p class="cd-label">${label}</p><div class="cd-units" aria-label="${label} ${spoken} 남음">${units}</div>`;
  }

  function viewPick(q) {
    let picked = Store.get('picked', []).filter(byId);
    const add = q.get('add');
    if (add && byId(add) && !picked.includes(add)) {
      if (picked.length >= MAX_PICK) picked.shift();
      picked.push(add);
      Store.set('picked', picked);
    }
    const group = (type, offset) => LABELS.filter((l) => l.type === type).map((l, i) =>
      `<button type="button" class="pick sticker c-${l.color}" style="--r:${rot(i + offset)}deg" data-id="${l.id}" aria-pressed="${picked.includes(l.id)}">${esc(l.name)}</button>`).join('');

    return {
      html: `
      <section class="wrap narrow view">
        <h1 class="page-title">나한테 붙어 있는 라벨을<br>골라 보세요</h1>
        <p class="sub">스스로 붙였든 누가 붙였든 괜찮아요. 3개까지 고를 수 있어요.</p>

        <h2 class="group-title"><span class="dot c-clinic"></span>진단명으로 쓰이는 말</h2>
        <p class="group-sub">실제 병 이름이에요. 고르면 공식 검사나 상태 메모로 이어져요.</p>
        <div class="pick-grid">${group('clinical', 0)}</div>

        <h2 class="group-title"><span class="dot c-coral"></span>유행처럼 쓰이는 말</h2>
        <p class="group-sub">SNS에서 성격처럼 쓰는 말이에요. 고르면 직접 떼어 볼 수 있어요.</p>
        <div class="pick-grid">${group('trend', 4)}</div>

        <div class="pickbar">
          <span>고른 라벨 <b id="cnt">${picked.length}</b> / ${MAX_PICK}</span>
          <a class="btn primary" id="go" href="#/result" aria-disabled="${!picked.length}">상태창 열기</a>
        </div>
      </section>`,
      mount() {
        const cnt = $('#cnt');
        const go = $('#go');
        $$('.pick').forEach((b) => b.addEventListener('click', () => {
          const id = b.dataset.id;
          if (picked.includes(id)) picked = picked.filter((x) => x !== id);
          else if (picked.length >= MAX_PICK) { toast('라벨은 최대 3개까지 고를 수 있어요'); return; }
          else picked.push(id);
          b.setAttribute('aria-pressed', picked.includes(id));
          Store.set('picked', picked);
          cnt.textContent = picked.length;
          go.setAttribute('aria-disabled', !picked.length);
        }));
        go.addEventListener('click', (e) => { if (!picked.length) { e.preventDefault(); toast('라벨을 하나 이상 골라주세요'); } });
      },
    };
  }

  function statWin(l, open) {
    const clinical = l.type === 'clinical';
    const action = clinical
      ? `<div class="sw-actions">
          <p class="sw-note">실제 병 이름이에요. 가볍게 붙였다 뗄 말은 아니에요. 요즘 정말 힘들다면 한 번 확인해 보세요.${l.screener ? ` 의사와 연구진이 만든 ${SCREENERS[l.screener].name} 검사로 해볼 수 있어요.` : ''}</p>
          <div class="btn-row"><a class="btn glow" href="#/check/${l.id}">${l.screener ? `${SCREENERS[l.screener].name} 검사하기` : '제대로 알아보기'}</a><a class="btn line" href="#/learn?l=${l.id}">관련 강연</a></div>
        </div>`
      : `<div class="peel" data-id="${l.id}">
          <p class="peel-hint">라벨을 오른쪽으로 밀거나 눌러서 떼어보세요 →</p>
          <div class="peel-stage">
            <p class="peel-msg">${esc(l.peel)}</p>
            <div class="peel-label c-${l.color}" role="button" tabindex="0" aria-label="${esc(l.name)} 라벨 떼기"><span>${esc(l.name)}</span><i class="peel-corner"></i></div>
          </div>
          <p class="peel-after" hidden>이 단어 하나로 성격이 정해지지는 않아요.</p>
        </div>`;
    return `<details class="statwin" ${open ? 'open' : ''}>
      <summary>
        <span class="sticker sm c-${l.color}">${esc(l.name)}</span>
        <span class="sw-type">${clinical ? '진단명' : '유행어'}</span>
        <span class="sw-open" aria-hidden="true"></span>
      </summary>
      <div class="sw-body">
        ${l.official ? `<p class="sw-official">${esc(l.official)}</p>` : ''}
        <dl class="sw-rows">
          <div><dt>어원</dt><dd>${esc(l.origin)}</dd></div>
          <div><dt>진짜 뜻</dt><dd>${esc(l.meaning)}</dd></div>
          <div><dt>흔한 오해</dt><dd>${esc(l.myth)}</dd></div>
        </dl>
        ${action}
      </div>
    </details>`;
  }

  function mountPeel(root) {
    const label = $('.peel-label', root);
    const stage = $('.peel-stage', root);
    let startX = 0; let moved = 0; let p = 0; let dragging = false;
    const set = (v) => { p = v; label.style.setProperty('--p', v); };
    const finish = () => {
      if (root.classList.contains('done')) return;
      root.classList.add('done');
      label.classList.add('anim', 'gone');
      set(1.6);
      $('.peel-after', root).hidden = false;
      $('.peel-hint', root).textContent = '라벨을 떼어냈어요';
      Store.set('peeled', Store.get('peeled', 0) + 1);
    };
    const reset = () => { label.classList.add('anim'); set(0); };
    label.addEventListener('pointerdown', (e) => {
      dragging = true; moved = 0; startX = e.clientX;
      label.classList.remove('anim');
      label.setPointerCapture(e.pointerId);
    });
    label.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      set(Math.min(1, Math.max(0, dx) / (stage.offsetWidth * 0.7)));
    });
    label.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      if (moved < 6 || p > 0.4) finish(); else reset();
    });
    label.addEventListener('pointercancel', () => { dragging = false; reset(); });
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } });
  }

  function viewResult() {
    const picked = Store.get('picked', []).map(byId).filter(Boolean);
    if (!picked.length) {
      return { html: `<section class="wrap narrow view empty"><h1 class="page-title">아직 고른 라벨이 없어요</h1><p class="sub">먼저 나에게 붙어있는 라벨을 골라주세요.</p><a class="btn primary" href="#/pick">라벨 고르러 가기</a></section>` };
    }
    return {
      html: `
      <section class="wrap narrow view">
        <a class="back" href="#/pick">← 라벨 다시 고르기</a>
        <h1 class="page-title">내 라벨의 상태창</h1>
        <p class="sub">칸을 눌러 열어 보세요. 단어마다 원래 뜻과 흔한 오해가 들어 있어요.</p>
        <div class="stack">${picked.map((l, i) => statWin(l, i === 0)).join('')}</div>

        <section class="after-box">
          <h2>친구한테도 물어볼래요?</h2>
          <p>"너한테는 어떤 라벨 붙어 있어?" 링크 하나 보내면 돼요.</p>
          <button class="btn primary" id="shareRes" type="button">친구에게 공유하기</button>
          <div class="next-links">
            <a href="#/board/${picked[0].id}">'${esc(picked[0].name)}' 라벨을 가진 사람들의 포스트잇 →</a>
            <a href="#/state">고른 라벨로 상태카드 꾸미기 →</a>
            <a href="#/learn">강연·교육 보기 →</a>
          </div>
        </section>
      </section>`,
      mount() {
        $$('.peel').forEach(mountPeel);
        $('#shareRes').addEventListener('click', () => share({
          title: '라벨오프',
          text: `나 방금 '${picked.map((l) => l.name).join("', '")}' 라벨 제대로 알아보고 왔어. 너한테는 어떤 라벨이 붙어있어? (12월 31일까지만 열려)`,
          url: baseUrl(),
        }));
      },
    };
  }

  const DURATION = ['1주 미만', '1~2주', '2주~1개월', '1~6개월', '6개월 이상', '어릴 때부터 쭉'];
  const FREQ = ['가끔 (주 1회 이하)', '자주 (주 2~3회)', '거의 매일'];
  const AREAS = ['공부·일', '수면', '식사', '친구·연인·가족 관계', '돈·생활 관리', '외출·이동'];
  const IMPACT = ['거의 없음', '조금 불편함', '꽤 힘듦', '일상이 무너질 정도'];
  const ADVICE = {
    high: ['전문가와 이야기해 보길 권해요', '혼자 견디기보다 도움을 받아도 되는 상태로 보여요. 이 메모를 들고 정신건강의학과, 지역 정신건강복지센터, 학교 상담센터 중 가장 가까운 곳을 찾아가 보세요.'],
    mid: ['조금 더 지켜보며 기록해 봐요', '지금 진단이 필요하다고 말할 수는 없어요. 다만 이 상태가 2주 이상 이어지거나 더 힘들어진다면, 학교 상담센터처럼 문턱이 낮은 곳부터 이야기해 보세요.'],
    low: ['지금은 일상적인 변화일 수 있어요', '누구에게나 오는 힘든 시기일 수 있어요. 라벨을 붙이기보다 내 상태를 기록해 보고, 신경 쓰인다면 언제든 상담받아도 괜찮아요.'],
  };
  const radios = (name, arr) => arr.map((t, i) => `<label class="opt"><input type="radio" name="${name}" value="${i}" required><span>${esc(t)}</span></label>`).join('');
  const checks = (name, arr) => arr.map((t, i) => `<label class="opt"><input type="checkbox" name="${name}" value="${i}"><span>${esc(t)}</span></label>`).join('');

  const HELP_LINKS = [
    ['tel:109', '109 자살예방상담전화', '24시간 · 바로 전화 걸기'],
    ['tel:15770199', '1577-0199 정신건강위기상담', '24시간 · 바로 전화 걸기'],
    ['https://guidance.cau.ac.kr/', '중앙대 학생생활상담센터', '서울캠퍼스 · 02-820-6363'],
    ['https://counseling.cau.ac.kr/', '중앙대 학생생활상담센터(다빈치)', '안성캠퍼스 · 031-670-3398'],
    ['https://www.mentalhealth.go.kr/portal/health/fac/PotalHealthFacListTab1.do?tab1no=tab1no1', '내 주변 정신건강복지센터 찾기', '국가정신건강정보포털'],
    ['https://www.hira.or.kr/ra/hosp/getHealthMap.do?pgmid=HIRAA030002010000', '정신건강의학과 찾기', '건강보험심사평가원 병원·약국찾기'],
    ['https://www.bokjiro.go.kr/', '정신건강 심리상담 바우처', "복지로에서 '심리상담 바우처' 검색 · 1:1 전문 상담 8회 지원"],
  ];
  const helpHtml = (l) => `
    <div class="help-box">
      <h3>어디에서 이야기할 수 있나요?</h3>
      <ul class="link-list">${HELP_LINKS.map(([href, title, desc]) => {
        const tel = href.startsWith('tel:');
        return `<li><a href="${href}"${tel ? '' : ' target="_blank" rel="noopener"'}><b>${esc(title)}</b><span>${esc(desc)}</span><i aria-hidden="true">${tel ? '전화' : '↗'}</i></a></li>`;
      }).join('')}
        <li><a href="#/learn?l=${l.id}"><b>관련 강연 보기</b><span>'${esc(l.name)}' 제대로 알기 영상</span><i aria-hidden="true">→</i></a></li>
      </ul>
    </div>`;

  function viewScreener(l, sc) {
    const scaleOpts = (name, opts, required) => opts.map((t, i) => `<label class="opt"><input type="radio" name="${name}" value="${i}" ${required ? 'required' : ''}><span><em>${i}</em>${esc(t)}</span></label>`).join('');
    return {
      html: `
      <section class="wrap narrow view">
        <a class="back" href="#/result">← 상태창으로</a>
        <h1 class="page-title">${esc(l.name)}, 제대로 알아보기</h1>
        <p class="sub">병원에 가 볼 만한 정도인지 검사로 확인해 봐요.</p>
        <div class="hint-box">
          <b>${esc(sc.full)}</b>
          <p>${esc(sc.about)}</p>
          <p class="hint-note">검사 결과는 진단이 아니에요. 진단은 정신건강의학과 전문의의 면담으로만 할 수 있어요.</p>
        </div>

        <form id="scr" class="form">
          <p class="scr-intro">${esc(sc.intro)}</p>
          ${sc.items.map((q, i) => `<fieldset class="scr-item"><legend><span class="q-num">${i + 1}</span>${esc(q)}</legend><div class="opts scale">${scaleOpts(`q${i}`, sc.options, true)}</div></fieldset>`).join('')}
          ${sc.difficulty ? `<fieldset class="scr-item"><legend>${esc(sc.difficulty.q)}</legend><div class="opts scale">${scaleOpts('diff', sc.difficulty.options, false)}</div></fieldset>` : ''}
          <fieldset><legend>가장 힘들었던 순간을 짧게 적어봐요 (선택)</legend><textarea name="memo" maxlength="200" rows="3" aria-label="가장 힘들었던 순간 (선택)" placeholder="예) 요즘 아침마다 일어나기가 너무 힘들어요"></textarea></fieldset>
          <button class="btn primary wide" type="submit">결과 보기</button>
          <p class="scr-source">${esc(sc.source)}</p>
        </form>
        <div id="memoOut"></div>
      </section>`,
      mount() {
        const form = $('#scr');
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const answers = sc.items.map((_, i) => +fd.get(`q${i}`));
          const score = answers.reduce((a, b) => a + b, 0);
          const band = sc.bands.find(([lo, hi]) => score >= lo && score <= hi);
          const diff = fd.get('diff');
          const memo = String(fd.get('memo') || '').trim();
          const crisis = sc.crisisItem != null && answers[sc.crisisItem] > 0;
          const level = score >= sc.cutoff ? 'high' : score >= 5 ? 'mid' : 'low';
          const advice = {
            low: [`'${l.name}' 라벨을 붙일 근거는 적어 보여요`, `지금 점수는 '${band[2]}' 범위예요. 요즘 느끼는 감정은 누구나 겪는 일상적인 변화일 수 있어요. 그래도 힘들다면 언제든 이야기해도 괜찮아요.`],
            mid: ['가벼운 수준이에요. 지켜보며 기록해 봐요', `지금 점수는 '${band[2]}' 범위예요. 라벨을 붙이기보다 2주 정도 내 상태를 기록해 보고, 계속되거나 심해지면 학교 상담센터처럼 문턱이 낮은 곳부터 이야기해 보세요.`],
            high: ['전문가와 이야기해 볼 필요가 있는 수준이에요', `지금 점수는 '${band[2]}' 범위로, 이 검사를 만든 연구진이 추가 평가를 권하는 기준(${sc.cutoff}점) 이상이에요. 혼자 판단하지 말고 이 결과를 들고 정신건강의학과나 상담센터를 찾아가 보세요.`],
          }[level];
          const strong = sc.items.filter((_, i) => answers[i] >= 2);
          const today = fmtDate(Date.now());
          const rows = [
            ['검사', sc.full],
            ['총점', `${score}점 / ${sc.max}점 (${band[2]})`],
            ['자주 겪은 문제', strong.length ? strong.join(' / ') : '없음'],
            ...(diff != null ? [['일상의 어려움', sc.difficulty.options[+diff]]] : []),
            ...(memo ? [['가장 힘들었던 순간', memo]] : []),
          ];
          const plain = [`[내 상태 메모] ${l.name} 관련 · ${today}`, ...rows.map(([k, v]) => `- ${k}: ${v}`), '※ 선별검사 결과이며 진단이 아니에요.'].join('\n');

          $('#memoOut').innerHTML = `
            ${crisis ? `<div class="crisis big" role="alert"><b>${sc.crisisItem + 1}번 문항에 응답해 주셨어요.</b> 죽음이나 자해에 대한 생각이 든다면 혼자 견디지 말고 지금 바로 <a href="tel:109">109</a>(자살예방상담전화, 24시간)나 <a href="tel:15770199">1577-0199</a>(정신건강위기상담)에 연락해 주세요. 위급하다면 <a href="tel:119">119</a>에 연락하세요. 점수와 상관없이 꼭 전문가와 이야기해 보길 바라요.</div>` : ''}
            ${!crisis && CRISIS_RE.test(memo) ? crisisHtml() : ''}
            <div class="advice lv-${level}">
              <p class="score"><b>${score}</b><span>/ ${sc.max}점 · ${esc(sc.name)}</span></p>
              <h2>${esc(advice[0])}</h2><p>${esc(advice[1])}</p>
              ${l.screenerNote ? `<p class="advice-note">${esc(l.screenerNote)}</p>` : ''}
              <ol class="bands" aria-label="점수 구간">${sc.bands.map(([lo, hi, name]) => `<li class="${name === band[2] ? 'on' : ''}"><b>${lo}–${hi}</b>${esc(name)}</li>`).join('')}</ol>
            </div>
            <article class="memo" id="memo">
              <header><span>내 상태 메모</span><span>${today}</span></header>
              <h3>${esc(l.name)} 관련</h3>
              <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
              <p class="memo-foot">선별검사 결과이며 진단이 아니에요. 진료나 상담 때 내 상태를 설명하는 데 활용하세요.</p>
            </article>
            <div class="btn-row"><button class="btn primary" id="copyMemo" type="button">메모 복사</button><button class="btn ghost" id="printMemo" type="button">저장·인쇄</button></div>
            ${helpHtml(l)}`;
          $('#copyMemo').addEventListener('click', () => copy(plain, '메모를 복사했어요'));
          $('#printMemo').addEventListener('click', () => window.print());
          $('#memoOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      },
    };
  }

  function viewCheck(id) {
    const l = byId(id);
    if (!l || l.type !== 'clinical') return viewNotFound();
    if (l.screener) return viewScreener(l, SCREENERS[l.screener]);
    return {
      html: `
      <section class="wrap narrow view">
        <a class="back" href="#/result">← 상태창으로</a>
        <h1 class="page-title">${esc(l.name)}, 제대로 알아보기</h1>
        <p class="sub">진단은 아니고, 상담받을 때 보여줄 <b>내 상태 메모</b>를 만들어요.</p>
        <div class="hint-box"><b>전문가는 이런 점을 함께 봐요</b><p>${esc(l.criteria)}</p><p class="hint-note">'${esc(l.name)}' 라벨은 누구나 무료로 쓸 수 있는 공식 선별검사가 없어서, 병원에서 전문 검사와 면담으로 확인해요. 아래 문항은 공식 검사가 아니라 상담 때 쓸 메모를 위한 참고용이에요.</p></div>

        <form id="chk" class="form">
          <fieldset><legend>1. 요즘 나에게 해당하는 것을 골라주세요 (참고용)</legend><div class="opts col">${checks('sym', l.checks)}</div></fieldset>
          <fieldset><legend>2. 언제부터 그랬나요?</legend><div class="opts">${radios('dur', DURATION)}</div></fieldset>
          <fieldset><legend>3. 얼마나 자주 그런가요?</legend><div class="opts">${radios('freq', FREQ)}</div></fieldset>
          <fieldset><legend>4. 어떤 부분에 영향을 주나요?</legend><div class="opts">${checks('area', AREAS)}</div></fieldset>
          <fieldset><legend>5. 일상에 주는 영향은 어느 정도인가요?</legend><div class="opts">${radios('imp', IMPACT)}</div></fieldset>
          <fieldset><legend>6. 가장 힘들었던 순간을 짧게 적어봐요 (선택)</legend><textarea name="memo" maxlength="200" rows="3" aria-label="가장 힘들었던 순간 (선택)" placeholder="예) 과제를 하려고 앉으면 두 시간째 아무것도 못 하고 있어요"></textarea></fieldset>
          <button class="btn primary wide" type="submit">내 상태 메모 만들기</button>
        </form>
        <div id="crisis1" hidden></div>
        <div id="memoOut"></div>
      </section>`,
      mount() {
        const form = $('#chk');
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const sym = fd.getAll('sym').map((i) => l.checks[i]);
          const dur = +fd.get('dur');
          const freq = +fd.get('freq');
          const imp = +fd.get('imp');
          const areas = fd.getAll('area').map((i) => AREAS[i]);
          const memo = String(fd.get('memo') || '').trim();
          const level = imp === 3 || (imp === 2 && (freq === 2 || dur >= 3)) ? 'high' : (imp >= 1 || sym.length >= 3 ? 'mid' : 'low');
          const today = fmtDate(Date.now());
          const rows = [
            ['해당하는 것', sym.length ? sym.join(', ') : '없음'],
            ['시작 시기', DURATION[dur]],
            ['빈도', FREQ[freq]],
            ['영향 받는 부분', areas.length ? areas.join(', ') : '없음'],
            ['일상 영향 정도', IMPACT[imp]],
            ...(memo ? [['가장 힘들었던 순간', memo]] : []),
          ];
          const plain = [`[내 상태 메모] ${l.name} 관련 · ${today}`, ...rows.map(([k, v]) => `- ${k}: ${v}`), '※ 이 메모는 진단 결과가 아니에요.'].join('\n');

          showCrisis(memo, $('#crisis1'));
          $('#memoOut').innerHTML = `
            <div class="advice lv-${level}"><h2>${ADVICE[level][0]}</h2><p>${ADVICE[level][1]}</p></div>
            <article class="memo" id="memo">
              <header><span>내 상태 메모</span><span>${today}</span></header>
              <h3>${esc(l.name)} 관련</h3>
              <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
              <p class="memo-foot">이 메모는 진단 결과가 아니에요. 진료나 상담 때 내 상태를 설명하는 데 활용하세요.</p>
            </article>
            <div class="btn-row"><button class="btn primary" id="copyMemo" type="button">메모 복사</button><button class="btn ghost" id="printMemo" type="button">저장·인쇄</button></div>
            ${helpHtml(l)}`;
          $('#copyMemo').addEventListener('click', () => copy(plain, '메모를 복사했어요'));
          $('#printMemo').addEventListener('click', () => window.print());
          $('#memoOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      },
    };
  }

  function ytId(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  function viewLearn(lid) {
    const focus = byId(lid);
    const list = focus
      ? [...LECTURES.filter((x) => x.labels.includes(lid)), ...LECTURES.filter((x) => !x.labels.includes(lid))]
      : LECTURES;
    const cards = list.map((x) => {
      const url = /^https?:\/\//.test(x.url || '') ? x.url : '';
      const yt = ytId(url);
      const tag = url ? 'a' : 'article';
      const cta = yt ? '영상 보기' : '바로가기';
      const attrs = url ? ` href="${esc(url)}" target="_blank" rel="noopener" aria-label="${esc(x.title)} ${cta} (새 창)"` : '';
      const thumb = yt ? ` style="background-image:linear-gradient(180deg, rgba(22,26,43,.15), rgba(22,26,43,.85)), url('https://i.ytimg.com/vi/${yt}/hqdefault.jpg')"` : '';
      return `
      <${tag} class="lec ${url ? 'live' : ''} ${focus && x.labels.includes(lid) ? 'hl' : ''}"${attrs}>
        <div class="lec-thumb ${x.art ? 'has-art' : ''}"${thumb}>${x.art === 'counsel' ? '<div class="lec-art" aria-hidden="true"><span class="bub b1">요즘 좀 지쳤어요</span><span class="bub b2">여기서 같이 이야기해요</span></div>' : ''}<span class="lec-kind">${esc(x.kind)}</span>${url ? `${yt ? '<span class="play" aria-hidden="true"></span>' : ''}<span class="soon">${cta} ↗</span>` : '<span class="soon">12월 공개 예정</span>'}</div>
        <div class="lec-body">
          <h3>${esc(x.title)}</h3>
          <p>${esc(x.desc)}</p>
          <p class="lec-meta">${esc(x.by)}</p>
          <div class="lec-tags">${x.labels.map(byId).map((l) => `<span class="sticker sm c-${l.color}">${esc(l.name)}</span>`).join('')}</div>
        </div>
      </${tag}>`;
    }).join('');
    return {
      html: `
      <section class="wrap view">
        <h1 class="page-title">라벨, 제대로 알기</h1>
        <p class="sub">병원과 방송, 정신건강의학과 전문의 채널 영상을 모았어요. ${focus ? `선택한 라벨 '${esc(focus.name)}' 관련 영상을 먼저 보여드려요.` : ''}</p>
        <div class="lec-grid">${cards}</div>
      </section>`,
    };
  }

  function viewState() {
    const examples = ['요즘 바빠서 잠을 많이 못 자서 피곤하다', '남자친구랑 헤어져서 술 마시고 싶다', '할 게 너무 많다. 정신이 없다', '요즘 괜히 불안하고 걱정이 많다'];
    return {
      html: `
      <section class="wrap narrow view">
        <h1 class="page-title">요즘 어때요?</h1>
        <p class="sub">"나 우울증인가 봐" 대신 "요즘 잠을 못 자서 피곤해"처럼 지금 상태를 적어 보세요. 사진과 한마디로 카드를 꾸밀 수도 있어요.</p>
        <form id="stForm" class="form">
          <fieldset>
            <legend>나를 설명하는 라벨 (최대 3개, 선택)</legend>
            <p class="field-hint">카드에는 부드러운 말로 바뀌어 들어가요. 예) 우울증 → 마음이 무거운 요즘</p>
            <div class="pick-grid small">${LABELS.map((l, i) => `<button type="button" class="pick sticker c-${l.color}" style="--r:${rot(i)}deg" data-id="${l.id}" aria-pressed="false">${esc(l.name)}</button>`).join('')}</div>
          </fieldset>
          <div class="field">
            <label class="field-label" for="nick">닉네임</label>
            <input type="text" id="nick" name="nick" maxlength="12" required placeholder="예) 선우" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label" for="st">요즘 어때요?</label>
            <textarea id="st" name="st" maxlength="80" required placeholder="지금 내 상태를 한두 문장으로 적어보세요"></textarea>
            <div class="chips">${examples.map((t) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
          </div>
          <div class="field">
            <span class="field-label">기분 사진 (선택)</span>
            <div class="photo-row">
              <input type="file" id="photo" accept="image/*" class="sr-only">
              <label class="btn ghost" for="photo">사진 고르기</label>
              <button type="button" class="btn ghost" id="photoClear" hidden>사진 빼기</button>
            </div>
            <p class="field-hint">사진은 작게 줄여서 상태방에 함께 저장돼요. 얼굴이나 개인정보가 보이는 사진은 피해 주세요.</p>
          </div>
          <div class="field">
            <label class="field-label" for="cap">사진 아래 한마디 (선택)</label>
            <input type="text" id="cap" name="cap" maxlength="40" placeholder="예) 오늘은 일찍 잘 거야" autocomplete="off">
          </div>
          <fieldset><legend>카드 색</legend>${colorPicker('theme', '카드 색')}</fieldset>
          <h2 class="preview-title">미리보기</h2>
          <div id="cardOut"></div>
          <div id="crisis2" hidden></div>
          <button class="btn primary wide" type="submit">상태방 만들고 공유하기</button>
        </form>
      </section>`,
      mount() {
        const form = $('#stForm');
        let img = '';
        let labels = Store.get('picked', []).filter(byId).slice(0, MAX_PICK);
        const draw = () => {
          $('#cardOut').innerHTML = cardHtml({
            nick: form.nick.value.trim() || '나',
            text: form.st.value.trim() || '지금 내 상태를 적어 보세요',
            img, cap: form.cap.value.trim(), theme: form.theme.value, labels,
          });
        };
        const syncLabels = () => $$('.pick', form).forEach((b) => b.setAttribute('aria-pressed', labels.includes(b.dataset.id)));
        syncLabels();
        draw();
        form.addEventListener('input', draw);
        form.addEventListener('change', draw);
        $$('.chip', form).forEach((c) => c.addEventListener('click', () => { form.st.value = c.dataset.t; draw(); }));
        $$('.pick', form).forEach((b) => b.addEventListener('click', () => {
          const lid = b.dataset.id;
          if (labels.includes(lid)) labels = labels.filter((x) => x !== lid);
          else if (labels.length >= MAX_PICK) { toast('라벨은 3개까지 담을 수 있어요'); return; }
          else labels.push(lid);
          Store.set('picked', labels);
          syncLabels();
          draw();
        }));
        $('#photo').addEventListener('change', async (e) => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          try {
            img = await photoToDataUrl(file);
            $('#photoClear').hidden = false;
            draw();
          } catch (err) {
            toast(err.message === 'type' ? '사진 파일만 올릴 수 있어요' : '이 사진은 불러오지 못했어요. 다른 사진으로 해 주세요.');
          }
        });
        $('#photoClear').addEventListener('click', () => { img = ''; $('#photoClear').hidden = true; draw(); });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const nick = form.nick.value.trim();
          const text = form.st.value.trim();
          if (!nick || !text) return;
          const cap = form.cap.value.trim();
          showCrisis(`${text} ${cap}`, $('#crisis2'));
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          const space = { id: uid() + uid(), nick, text, k: stateOf(text).key, t: Date.now(), img, cap, theme: form.theme.value, labels };
          try {
            await Api.saveSpace(space);
            location.hash = `#/space/${space.id}`;
          } catch {
            btn.disabled = false;
            toast('상태방을 만들지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
          }
        });
      },
    };
  }

  function viewSpace(id, q) {
    return {
      html: `<section class="wrap narrow view" id="spaceRoot"><p class="sub">상태방을 불러오는 중이에요…</p></section>`,
      async mount() {
        const my = renderId;
        let s = await Api.getSpace(id);
        if (!s && q.get('d')) {
          const d = decode(q.get('d'));
          if (d && d.id === id && d.nick && d.text) { s = d; Store.set('space:' + id, s); }
        }
        if (my !== renderId) return;
        if (!s) {
          $('#spaceRoot').innerHTML = '<div class="empty"><h1 class="page-title">상태방을 찾을 수 없어요</h1><p class="sub">링크가 정확한지 확인해 주세요.</p><a class="btn primary" href="#/">처음으로</a></div>';
          return;
        }
        document.title = `${s.nick}님의 상태방 · 라벨오프`;
        const v = spaceView(s);
        $('#spaceRoot').innerHTML = v.html;
        v.mount();
      },
    };
  }

  function spaceView(s) {
    const id = s.id;
    const mine = Api.isMine(id);
    const shareUrl = isShared()
      ? `${baseUrl()}#/space/${id}`
      : `${baseUrl()}#/space/${id}?d=${encode({ id, nick: s.nick, text: s.text, k: s.k, t: s.t, cap: s.cap, theme: s.theme, labels: s.labels })}`;
    const quick = ['오늘도 고생 많았어', '너는 생각보다 훨씬 잘하고 있어', '푹 자고 나면 조금 나아질 거야', '힘들면 언제든 연락해'];

    return {
      html: `
        <div class="space-head">
          <p class="eyebrow">${mine ? '내 상태방' : '친구의 상태방'} · ${dLabel()}</p>
          <h1 class="page-title">${esc(s.nick)}님의 상태방</h1>
          <p class="sub">${mine ? '링크를 보내면 친구들이 여기에 한마디씩 남겨 줘요.' : '요즘 이렇대요. 한마디 남겨 주세요.'}</p>
        </div>
        ${cardHtml(s)}

        <section class="paper">
          <h2>롤링페이퍼 <span id="ncount"></span></h2>
          <div class="notes" id="notes"><p class="empty-note">메시지를 불러오는 중이에요…</p></div>
        </section>

        <section class="write-box">
          <h2>${mine ? '친구 입장에서 미리 써보기' : `${esc(s.nick)}님에게 한마디`}</h2>
          <form id="noteForm">
            <div class="field"><textarea name="text" maxlength="120" required aria-label="남길 메시지" placeholder="라벨 말고, 따뜻한 한마디를 남겨주세요"></textarea>
              <div class="chips">${quick.map((t) => `<button type="button" class="chip" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>
            </div>
            <div class="field"><input type="text" name="from" maxlength="12" aria-label="보내는 사람 (선택)" placeholder="보내는 사람 (비우면 익명)" autocomplete="off"></div>
            <div class="field">${colorPicker('c')}</div>
            <button class="btn primary wide" type="submit">포스트잇 붙이기</button>
          </form>
          <div id="crisis3" hidden></div>
        </section>
        ${mine ? `<div class="share-box">
          <p>"내 상태방에 따뜻한 한마디 남겨줘"</p>
          <div class="share-stack"><button class="btn story" id="storySp" type="button">인스타 스토리로 공유</button><button class="btn primary" id="shareSp" type="button">링크 공유하기</button></div>
          <p class="story-tip">스토리에 링크 스티커를 붙이고 상태방 주소를 넣으면 친구들이 바로 들어올 수 있어요. 스토리로 공유할 때 주소가 자동으로 복사돼요.</p>
        </div>` : ''}
        ${mine ? '' : `<section class="invite"><h2>나도 만들어 볼래요?</h2><p>요즘 상태를 한 줄 적으면 내 상태방이 생겨요.</p><a class="btn glow" href="#/state">내 상태카드 만들기</a></section>`}
        ${isShared() ? '' : '<p class="demo-note">미리보기 안내: 지금은 메시지가 이 기기에만 저장돼요.</p>'}`,
      mount() {
        keep(Api.watchList(`notes:${id}`, ['spaces', id, 'notes'], (list) => {
          $('#notes').innerHTML = notesHtml(list);
          $('#ncount').textContent = list.length;
        }));
        if (mine) {
          const text = `${s.nick}의 상태방에 따뜻한 한마디 남겨줘. 라벨 말고, 지금 상태로 말하는 곳 (12월 31일까지)`;
          $('#shareSp').addEventListener('click', () => share({ title: `${s.nick}님의 상태방`, text, url: shareUrl }));
          // Build the story image up front: the share sheet must open inside the tap, with no slow work before it.
          let storyFile = null;
          storyImage(s).then((b) => { storyFile = new File([b], 'labeloff-story.png', { type: 'image/png' }); }, () => {});
          const notReady = () => toast('스토리 이미지를 만드는 중이에요. 잠시 후 다시 눌러 주세요.');
          const saveStory = () => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(storyFile);
            a.download = 'labeloff-story.png';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
            toast('이미지를 저장했어요. 인스타그램 스토리에서 이 이미지를 올려 주세요.');
          };
          $('#storySp').addEventListener('click', () => {
            if (!storyFile) { notReady(); return; }
            if (navigator.clipboard) navigator.clipboard.writeText(shareUrl).catch(() => {});
            if (navigator.canShare && navigator.canShare({ files: [storyFile] })) {
              navigator.share({ files: [storyFile] })
                .then(() => toast('상태방 주소가 복사돼 있어요. 스토리의 링크 스티커에 붙여 넣으세요.'))
                .catch((e) => { if (e.name !== 'AbortError') saveStory(); });
            } else saveStory();
          });
        }
        const form = $('#noteForm');
        $$('.chip', form).forEach((c) => c.addEventListener('click', () => { form.text.value = c.dataset.t; }));
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = form.text.value.trim();
          if (!text) return;
          showCrisis(text, $('#crisis3'));
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            await Api.addTo(`notes:${id}`, ['spaces', id, 'notes'], { text, from: form.from.value.trim(), c: form.c.value, t: Date.now() });
            form.text.value = '';
            toast('포스트잇을 붙였어요');
            $('#notes').scrollIntoView({ behavior: 'smooth', block: 'center' });
          } catch {
            toast('포스트잇을 붙이지 못했어요. 잠시 후 다시 시도해 주세요.');
          } finally {
            btn.disabled = false;
          }
        });
      },
    };
  }

  function viewBoard(lid) {
    const cur = byId(lid) || LABELS[0];
    const tabs = LABELS.map((l) => `<a class="tab ${l.id === cur.id ? 'on' : ''}" href="#/board/${l.id}">${esc(l.name)}</a>`).join('');
    return {
      html: `
      <section class="wrap narrow view">
        <h1 class="page-title">같은 라벨, 다른 이야기</h1>
        <p class="sub">같은 라벨을 가진 사람들이 이름 없이 남긴 이야기.</p>
        <nav class="tabs" aria-label="라벨 선택">${tabs}</nav>

        <section class="write-box" style="margin-top:12px">
          <h2><span class="sticker sm c-${cur.color}">${esc(cur.name)}</span> 라벨에 대한 내 이야기</h2>
          <form id="bForm">
            <div class="field"><textarea name="text" maxlength="120" required aria-label="'${esc(cur.name)}' 라벨에 대한 내 이야기" placeholder="이 라벨 때문에 겪은 일, 새롭게 알게 된 것, 하고 싶은 말"></textarea><p class="count"><span id="len">0</span>/120</p></div>
            <div class="field">${colorPicker('c')}</div>
            <button class="btn primary wide" type="submit">익명으로 붙이기</button>
          </form>
          <div id="crisis4" hidden></div>
        </section>

        <div class="notes" id="bNotes"><p class="empty-note">이야기를 불러오는 중이에요…</p></div>
      </section>`,
      mount() {
        const on = $('.tab.on');
        if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
        keep(Api.watchList(`board:${cur.id}`, ['boards', cur.id, 'posts'], (list) => { $('#bNotes').innerHTML = notesHtml(list); }, seedsFor(cur.id)));
        const form = $('#bForm');
        form.text.addEventListener('input', () => { $('#len').textContent = form.text.value.length; });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const text = form.text.value.trim();
          if (!text) return;
          showCrisis(text, $('#crisis4'));
          const btn = form.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            await Api.addTo(`board:${cur.id}`, ['boards', cur.id, 'posts'], { text, c: form.c.value, t: Date.now() });
            form.text.value = '';
            $('#len').textContent = '0';
            toast('익명으로 붙였어요');
          } catch {
            toast('붙이지 못했어요. 잠시 후 다시 시도해 주세요.');
          } finally {
            btn.disabled = false;
          }
        });
      },
    };
  }

  function viewClosed() {
    const peeled = Store.get('peeled', 0);
    return {
      html: `
      <section class="wrap closed">
        <p class="script">Happy New Year</p>
        <p class="eyebrow">2026.12.31 운영 종료</p>
        <h1>2027년,<br>라벨 없이 시작해요.</h1>
        <p class="sub">올해 붙어있던 라벨은 여기 두고 가요. 새해의 나는 한 단어로 설명되지 않아요.</p>
        ${peeled ? `<p class="stat">올해 내가 떼어낸 라벨 <b>${peeled}</b>개</p>` : ''}
        <a class="btn primary" href="#/learn">강연·교육은 계속 볼 수 있어요</a>
      </section>`,
    };
  }

  function viewNotFound(title = '페이지를 찾을 수 없어요', sub = '주소를 다시 확인해 주세요.') {
    return { html: `<section class="wrap narrow view empty"><h1 class="page-title">${esc(title)}</h1><p class="sub">${esc(sub)}</p><a class="btn primary" href="#/">처음으로</a></section>` };
  }

  /* ---------- router ---------- */

  function parseHash() {
    const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
    return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
  }

  const NAV_OF = { pick: 'pick', result: 'pick', check: 'pick', state: 'state', space: 'state', board: 'board', learn: 'learn' };

  function pageTitle(r, a, closed) {
    if (closed) return 'Happy New Year';
    const l = byId(a);
    switch (r) {
      case 'pick': return '라벨 고르기';
      case 'result': return '내 라벨의 상태창';
      case 'check': return l ? `${l.name} 제대로 알아보기` : '';
      case 'learn': return '라벨, 제대로 알기';
      case 'state': return '상태카드 만들기';
      case 'space': return '상태방';
      case 'board': return `'${(l || LABELS[0]).name}' 포스트잇`;
      default: return '';
    }
  }

  function render() {
    const { parts, q } = parseHash();
    const [r = '', a] = parts;
    const closed = (Date.now() >= END || new URLSearchParams(location.search).has('newyear'))
      && ['', 'pick', 'result', 'check', 'state', 'board'].includes(r);
    let v;
    if (closed) v = viewClosed();
    else {
      switch (r) {
        case '': v = viewHome(); break;
        case 'pick': v = viewPick(q); break;
        case 'result': v = viewResult(); break;
        case 'check': v = viewCheck(a); break;
        case 'learn': v = viewLearn(q.get('l')); break;
        case 'state': v = viewState(); break;
        case 'space': v = viewSpace(a, q); break;
        case 'board': v = viewBoard(a); break;
        default: v = viewNotFound();
      }
    }
    clearInterval(tick);
    renderId += 1;
    cleanups.forEach((stop) => { try { stop(); } catch { /* already stopped */ } });
    cleanups = [];
    app.innerHTML = v.html;
    if (v.mount) v.mount();
    const t = pageTitle(r, a, closed);
    document.title = t ? `${t} · 라벨오프` : '라벨오프 — 붙이기 전에, 제대로 알기';
    $$('.nav a').forEach((el) => el.classList.toggle('on', el.dataset.r === NAV_OF[r]));
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', render);
  render();
})();
