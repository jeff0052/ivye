/* 每日识字 — daily Chinese character practice with spaced repetition.
 * Progress is kept in this browser's localStorage. When the page runs as a
 * claude.ai artifact with the `db` capability, each kid's progress is also
 * synced to the artifact database (one document per kid), so it follows
 * the family across devices. 家长设置 → 备份 still works everywhere. */
(function () {
  'use strict';

  // ---------- data ----------
  const CHARS = [];      // [{c, py, en, words:[{w,py,en}], unit, idx}]
  const BY = {};
  const UNITS = [];
  (function parse() {
    let unit = '';
    window.HANZI_RAW.trim().split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;
      if (line[0] === '#') { unit = line.slice(1); UNITS.push(unit); return; }
      const [c, py, en, ws] = line.split('|');
      const words = ws.split(';').map(s => { const [w, p, e] = s.split(':'); return { w, py: p, en: e }; });
      const item = { c, py, en, words, unit, idx: CHARS.length };
      CHARS.push(item); BY[c] = item;
    });
  })();

  // Leitner boxes → days until next review
  const INTERVAL = [0, 1, 2, 4, 7, 14, 30, 60, 120];
  const MAX_BOX = INTERVAL.length - 1;
  const MASTER_BOX = 6;
  const SESSION_SEC = 600;
  const AVATARS = ['🐯', '🐲', '🐼', '🦊', '🐵', '🐶', '🐱', '🦁', '🐸', '🐧', '🚀', '⚽', '🎮', '🦖'];

  // ---------- storage ----------
  const KEY = 'hanzi-daily-v1';
  function blankKid(id, name, avatar, perDay) {
    return { id, name, avatar, perDay, cards: {}, history: {}, stars: 0, updated: 0 };
  }
  function defaults() { return { kids: [blankKid('kid1', '哥哥', '🐲', 6), blankKid('kid2', '弟弟', '🐯', 4)] }; }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && Array.isArray(s.kids) && s.kids.length) return s; } catch (e) {}
    return defaults();
  }
  let S = load();
  let view = 'home';

  // --- cloud sync (artifact db): kids/<id>, one document per kid ---
  let db = null;
  const dirty = new Set(), writing = new Set();
  let flushTimer = null;
  function save(kid) {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    const list = kid ? [kid] : S.kids;
    list.forEach(k => { k.updated = Date.now(); dirty.add(k.id); });
    if (db) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200); }
  }
  async function flush() {
    for (const id of [...dirty]) {
      if (writing.has(id)) continue;
      const k = S.kids.find(x => x.id === id);
      dirty.delete(id);
      if (!k) continue;
      writing.add(id);
      try { await db.doc('kids/' + id).set(JSON.parse(JSON.stringify(k))); }
      catch (e) { dirty.add(id); if (!flush.warned) { flush.warned = 1; toast('进度暂时没能同步，已保存在这台设备上'); } }
      writing.delete(id);
    }
    if (dirty.size) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 3000); }
  }
  function applyRemote(docs) {
    let changed = false;
    docs.forEach(d => {
      if (!d || typeof d.id !== 'string' || !d.cards) return;
      const i = S.kids.findIndex(k => k.id === d.id);
      if (i < 0) { S.kids.push(d); changed = true; return; }
      const mine = S.kids[i];
      if ((d.updated || 0) > (mine.updated || 0) && !dirty.has(d.id) && !(session && current === mine && view === 'session')) {
        S.kids[i] = d; if (current === mine) current = d; changed = true;
      }
    });
    if (changed) {
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      if (view === 'home' || view === 'kid') go(view);
    }
  }
  (async function connect() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    let d = null; try { d = await window.claude.use('db'); } catch (e) {}
    if (!d) return;
    db = d;
    let first = true;
    db.collection('kids').onSnapshot(snap => {
      const docs = snap.docs.map(x => { try { return JSON.parse(JSON.stringify(x.data())); } catch (e) { return null; } });
      if (first && !snap.metadata?.fromCache) {
        first = false;
        // ids the store doesn't have yet (first run / progress made before syncing): upload them
        const have = new Set(docs.map(x => x && x.id));
        S.kids.forEach(k => { if (!have.has(k.id) && (Object.keys(k.cards).length || k.updated)) dirty.add(k.id); });
        if (!docs.length) S.kids.forEach(k => dirty.add(k.id));
        if (dirty.size) flush();
      }
      applyRemote(docs);
    }, () => {});
  })();

  // ---------- dates ----------
  function dayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); }
  const today = () => dayStr();

  function streak(kid) {
    let n = 0; const d = new Date();
    if (!(kid.history[dayStr(d)] || {}).done) d.setDate(d.getDate() - 1);
    while ((kid.history[dayStr(d)] || {}).done) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function learned(kid) { return Object.keys(kid.cards).filter(c => BY[c]); }
  function mastered(kid) { return learned(kid).filter(c => kid.cards[c].box >= MASTER_BOX); }
  function dueList(kid) {
    const t = today();
    return learned(kid).filter(c => kid.cards[c].due <= t)
      .sort((a, b) => kid.cards[a].due.localeCompare(kid.cards[b].due) || kid.cards[a].box - kid.cards[b].box);
  }
  function nextNew(kid, n) { return CHARS.filter(x => !kid.cards[x.c]).slice(0, n).map(x => x.c); }
  function plan(kid) {
    const due = dueList(kid);
    const h = kid.history[today()] || {};
    let n = Math.max(0, kid.perDay - (h.newCount || 0));
    if (due.length > 40) n = Math.min(n, 1); else if (due.length > 25) n = Math.min(n, Math.ceil(kid.perDay / 2));
    return { due, fresh: nextNew(kid, n) };
  }

  // ---------- helpers ----------
  const $app = document.getElementById('app');
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  function toast(msg, ms) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), ms || 2200);
  }
  function confetti() {
    const box = document.createElement('div'); box.className = 'confetti';
    const cols = ['#c8102e', '#e8a317', '#2f9e5b', '#2f6fd6', '#ff7aa2'];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%'; p.style.background = pick(cols);
      p.style.animationDuration = (1.6 + Math.random() * 1.8) + 's'; p.style.animationDelay = (Math.random() * .5) + 's';
      box.appendChild(p);
    }
    document.body.appendChild(box); setTimeout(() => box.remove(), 4200);
  }

  // in-page confirmation (window.confirm is blocked in some embeds)
  function ask(msg, okLabel) {
    return new Promise(res => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = `<div class="card"><p style="margin:0;font-weight:800;font-size:18px"></p>
        <div class="row"><button class="btn ghost" data-a="0">取消</button><button class="btn" data-a="1"></button></div></div>`;
      m.querySelector('p').textContent = msg; m.querySelector('[data-a="1"]').textContent = okLabel || '确定';
      m.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { m.remove(); res(b.dataset.a === '1'); });
      document.body.appendChild(m);
    });
  }

  // ---------- speech ----------
  let zhVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    zhVoice = vs.find(v => /zh[-_]CN/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang)) || vs.find(v => /chinese|mandarin|普通话/i.test(v.name)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  const canSpeak = () => 'speechSynthesis' in window && !!zhVoice;
  function say(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; if (zhVoice) u.voice = zhVoice; u.rate = 0.75;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------- stroke order (Hanzi Writer, optional) ----------
  // stroke data ships beside the page (strokes.json); falls back to Hanzi Writer's CDN data
  let strokesP = null;
  function strokeData(ch, onLoad, onError) {
    strokesP = strokesP || fetch('strokes.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
    strokesP.then(all => {
      if (all[ch]) return onLoad(all[ch]);
      fetch('https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/' + encodeURIComponent(ch) + '.json')
        .then(r => r.json()).then(onLoad).catch(onError);
    });
  }
  function mountWriter(el, ch, mode) {
    if (!window.HanziWriter || !el) return null;
    const box = el.closest('.tzg');
    const size = box.clientWidth - 6;
    const red = getComputedStyle(document.documentElement).getPropertyValue('--red').trim() || '#c8102e';
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#2b2622';
    let w;
    try {
      w = HanziWriter.create(el, ch, {
        width: size, height: size, padding: 14, showOutline: true, strokeColor: ink, radicalColor: red,
        outlineColor: 'rgba(160,140,120,.28)', drawingColor: red, highlightColor: '#e8a317',
        charDataLoader: strokeData, strokeAnimationSpeed: 1.1, delayBetweenStrokes: 220, showCharacter: mode !== 'quiz',
        onLoadCharDataSuccess: () => box.classList.add('has-writer'),
        onLoadCharDataError: () => { box.classList.remove('has-writer'); el.innerHTML = ''; }
      });
    } catch (e) { return null; }
    return w;
  }

  // ---------- routing ----------
  let current = null;   // kid
  let session = null;
  let timerId = null;
  function go(v, arg) {
    if (timerId && v !== 'session') { clearInterval(timerId); timerId = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    window.scrollTo(0, 0);
    view = v;
    ({ home, kid: dash, session: runSession, summary, library, settings })[v](arg);
  }

  // ---------- HOME ----------
  function home() {
    current = null;
    $app.innerHTML = `
      <div class="top"><h1><span class="logo">字</span>每日识字</h1>
        <button class="icon-btn" id="set" aria-label="家长设置">⚙️</button></div>
      <p class="muted" style="margin:0 0 16px">每天 10 分钟，一点一点认识更多华文字。<br>Who's practising today?</p>
      <div class="kids">${S.kids.map((k, i) => {
        const p = plan(k), done = (k.history[today()] || {}).done;
        return `<button class="card kid" data-i="${i}">
          <span class="av">${esc(k.avatar)}</span><span class="name">${esc(k.name)}</span>
          <span class="chips">
            <span class="chip green">认识 ${learned(k).length} 字</span>
            <span class="chip gold">🔥 ${streak(k)} 天</span>
            <span class="chip ${done ? 'green' : 'red'}">${done ? '✓ 今天完成' : `今天：复习 ${p.due.length} · 新字 ${p.fresh.length}`}</span>
          </span></button>`;
      }).join('')}</div>`;
    $app.querySelectorAll('.kid').forEach(b => b.onclick = () => { current = S.kids[+b.dataset.i]; go('kid'); });
    document.getElementById('set').onclick = () => go('settings');
  }

  // ---------- DASHBOARD ----------
  function dash() {
    const k = current, p = plan(k), h = k.history[today()] || {};
    const days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
    const wk = ['日', '一', '二', '三', '四', '五', '六'];
    const nothing = !p.due.length && !p.fresh.length;
    $app.innerHTML = `
      <div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button>
        <span class="chip gold">⭐ ${k.stars}</span></div>
      <div class="hello"><span class="av">${esc(k.avatar)}</span><div><h2>${esc(k.name)}，你好！</h2>
        <div class="muted small">${h.done ? '今天的任务完成啦，真棒！' : '准备好今天的 10 分钟了吗？'}</div></div></div>
      <div class="stats">
        <div class="stat"><b>${learned(k).length}</b><span>认识的字</span></div>
        <div class="stat"><b>${mastered(k).length}</b><span>牢牢记住</span></div>
        <div class="stat"><b>🔥${streak(k)}</b><span>连续天数</span></div>
      </div>
      <div class="card mission">
        <h3>今天的任务 Today</h3>
        ${h.done ? `<div class="done-banner">✓ 已完成：复习 ${h.reviewed || 0} 次，学了 ${h.newCount || 0} 个新字，用时 ${Math.round((h.sec || 0) / 60)} 分钟</div>` : ''}
        <div class="mission-row">
          <span class="chip ${p.due.length ? 'red' : ''}">🔁 要复习 ${p.due.length} 个字</span>
          <span class="chip gold">✨ 新字 ${p.fresh.length} 个 ${p.fresh.map(c => `<span class="hz">${c}</span>`).join(' ')}</span>
        </div>
        ${nothing
          ? `<button class="btn green block" id="extra">${learned(k).length ? '💪 再练一练 Extra practice' : '开始 Start'}</button>`
          : `<button class="btn block" id="start">▶ 开始今天的练习</button>`}
        <div class="week">${days.map(d => {
          const ds = dayStr(d), on = (k.history[ds] || {}).done;
          return `<div class="day">${wk[d.getDay()]}<i class="${on ? 'on' : ''} ${ds === today() ? 'today' : ''}">${on ? '⭐' : ''}</i></div>`;
        }).join('')}</div>
      </div>
      <div class="links">
        <button class="card link" id="lib"><b>📚 我的字库</b><span class="muted small">看看学过的所有字</span></button>
        <button class="card link" id="extra2" ${learned(k).length ? '' : 'disabled'}><b>💪 自由复习</b><span class="muted small">多练一会儿，不影响计划</span></button>
      </div>`;
    document.getElementById('back').onclick = () => go('home');
    document.getElementById('lib').onclick = () => go('library');
    const st = document.getElementById('start'); if (st) st.onclick = () => go('session', { mode: 'daily' });
    const ex = document.getElementById('extra');
    if (ex) ex.onclick = () => go('session', { mode: learned(k).length ? 'extra' : 'daily' });
    document.getElementById('extra2').onclick = () => learned(k).length && go('session', { mode: 'extra' });
  }

  // ---------- SESSION ----------
  function buildQueue(k, mode) {
    const q = [];
    if (mode === 'extra') {
      // weakest learned cards first
      const pool = learned(k).sort((a, b) => k.cards[a].box - k.cards[b].box || (k.cards[b].bad || 0) - (k.cards[a].bad || 0));
      shuffle(pool.slice(0, 20)).forEach(c => q.push({ t: 'review', c, practice: true }));
      return { q, fresh: [] };
    }
    if (mode === 'bonus') {
      const fresh = nextNew(k, 2);
      const q2 = fresh.map(c => ({ t: 'learn', c }));
      fresh.forEach(c => q2.push({ t: 'check', c }));
      return { q: q2, fresh };
    }
    const p = plan(k);
    const reviews = p.due.slice(0, 60).map(c => ({ t: 'review', c }));
    const warm = reviews.splice(0, Math.min(3, reviews.length));
    q.push(...warm);
    // learn new chars in pairs, each followed by a quick check a few items later
    const learns = [];
    p.fresh.forEach(c => learns.push({ t: 'learn', c }));
    while (learns.length || reviews.length) {
      const pair = learns.splice(0, 2);
      q.push(...pair);
      q.push(...reviews.splice(0, 2));
      pair.forEach(x => q.push({ t: 'check', c: x.c }));
      q.push(...reviews.splice(0, pair.length ? 2 : reviews.length));
    }
    return { q, fresh: p.fresh };
  }

  function runSession(opts) {
    const k = current;
    const built = buildQueue(k, opts.mode);
    if (!built.q.length) { go('kid'); return; }
    session = { mode: opts.mode, q: built.q, i: 0, start: Date.now(), sec: 0, right: 0, wrong: 0, reviewed: 0,
      learnedNow: [], stars: 0, missed: {}, timeUpShown: false, total: built.q.length };
    $app.innerHTML = `
      <div class="sbar"><button class="icon-btn" id="quit" aria-label="结束">✕</button>
        <div class="track" title="10 分钟进度"><i id="bar"></i></div><span class="timer" id="clock">0:00</span></div>
      <div class="stage" id="stage"></div>`;
    document.getElementById('quit').onclick = () => finish(true);
    const tick = () => {
      session.sec = Math.floor((Date.now() - session.start) / 1000);
      const s = session.sec;
      document.getElementById('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      document.getElementById('bar').style.width = Math.min(100, s / SESSION_SEC * 100) + '%';
    };
    tick(); timerId = setInterval(tick, 1000);
    step();
  }

  function step() {
    const s = session;
    if (s.mode === 'daily' && s.sec >= SESSION_SEC && !s.timeUpShown) {
      s.timeUpShown = true; markDone();
      if (s.i < s.q.length) { timeUp(); return; }
    }
    if (s.i >= s.q.length) { finish(false); return; }
    const item = s.q[s.i];
    if (item.t === 'learn') learnCard(item.c); else quiz(item);
  }
  function next() { session.i++; step(); }

  function timeUp() {
    const stage = document.getElementById('stage');
    stage.innerHTML = `<div class="sum card"><div class="trophy">⏰</div><h2>10 分钟到啦！</h2>
      <p class="muted">今天的任务已经算完成了。还剩 ${session.q.length - session.i} 题，要继续吗？</p>
      <div class="row" style="width:100%"><button class="btn ghost" id="stop">休息一下</button><button class="btn green" id="more">继续 💪</button></div></div>`;
    document.getElementById('stop').onclick = () => finish(false);
    document.getElementById('more').onclick = () => step();
  }

  function wordsHTML(x) {
    return `<div class="words">${x.words.map(w => `<button class="word" data-say="${esc(w.w)}">
      <span class="w">${esc(w.w)}</span><span><div class="wp">${esc(w.py)}</div><div class="wm">${esc(w.en)}</div></span><span class="sp">🔊</span></button>`).join('')}</div>`;
  }
  function bindSay(root) { root.querySelectorAll('[data-say]').forEach(b => b.onclick = () => say(b.dataset.say)); }

  function charPanel(x, withWriter) {
    return `<div class="tzg"><span class="big hz">${x.c}</span>${withWriter ? '<div class="writer"></div>' : ''}</div>
      <div class="py">${esc(x.py)}</div><div class="mean">${esc(x.en)}</div>`;
  }
  function bindWriter(root, x) {
    const el = root.querySelector('.writer'); if (!el) return;
    let w = mountWriter(el, x.c, 'show');
    const tools = root.querySelector('.tools');
    if (!w) { root.querySelectorAll('.needs-writer').forEach(b => b.remove()); return; }
    tools.querySelector('#anim').onclick = () => { w.showCharacter(); w.animateCharacter(); };
    tools.querySelector('#trace').onclick = () => {
      w.hideCharacter();
      w.quiz({ onComplete: () => { toast('写得好！✍️'); setTimeout(() => w.showCharacter(), 600); } });
    };
    setTimeout(() => { try { w.animateCharacter(); } catch (e) {} }, 350);
  }

  function learnCard(c) {
    const x = BY[c], stage = document.getElementById('stage');
    stage.innerHTML = `<span class="tag new">✨ 新字 New</span>
      ${charPanel(x, true)}
      <div class="tools">
        <button class="tool" id="spk">🔊 读音</button>
        <button class="tool needs-writer" id="anim">▶ 笔顺</button>
        <button class="tool needs-writer" id="trace">✍️ 写一写</button>
      </div>
      ${wordsHTML(x)}
      <div class="row"><button class="btn ghost" id="know">我早就认识</button><button class="btn green" id="got">记住了 👍</button></div>`;
    bindSay(stage); bindWriter(stage, x);
    stage.querySelector('#spk').onclick = () => say(x.c);
    setTimeout(() => say(x.c), 300);
    const k = current;
    stage.querySelector('#got').onclick = () => {
      k.cards[c] = { box: 0, due: today(), ok: 0, bad: 0, first: today() };
      session.learnedNow.push(c); session.stars += 2; k.stars += 2; bumpToday({ newCount: 1 }); save(k); next();
    };
    stage.querySelector('#know').onclick = () => {
      k.cards[c] = { box: 5, due: addDays(INTERVAL[5]), ok: 1, bad: 0, first: today(), known: true };
      // skip its quick check; fetch one more new char to keep today's count
      session.q = session.q.filter((it, j) => !(j > session.i && it.t === 'check' && it.c === c));
      const more = CHARS.find(y => !k.cards[y.c] && !session.q.some(it => it.c === y.c));
      if (more && session.mode === 'daily') {
        session.q.splice(session.i + 1, 0, { t: 'learn', c: more.c });
        session.q.splice(Math.min(session.q.length, session.i + 4), 0, { t: 'check', c: more.c });
      }
      session.stars += 1; k.stars += 1; save(k); toast('厉害！这个字放进字库了 👏'); next();
    };
  }

  function distractors(c, field, n, noSameSound) {
    const k = current, x = BY[c];
    const known = learned(k).filter(y => y !== c);
    const near = CHARS.slice(Math.max(0, x.idx - 25), x.idx + 25).map(y => y.c).filter(y => y !== c);
    const pool = shuffle([...new Set([...shuffle(known).slice(0, 12), ...near])]);
    const out = [], seen = new Set([x[field]]);
    for (const y of pool) {
      const v = BY[y][field];
      if (seen.has(v)) continue;
      if (noSameSound && BY[y].py === x.py) continue;  // e.g. 他/她 sound identical
      if (field === 'en' && BY[y].en.split(/[;,]/)[0].trim() === x.en.split(/[;,]/)[0].trim()) continue;
      seen.add(v); out.push(y); if (out.length >= n) break;
    }
    return out;
  }

  function chooseType(item) {
    const card = current.cards[item.c] || { box: 0 };
    if (item.t === 'check') return pick(canSpeak() ? ['meaning', 'listen'] : ['meaning', 'reverse']);
    if (item.retry) return pick(['meaning', 'reverse']);
    const types = ['meaning', 'reverse'];
    if (canSpeak()) types.push('listen');
    if (card.box >= 2) types.push('flash', 'flash');
    if (card.box >= 4) types.push('flash');
    return pick(types);
  }

  function quiz(item) {
    const x = BY[item.c], type = chooseType(item), stage = document.getElementById('stage');
    const tag = item.t === 'check' ? '<span class="tag new">✨ 刚学的字 Quick check</span>' : '<span class="tag rev">🔁 复习 Review</span>';
    if (type === 'flash') return flash(item, x, tag);
    let head, field;
    if (type === 'meaning') {
      head = `<div class="prompt">这个字是什么意思？</div><div class="tzg"><span class="big hz">${x.c}</span></div>`;
      field = 'en';
    } else if (type === 'listen') {
      head = `<div class="prompt">听一听，是哪个字？</div><button class="speak" id="rep" aria-label="再听一次">🔊</button>`;
      field = 'c';
    } else {
      head = `<div class="prompt">哪个字是 “${esc(x.en)}”？</div><div class="py">${esc(x.py)}</div>`;
      field = 'c';
    }
    const opts = shuffle([item.c, ...distractors(item.c, field, 3, type === 'listen')]);
    stage.innerHTML = `${tag}${head}
      <div class="opts">${opts.map(o => `<button class="opt ${field === 'c' ? 'hzopt' : ''}" data-c="${o}">${esc(field === 'c' ? o : BY[o].en)}</button>`).join('')}</div>
      <div class="feedback" id="fb"></div><div id="after"></div>`;
    if (type === 'listen') { const r = stage.querySelector('#rep'); r.onclick = () => say(x.c); setTimeout(() => say(x.c), 250); }
    stage.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const ok = b.dataset.c === item.c;
      stage.querySelectorAll('.opt').forEach(o => { o.disabled = true; if (o.dataset.c === item.c) o.classList.add('right'); });
      if (!ok) b.classList.add('wrong');
      const fb = stage.querySelector('#fb');
      fb.className = 'feedback ' + (ok ? 'ok' : 'no');
      fb.textContent = ok ? pick(['答对了！🎉', '太棒了！⭐', '好厉害！👏', '对啦！✨']) : `再记一记：${x.c} = ${x.py}，${x.en}`;
      grade(item, ok ? 'good' : 'again');
      say(x.c);
      const after = stage.querySelector('#after');
      if (ok) setTimeout(next, 900);
      else {
        after.innerHTML = `${wordsHTML(x)}<div style="margin-top:12px"><button class="btn block" id="nx">继续 →</button></div>`;
        bindSay(after); after.querySelector('#nx').onclick = next;
      }
    });
  }

  function flash(item, x, tag) {
    const stage = document.getElementById('stage');
    stage.innerHTML = `${tag}<div class="prompt">你还记得这个字吗？读出来，想想意思</div>
      <div class="tzg"><span class="big hz">${x.c}</span></div>
      <div id="ans"></div>
      <button class="btn block" id="show">看答案 👀</button>`;
    stage.querySelector('#show').onclick = () => {
      say(x.c);
      stage.querySelector('#show').remove();
      const ans = stage.querySelector('#ans');
      ans.innerHTML = `<div class="py">${esc(x.py)}</div><div class="mean" style="margin-bottom:12px">${esc(x.en)}</div>${wordsHTML(x)}
        <div class="grade" style="margin-top:14px">
          <button class="btn" data-g="again">😵 忘了<small>Forgot</small></button>
          <button class="btn gold" data-g="hard">🤔 有点难<small>So-so</small></button>
          <button class="btn green" data-g="good">😎 记得<small>Got it</small></button></div>`;
      bindSay(ans);
      ans.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { grade(item, b.dataset.g); next(); });
    };
  }

  // update spaced-repetition state
  function grade(item, g) {
    const k = current, s = session, c = item.c;
    const card = k.cards[c]; if (!card) return;
    s.reviewed++;
    if (g === 'again') {
      s.wrong++; card.bad = (card.bad || 0) + 1; s.missed[c] = (s.missed[c] || 0) + 1;
      if (!item.practice) { card.box = 1; card.due = addDays(1); }
      if (s.missed[c] <= 2) s.q.splice(Math.min(s.q.length, s.i + 3), 0, { t: 'review', c, retry: true, practice: item.practice });
    } else {
      s.right++; card.ok = (card.ok || 0) + 1;
      const pts = g === 'good' ? 1 : 0; s.stars += pts; k.stars += pts;
      if (!item.practice && !item.retry) {
        if (item.t === 'check' || card.box === 0) { card.box = 1; card.due = addDays(1); }
        else if (s.missed[c]) { card.box = 1; card.due = addDays(1); }
        else if (g === 'hard') { card.box = Math.max(1, card.box - 1); card.due = addDays(Math.max(1, INTERVAL[card.box])); }
        else { card.box = Math.min(MAX_BOX, card.box + 1); card.due = addDays(INTERVAL[card.box]); }
      }
    }
    if (!item.practice) bumpToday({ reviewed: 1 });
    save(k);
  }

  function bumpToday(d) {
    const k = current, h = k.history[today()] = k.history[today()] || {};
    for (const key in d) h[key] = (h[key] || 0) + d[key];
  }
  function markDone() {
    const h = current.history[today()] = current.history[today()] || {};
    if (!h.done) { h.done = true; current.stars += 5; session.stars += 5; }
    save(current);
  }

  function finish(quit) {
    const s = session, k = current;
    clearInterval(timerId); timerId = null;
    const h = k.history[today()] = k.history[today()] || {};
    h.sec = (h.sec || 0) + s.sec;
    const completedQueue = s.i >= s.q.length;
    if (s.mode === 'daily' && (completedQueue || s.sec >= SESSION_SEC)) markDone();
    save(k);
    if (quit && s.reviewed === 0 && !s.learnedNow.length) { go('kid'); return; }
    go('summary', { quit, completedQueue });
  }

  function summary(r) {
    const s = session, k = current, h = k.history[today()] || {};
    if (h.done && !r.quit) confetti();
    const pct = s.reviewed ? Math.round(s.right / s.reviewed * 100) : 100;
    $app.innerHTML = `<div class="card sum">
      <div class="trophy">${h.done ? '🏆' : '👍'}</div>
      <h2>${h.done ? '今天完成啦！' : '练了一会儿，不错！'}</h2>
      <div class="chips" style="justify-content:center">
        <span class="chip gold">⭐ +${s.stars}</span>
        <span class="chip green">正确率 ${pct}%</span>
        <span class="chip">⏱ ${Math.floor(s.sec / 60)} 分 ${s.sec % 60} 秒</span>
        <span class="chip red">🔥 连续 ${streak(k)} 天</span>
      </div>
      ${s.learnedNow.length ? `<div class="muted">今天的新朋友：</div><div class="newchars">${s.learnedNow.map(c => `<span>${c}</span>`).join('')}</div>` : ''}
      ${Object.keys(s.missed).length ? `<div class="muted small">要多看看：<span class="hz" style="font-size:22px">${Object.keys(s.missed).join(' ')}</span>（明天会再出现）</div>` : ''}
      <p class="muted small">字库里一共有 <b>${learned(k).length}</b> 个字，其中 <b>${mastered(k).length}</b> 个已经牢牢记住。</p>
      ${(h.sec || 0) < SESSION_SEC && learned(k).length < CHARS.length
        ? `<p class="muted small" style="margin:0">今天才练了 ${Math.max(1, Math.round((h.sec || 0) / 60))} 分钟，还有时间吗？</p>
           <button class="btn gold block" id="bonus">✨ 再学 2 个新字</button>` : ''}
      <button class="btn block" id="ok">好的 👌</button></div>`;
    document.getElementById('ok').onclick = () => go('kid');
    const bn = document.getElementById('bonus'); if (bn) bn.onclick = () => go('session', { mode: 'bonus' });
  }

  // ---------- LIBRARY ----------
  function level(card) { if (!card) return ''; return card.box >= MASTER_BOX ? 'l4' : card.box >= 3 ? 'l3' : card.box >= 2 ? 'l2' : 'l1'; }
  function library() {
    const k = current;
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button>
      <h1>📚 ${esc(k.name)}的字库</h1><span class="chip green">${learned(k).length}/${CHARS.length}</span></div>
      <div class="legend"><span><i style="background:var(--red-soft)"></i>刚学</span><span><i style="background:var(--gold-soft)"></i>熟悉中</span>
        <span><i style="background:var(--green-soft)"></i>记得不错</span><span><i style="background:var(--gold)"></i>牢牢记住</span>
        <span><i style="background:var(--line);opacity:.5"></i>还没学</span></div>
      ${UNITS.map(u => {
        const list = CHARS.filter(x => x.unit === u);
        const got = list.filter(x => k.cards[x.c]).length;
        return `<div class="unit"><span>${esc(u)}</span><span class="muted small">${got}/${list.length}</span></div>
          <div class="grid">${list.map(x => `<button class="cell ${k.cards[x.c] ? level(k.cards[x.c]) : 'locked'}" data-c="${x.c}">${x.c}</button>`).join('')}</div>`;
      }).join('')}`;
    document.getElementById('back').onclick = () => go('kid');
    $app.querySelectorAll('.cell').forEach(b => b.onclick = () => {
      if (!k.cards[b.dataset.c]) { toast('这个字还没学到，加油！🔒'); return; }
      detail(b.dataset.c);
    });
  }
  function detail(c) {
    const x = BY[c], card = current.cards[c];
    const m = document.createElement('div'); m.className = 'modal';
    const lv = { l1: '刚学', l2: '熟悉中', l3: '记得不错', l4: '牢牢记住 🏅' }[level(card)];
    m.innerHTML = `<div class="card">${charPanel(x, true)}
      <div class="tools"><button class="tool" id="spk">🔊 读音</button><button class="tool needs-writer" id="anim">▶ 笔顺</button><button class="tool needs-writer" id="trace">✍️ 写一写</button></div>
      ${wordsHTML(x)}
      <div class="muted small" style="text-align:center">${lv} · 答对 ${card.ok || 0} 次 · 下次复习 ${card.due <= today() ? '今天' : card.due}</div>
      <button class="btn ghost block" id="close">关闭</button></div>`;
    document.body.appendChild(m);
    bindSay(m); bindWriter(m, x);
    m.querySelector('#spk').onclick = () => say(x.c);
    say(x.c);
    m.querySelector('#close').onclick = () => m.remove();
    m.onclick = e => { if (e.target === m) m.remove(); };
  }

  // ---------- SETTINGS (parents) ----------
  function settings() {
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>家长设置</h1><span></span></div>
      <div class="card" style="display:flex;flex-direction:column;gap:14px">
        <h3>小朋友</h3>
        ${S.kids.map((k, i) => `<div class="set-kid">
          <select data-av="${i}" aria-label="头像">${AVATARS.map(a => `<option ${a === k.avatar ? 'selected' : ''}>${a}</option>`).join('')}</select>
          <label class="field">名字<input type="text" data-name="${i}" value="${esc(k.name)}" maxlength="12"></label>
          <label class="field" style="grid-column:1/-1">每天新字数量
            <select data-per="${i}">${[2, 3, 4, 5, 6, 8, 10, 12].map(n => `<option ${n === k.perDay ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <div class="muted small" style="grid-column:1/-1">认识 ${learned(k).length} 字 · 牢记 ${mastered(k).length} 字 · 连续 ${streak(k)} 天
            · <button class="small" style="text-decoration:underline;color:var(--red)" data-reset="${i}">清空进度</button></div>
        </div>`).join('')}
        <p class="muted small" style="margin:0">建议：10 岁每天 3–5 个新字，13 岁 5–8 个。复习的字太多时，系统会自动减少新字，先把旧字记牢。
          遇到已经认识的字，点「我早就认识」就会直接放进字库，不浪费时间。</p>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
        <h3>备份 / 换设备</h3>
        <p class="muted small" style="margin:0">在 claude.ai 登录打开时，进度会自动同步到各个设备；其他情况下进度只保存在这台设备的浏览器里，换设备前可以先下载备份，再到新设备上导入。</p>
        <div class="row"><button class="btn ghost" id="exp">⬇ 下载备份</button><button class="btn ghost" id="imp">⬆ 导入备份</button></div>
        <input type="file" id="file" accept="application/json,.json" hidden>
      </div>`;
    document.getElementById('back').onclick = () => go('home');
    $app.querySelectorAll('[data-name]').forEach(el => el.oninput = () => { S.kids[+el.dataset.name].name = el.value.trim() || '小朋友'; save(S.kids[+el.dataset.name]); });
    $app.querySelectorAll('[data-av]').forEach(el => el.onchange = () => { S.kids[+el.dataset.av].avatar = el.value; save(S.kids[+el.dataset.av]); });
    $app.querySelectorAll('[data-per]').forEach(el => el.onchange = () => { S.kids[+el.dataset.per].perDay = +el.value; save(S.kids[+el.dataset.per]); });
    $app.querySelectorAll('[data-reset]').forEach(el => el.onclick = () => {
      const k = S.kids[+el.dataset.reset];
      ask(`确定清空「${k.name}」的全部进度吗？此操作无法撤销。`, '清空').then(ok => {
        if (ok) { Object.assign(k, { cards: {}, history: {}, stars: 0 }); save(k); settings(); }
      });
    });
    document.getElementById('exp').onclick = async () => {
      const json = JSON.stringify(S, null, 1), name = `hanzi-backup-${today()}.json`;
      let dl = null;
      try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) {}
      if (dl) {
        try { await dl.save({ filename: name, data: json }); toast('备份已保存 ✓'); }
        catch (e) { if (e && e.code !== 'declined') toast('这里没法下载文件，请换浏览器打开'); }
        return;
      }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = name; document.body.appendChild(a); a.click(); a.remove();
    };
    const file = document.getElementById('file');
    document.getElementById('imp').onclick = () => file.click();
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      f.text().then(t => {
        const d = JSON.parse(t);
        if (!d || !Array.isArray(d.kids) || !d.kids.every(k => k && k.id && k.cards)) throw new Error('bad');
        return ask('导入后会覆盖现在的进度，确定吗？', '导入').then(ok => {
          if (!ok) return;
          S = d; save(); toast('导入成功 ✓'); settings();
        });
      }).catch(() => toast('文件格式不对')).finally(() => { file.value = ''; });
    };
  }

  go('home');
})();
