/* 十分钟英语 — daily 10-minute English reading for a learner who has passed CET-4.
 * Each day: review due words (spaced repetition) → read one short article → 3 questions → add new words.
 * Articles: when running as a claude.ai artifact with `sample`, Claude writes a fresh one each day;
 * otherwise the built-in articles.json is used.
 * Storage: localStorage always; plus the artifact `db` (profile/main, words/<id>, articles/<id>) when available. */
(function () {
  'use strict';

  const INTERVAL = [0, 1, 2, 4, 7, 14, 30, 60, 120];
  const MAX_BOX = INTERVAL.length - 1, MASTER = 6, GOAL_SEC = 600, REVIEW_CAP = 12, IDLE_MS = 150000;
  const KEY = 'english10-v1';
  const GOALS = { cet6: '大学英语六级 CET-6', kaoyan: '考研英语', ielts: '雅思 / 托福', work: '职场英语' };
  const TOPICS = ['科技', '心理', '健康', '商业', '环境', '文化', '历史', '科学', '体育', '旅行', '教育', '社会'];

  // ---------- helpers ----------
  const $app = document.getElementById('app');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pick = a => a[Math.floor(Math.random() * a.length)];
  const dayStr = d => { d = d || new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const today = () => dayStr();
  const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return dayStr(d); };
  const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const wid = w => String(w).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_\-.~:@+]/g, '').slice(0, 120) || ('w' + Date.now());
  function toast(msg, ms) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms || 2400); }
  function ask(msg, okLabel) {
    return new Promise(res => {
      const m = document.createElement('div'); m.className = 'modal';
      m.innerHTML = '<div class="card"><p style="margin:0;font-weight:800;font-size:17px"></p><div class="row"><button class="btn ghost" data-a="0">取消</button><button class="btn" data-a="1"></button></div></div>';
      m.querySelector('p').textContent = msg; m.querySelector('[data-a="1"]').textContent = okLabel || '确定';
      m.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { m.remove(); res(b.dataset.a === '1'); });
      document.body.appendChild(m);
    });
  }
  const use = async name => { try { return window.claude && typeof window.claude.use === 'function' ? await window.claude.use(name) : null; } catch (e) { return null; } };

  // ---------- state ----------
  function blank() {
    return { profile: { name: '', goal: 'cet6', topics: ['科技', '心理', '健康', '商业'], length: 260, ai: true, updated: 0 },
      days: {}, words: {}, articles: {} };
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.profile && s.words) return s; } catch (e) {}
    return blank();
  }
  let S = load();
  let BANK = [];
  const bankReady = fetch('articles.json').then(r => r.json()).then(a => { BANK = Array.isArray(a) ? a : []; }).catch(() => {});

  // ---------- sync ----------
  let db = null;
  const dirty = new Set(), writing = new Set();
  let flushT = null;
  function docOf(path) {
    const [c, id] = path.split('/');
    if (c === 'profile') return { profile: S.profile, days: S.days, updated: S.profile.updated };
    if (c === 'words') return S.words[id];
    if (c === 'articles') return S.articles[id];
  }
  function touch(path) {
    const d = docOf(path); if (d) d.updated = Date.now();
    if (path === 'profile/main') S.profile.updated = Date.now();
    dirty.add(path);
  }
  function save(...paths) {
    paths.forEach(touch);
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
    if (db) { clearTimeout(flushT); flushT = setTimeout(flush, 1500); }
  }
  async function flush() {
    for (const path of [...dirty]) {
      if (writing.has(path)) continue;
      dirty.delete(path);
      const d = docOf(path);
      writing.add(path);
      try {
        if (d) await db.doc(path).set(JSON.parse(JSON.stringify(d)));
        else await db.doc(path).delete();
      } catch (e) { dirty.add(path); if (!flush.w) { flush.w = 1; toast('暂时没能同步，进度已保存在这台设备上'); } }
      writing.delete(path);
    }
    if (dirty.size) { clearTimeout(flushT); flushT = setTimeout(flush, 4000); }
  }
  let view = 'home', inSession = false;
  function applyRemote(coll, docs) {
    let changed = false;
    docs.forEach(({ id, data }) => {
      if (!data || typeof data !== 'object') return;
      const path = coll + '/' + id;
      if (dirty.has(path) || writing.has(path)) return;
      if (coll === 'profile') {
        if ((data.updated || 0) > (S.profile.updated || 0) && data.profile && !inSession) {
          S.profile = data.profile; S.profile.updated = data.updated; S.days = data.days || {}; changed = true;
        }
      } else {
        const bag = coll === 'words' ? S.words : S.articles;
        if (!bag[id] || (data.updated || 0) > (bag[id].updated || 0)) { bag[id] = data; changed = true; }
      }
    });
    if (changed) { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} if (view === 'home') go('home'); }
  }
  (async function connect() {
    const d = await use('db'); if (!d) return;
    db = d;
    ['profile', 'words', 'articles'].forEach(coll => {
      let first = true;
      db.collection(coll).onSnapshot(snap => {
        const docs = snap.docs.map(x => { let data = null; try { data = JSON.parse(JSON.stringify(x.data())); } catch (e) {} return { id: x.id, data }; });
        if (first && !snap.metadata.fromCache) {
          first = false;
          const have = new Set(docs.map(x => x.id));
          // upload anything made on this device before the store was reachable
          if (coll === 'profile' && !have.has('main') && (S.profile.updated || Object.keys(S.days).length)) dirty.add('profile/main');
          if (coll === 'words') Object.keys(S.words).forEach(id => { if (!have.has(id)) dirty.add('words/' + id); });
          if (coll === 'articles') Object.keys(S.articles).forEach(id => { if (!have.has(id)) dirty.add('articles/' + id); });
          if (dirty.size) { clearTimeout(flushT); flushT = setTimeout(flush, 800); }
        }
        applyRemote(coll, docs);
      }, () => {});
    });
  })();

  // ---------- time tracking (active only) ----------
  let lastInput = Date.now();
  ['pointerdown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(ev => window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
  const day = () => (S.days[today()] = S.days[today()] || {});
  let tickN = 0;
  setInterval(() => {
    if (document.visibilityState === 'hidden' || Date.now() - lastInput > IDLE_MS) return;
    const d = day(); d.sec = (d.sec || 0) + 1; d.lastAt = hhmm(); d.firstAt = d.firstAt || hhmm();
    if (++tickN % 20 === 0) save('profile/main');
    const c = document.getElementById('clock');
    if (c) { const t = d.sec; c.textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); const b = document.getElementById('tbar'); if (b) b.style.width = Math.min(100, t / GOAL_SEC * 100) + '%'; }
  }, 1000);
  (function visit() { const d = day(); d.visits = (d.visits || 0) + 1; d.firstAt = d.firstAt || hhmm(); d.lastAt = hhmm(); save('profile/main'); })();

  // ---------- speech ----------
  let enVoice = null;
  function pickVoice() {
    if (!('speechSynthesis' in window)) return;
    const vs = speechSynthesis.getVoices();
    enVoice = vs.find(v => /en[-_]US/i.test(v.lang) && /samantha|google|natural|aria|jenny/i.test(v.name)) || vs.find(v => /en[-_](US|GB)/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function sayWord(text) {
    if (!('speechSynthesis' in window)) return;
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; if (enVoice) u.voice = enVoice; u.rate = 0.9; speechSynthesis.speak(u); } catch (e) {}
  }
  let tts = null; use('tts').then(t => { tts = t; });
  function sayLong(text) {
    if (tts) { tts.speak(text, { language: 'en' }).catch(() => sayWord(text)); return; }
    sayWord(text);
  }
  function stopSpeech() { try { if (tts) tts.stop(); } catch (e) {} try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) {} }

  // ---------- words / SRS ----------
  const wordList = () => Object.values(S.words).filter(w => w && w.w);
  const learning = () => wordList().filter(w => !w.known);
  const dueWords = () => learning().filter(w => w.due <= today()).sort((a, b) => a.due.localeCompare(b.due) || a.box - b.box);
  const mastered = () => wordList().filter(w => w.box >= MASTER);
  function addWord(v, opts) {
    const id = wid(v.w);
    const ex = S.words[id];
    if (ex) { if (opts && opts.known) { ex.known = true; ex.box = Math.max(ex.box, 5); ex.due = addDays(INTERVAL[5]); save('words/' + id); } return ex; }
    const w = { w: v.w, f: v.f || [], ipa: v.ipa || '', pos: v.pos || '', zh: v.zh || '', ex: v.ex || '', src: (opts && opts.src) || '', added: today(),
      box: opts && opts.known ? 5 : 0, due: opts && opts.known ? addDays(INTERVAL[5]) : today(), ok: 0, bad: 0, known: !!(opts && opts.known) };
    S.words[id] = w; save('words/' + id); return w;
  }
  function streak() {
    let n = 0; const d = new Date();
    if (!(S.days[dayStr(d)] || {}).done) d.setDate(d.getDate() - 1);
    while ((S.days[dayStr(d)] || {}).done) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ---------- today's article ----------
  let genP = null, genState = '';
  function todaysArticle() { const id = (S.days[today()] || {}).article; return id && S.articles[id]; }
  function validArticle(a) {
    return a && typeof a.title === 'string' && Array.isArray(a.paragraphs) && a.paragraphs.length >= 2 &&
      a.paragraphs.every(p => p && typeof p.en === 'string') && Array.isArray(a.vocab) && Array.isArray(a.questions) &&
      a.questions.every(q => q && typeof q.q === 'string' && Array.isArray(q.o) && q.o.length >= 2 && Number.isInteger(q.a) && q.a >= 0 && q.a < q.o.length);
  }
  function clean(a) {
    const s = x => String(x == null ? '' : x).slice(0, 2000);
    return {
      title: s(a.title).slice(0, 120), topic: s(a.topic).slice(0, 40),
      paragraphs: a.paragraphs.slice(0, 8).map(p => ({ en: s(p.en), zh: s(p.zh) })),
      vocab: a.vocab.slice(0, 10).filter(v => v && v.w).map(v => ({ w: s(v.w).slice(0, 60), f: Array.isArray(v.f) ? v.f.slice(0, 6).map(x => s(x).slice(0, 60)) : [], ipa: s(v.ipa).slice(0, 60), pos: s(v.pos).slice(0, 20), zh: s(v.zh).slice(0, 80), ex: s(v.ex).slice(0, 300) })),
      questions: a.questions.slice(0, 5).map(q => ({ q: s(q.q), o: q.o.slice(0, 5).map(s), a: q.a, why: s(q.why) }))
    };
  }
  async function generateAI() {
    const sample = await use('sample');
    if (!sample || !S.profile.ai) return null;
    const known = wordList().map(w => w.w).slice(-250);
    const recent = Object.values(S.articles).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 20).map(a => a.title);
    const topics = S.profile.topics.length ? S.profile.topics : TOPICS;
    const topic = pick(topics);
    const prompt = `You write daily English reading practice for a Chinese university student who has just passed CET-4 and is now working toward: ${GOALS[S.profile.goal] || GOALS.cet6}.
Write ONE original, accurate, interesting non-fiction article. Topic area (Chinese label): ${topic}. Choose a specific, concrete subject inside that area.
Level: CEFR B2 (CET-6). About ${S.profile.length} words in total, 4 paragraphs. Clear, natural modern English; no lists or headings inside paragraphs.
Do not repeat these recent titles: ${JSON.stringify(recent)}.
Choose 6 useful vocabulary items at CET-6 / 考研 level that appear in the article. Avoid these words the learner already studies: ${JSON.stringify(known)}.
Return ONLY a JSON object, no prose, with exactly this shape:
{"title": string, "topic": string (short English topic word),
 "paragraphs": [{"en": paragraph text, "zh": natural Chinese translation of that paragraph}],
 "vocab": [{"w": base form, "f": [other forms exactly as they appear in the article, if different from w], "ipa": British IPA in slashes, "pos": "n."|"v."|"adj."|"adv."|..., "zh": concise Chinese meaning as used, "ex": a NEW short example sentence}],
 "questions": [{"q": comprehension question in English, "o": [4 answer options in English], "a": index of the correct option (0-3), "why": one-sentence explanation in Chinese pointing to the paragraph}]}
Give exactly 3 questions testing main idea, detail, and inference.`;
    const data = await sample.json(prompt, { modelTier: 'default' });
    if (!validArticle(data)) throw { code: 'invalid_json' };
    return clean(data);
  }
  async function pickBank() {
    await bankReady;
    if (!BANK.length) return null;
    const read = new Set(Object.keys(S.articles));
    let a = BANK.find(b => !read.has(b.id));
    if (!a) { // all read: re-read the one read longest ago
      a = BANK.slice().sort((x, y) => ((S.articles[x.id] || {}).date || '').localeCompare((S.articles[y.id] || {}).date || ''))[0];
    }
    return Object.assign(JSON.parse(JSON.stringify(a)), { source: 'bank' });
  }
  function ensureArticle() {
    const have = todaysArticle(); if (have) return Promise.resolve(have);
    if (genP) return genP;
    genState = 'working';
    genP = (async () => {
      let art = null, id;
      try { art = await generateAI(); if (art) { art.source = 'ai'; id = 'a' + today().replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6); } }
      catch (e) { genState = (e && e.code) || 'error'; }
      if (!art) { art = await pickBank(); id = art && art.id; }
      if (!art) { genP = null; genState = 'none'; return null; }
      const prev = S.articles[id] || {};
      art = Object.assign({}, art, { id, date: today(), read: false, score: null, times: (prev.times || 0) });
      S.articles[id] = art; day().article = id; save('articles/' + id, 'profile/main');
      genState = 'ready';
      return art;
    })();
    return genP;
  }

  // ---------- router ----------
  function go(v, arg) {
    stopSpeech(); closeSheet();
    view = v; inSession = v === 'session';
    window.scrollTo(0, 0);
    ({ home, session: runSession, words: wordbook, history: pastArticles, reread, stats, settings })[v](arg);
  }

  // ---------- HOME ----------
  function home() {
    const d = S.days[today()] || {}, art = todaysArticle(), due = dueWords().length;
    const h = new Date().getHours();
    const hi = h < 11 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const doneR = d.reviewDone, doneA = art && art.read, doneQ = d.quiz != null;
    const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];
    $app.innerHTML = `
      <div class="greet"><div class="label">${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日 · 周${wd}</div>
        <h1>${hi}${S.profile.name ? ', ' + esc(S.profile.name) : ''}.</h1></div>
      <div class="card today">
        <div class="label">今天的 10 分钟</div>
        <div class="t-title">${art ? esc(art.title) : (d.done ? '今天已完成' : '一篇新文章在等你')}</div>
        <div class="steps">
          <div class="st ${doneR ? 'done' : ''}"><b>${doneR ? '✓ ' : ''}复习</b>${due ? due + ' 个单词' : (doneR ? '完成' : '暂无到期')}</div>
          <div class="st ${doneA ? 'done' : ''}"><b>${doneA ? '✓ ' : ''}阅读</b>约 ${art ? Math.max(1, Math.round(art.paragraphs.map(p => p.en).join(' ').split(/\s+/).length / 120)) : 2} 分钟</div>
          <div class="st ${doneQ ? 'done' : ''}"><b>${doneQ ? '✓ ' : ''}理解题</b>${doneQ ? '答对 ' + d.quiz + '/3' : '3 道'}</div>
        </div>
        <div class="meter"><span>今日 ${Math.floor((d.sec || 0) / 60)} 分钟</span><div class="track"><i style="width:${Math.min(100, (d.sec || 0) / GOAL_SEC * 100)}%"></i></div><span>10</span></div>
        <button class="btn block" id="go">${d.done ? '再读一遍今天的文章' : (doneR || doneA ? '继续' : '开始')}</button>
      </div>
      <div class="nums">
        <div class="num"><b>${learning().length}</b><span>生词本</span></div>
        <div class="num"><b>${mastered().length}</b><span>已掌握</span></div>
        <div class="num"><b>${streak()}</b><span>连续天数</span></div>
      </div>
      <div class="menu">
        <button class="card" id="m-words"><b>生词本</b><span class="muted small">${due} 个今天到期</span></button>
        <button class="card" id="m-hist"><b>往期文章</b><span class="muted small">已读 ${Object.values(S.articles).filter(a => a.read).length} 篇</span></button>
        <button class="card" id="m-stats"><b>学习记录</b><span class="muted small">每天读了多久</span></button>
        <button class="card" id="m-set"><b>设置</b><span class="muted small">目标、兴趣、备份</span></button>
      </div>`;
    document.getElementById('go').onclick = () => d.done && art ? go('reread', art.id) : go('session');
    document.getElementById('m-words').onclick = () => go('words');
    document.getElementById('m-hist').onclick = () => go('history');
    document.getElementById('m-stats').onclick = () => go('stats');
    document.getElementById('m-set').onclick = () => go('settings');
  }

  // ---------- SESSION ----------
  let sess = null;
  function runSession() {
    const d = day();
    const ta = todaysArticle();
    sess = { phase: !d.reviewDone ? 'review' : !(ta && ta.read) ? 'read' : d.quiz == null ? 'quiz' : 'words', right: 0, wrong: 0, newWords: 0, missed: {} };
    ensureArticle(); // start writing / picking the article while reviewing
    $app.innerHTML = `
      <div class="sbar"><button class="icon-btn" id="quit" aria-label="结束">✕</button>
        <div class="track" title="今天的阅读时间（目标 10 分钟）"><i id="tbar" style="width:${Math.min(100, (d.sec || 0) / GOAL_SEC * 100)}%"></i></div>
        <span class="clock" id="clock">${Math.floor((d.sec || 0) / 60)}:${String((d.sec || 0) % 60).padStart(2, '0')}</span></div>
      <div class="phase" id="phase"></div>
      <div class="stage" id="stage"></div>`;
    document.getElementById('quit').onclick = () => { stopSpeech(); go('home'); };
    nextPhase();
  }
  function setPhase(p) {
    sess.phase = p;
    const order = ['review', 'read', 'quiz', 'words'], names = { review: '复习', read: '阅读', quiz: '理解题', words: '新词' };
    const i = order.indexOf(p);
    document.getElementById('phase').innerHTML = order.map((x, j) => `<span class="${j < i ? 'ok' : j === i ? 'on' : ''}">${names[x]}</span>`).join('');
  }
  function nextPhase() {
    if (sess.phase === 'review') {
      const q = dueWords().slice(0, REVIEW_CAP).map(w => ({ id: wid(w.w) }));
      if (!q.length) { day().reviewDone = true; save('profile/main'); sess.phase = 'read'; return nextPhase(); }
      setPhase('review'); sess.q = q; sess.i = 0; return reviewStep();
    }
    if (sess.phase === 'read') { setPhase('read'); return readStep(); }
    if (sess.phase === 'quiz') { setPhase('quiz'); return quizStep(); }
    if (sess.phase === 'words') { setPhase('words'); return wordsStep(); }
    finishSession();
  }

  // --- review
  function distractors(w, field, n) {
    const pool = shuffle([...wordList(), ...BANK.flatMap(a => a.vocab)]);
    const out = [], seen = new Set([String(w[field]).toLowerCase()]);
    for (const x of pool) {
      const v = String(x[field] || '').toLowerCase();
      if (!v || seen.has(v) || x.w === w.w) continue;
      seen.add(v); out.push(x); if (out.length >= n) break;
    }
    return out;
  }
  function blankOut(w) {
    const forms = [w.w, ...(w.f || [])].sort((a, b) => b.length - a.length);
    for (const f of forms) {
      const re = new RegExp('\\b' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(w.ex)) return w.ex.replace(re, '\u0000');
    }
    return null;
  }
  function reviewStep() {
    if (sess.i >= sess.q.length) { day().reviewDone = true; save('profile/main'); sess.phase = 'read'; return nextPhase(); }
    const item = sess.q[sess.i], w = S.words[item.id];
    if (!w) { sess.i++; return reviewStep(); }
    const stage = document.getElementById('stage');
    const cl = w.ex ? blankOut(w) : null;
    const types = ['en2zh', 'zh2en'];
    if (cl) types.push('cloze');
    if (w.box >= 3 && cl) types.push('spell');
    if (w.box >= 3) types.push('flash', 'flash');
    const type = item.retry ? 'en2zh' : pick(types);
    const head = `<div class="label" style="text-align:center">复习 ${sess.i + 1} / ${sess.q.length}</div>`;
    if (type === 'flash') {
      stage.innerHTML = `${head}<div class="qword"><div class="w">${esc(w.w)}</div><div class="ipa">${esc(w.ipa)} <button class="spk" id="spk" aria-label="发音">🔊</button></div></div>
        <div class="prompt">还记得它的意思吗？</div><div id="ans"></div><button class="btn block" id="show">看答案</button>`;
      stage.querySelector('#spk').onclick = () => sayWord(w.w);
      stage.querySelector('#show').onclick = () => {
        stage.querySelector('#show').remove();
        stage.querySelector('#ans').innerHTML = `<div class="vcard"><div class="hd"><span class="muted">${esc(w.pos)}</span><b>${esc(w.zh)}</b></div>${w.ex ? `<div class="ex">${esc(w.ex)}</div>` : ''}</div>
          <div class="grade" style="margin-top:12px"><button class="btn again" data-g="again">忘了<small>Forgot</small></button>
          <button class="btn hard" data-g="hard">模糊<small>Hard</small></button><button class="btn" data-g="good">记得<small>Got it</small></button></div>`;
        stage.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { grade(item, b.dataset.g); sess.i++; reviewStep(); });
      };
      return;
    }
    if (type === 'spell') {
      stage.innerHTML = `${head}<div class="prompt">${esc(w.pos)} ${esc(w.zh)}</div>
        <div class="cloze">${esc(cl).replace('\u0000', '<u>&nbsp;</u>')}</div>
        <input class="spell" id="sp" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="拼写这个单词">
        <div class="fb" id="fb"></div><button class="btn block" id="chk">确定</button>`;
      const inp = stage.querySelector('#sp'); inp.focus();
      const check = () => {
        const v = inp.value.trim().toLowerCase(); if (!v) return;
        const ok = [w.w, ...(w.f || [])].some(f => f.toLowerCase() === v);
        inp.disabled = true; const fb = stage.querySelector('#fb');
        fb.className = 'fb ' + (ok ? 'ok' : 'no'); fb.textContent = ok ? '拼对了 ✓' : '正确拼写：' + w.w;
        sayWord(w.w); grade(item, ok ? 'good' : 'again');
        const b = stage.querySelector('#chk'); b.textContent = '继续'; b.onclick = () => { sess.i++; reviewStep(); };
        if (ok) setTimeout(() => { if (stage.contains(b)) b.click(); }, 900);
      };
      stage.querySelector('#chk').onclick = check;
      inp.onkeydown = e => { if (e.key === 'Enter') check(); };
      return;
    }
    let prompt, opts, label, isEn;
    if (type === 'en2zh') {
      prompt = `<div class="qword"><div class="w">${esc(w.w)}</div><div class="ipa">${esc(w.ipa)} <button class="spk" id="spk" aria-label="发音">🔊</button></div></div>`;
      opts = shuffle([w, ...distractors(w, 'zh', 3)]); label = x => (x.pos ? x.pos + ' ' : '') + x.zh; isEn = false;
    } else if (type === 'zh2en') {
      prompt = `<div class="prompt" style="font-size:22px;padding:20px 0 6px">${esc(w.pos)} ${esc(w.zh)}</div>`;
      opts = shuffle([w, ...distractors(w, 'w', 3)]); label = x => x.w; isEn = true;
    } else {
      prompt = `<div class="cloze" style="padding:14px 0 4px">${esc(cl).replace('\u0000', '<u>&nbsp;</u>')}</div><div class="hint" style="text-align:center">选出填空的单词</div>`;
      opts = shuffle([w, ...distractors(w, 'w', 3)]); label = x => x.w; isEn = true;
    }
    stage.innerHTML = `${head}${prompt}<div class="opts">${opts.map((o, i) => `<button class="opt ${isEn ? 'en' : ''}" data-i="${i}">${esc(label(o))}</button>`).join('')}</div><div class="fb" id="fb"></div><div id="after"></div>`;
    const spk = stage.querySelector('#spk'); if (spk) { spk.onclick = () => sayWord(w.w); sayWord(w.w); }
    stage.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const ok = opts[+b.dataset.i].w === w.w;
      stage.querySelectorAll('.opt').forEach((o, i) => { o.disabled = true; if (opts[i].w === w.w) o.classList.add('right'); });
      if (!ok) b.classList.add('wrong');
      const fb = stage.querySelector('#fb'); fb.className = 'fb ' + (ok ? 'ok' : 'no');
      fb.textContent = ok ? pick(['Correct!', 'Nice!', 'Well done!']) : `${w.w}：${w.zh}`;
      if (type !== 'en2zh') sayWord(w.w);
      grade(item, ok ? 'good' : 'again');
      if (ok) setTimeout(() => { sess.i++; reviewStep(); }, 800);
      else {
        const after = stage.querySelector('#after');
        after.innerHTML = `${w.ex ? `<div class="vcard"><div class="ex">${esc(w.ex)}</div></div>` : ''}<button class="btn block" style="margin-top:10px" id="nx">继续</button>`;
        after.querySelector('#nx').onclick = () => { sess.i++; reviewStep(); };
      }
    });
  }
  function grade(item, g) {
    const w = S.words[item.id]; if (!w) return;
    const d = day(); d.reviewed = (d.reviewed || 0) + 1;
    if (g === 'again') {
      sess.wrong++; d.wrong = (d.wrong || 0) + 1; w.bad = (w.bad || 0) + 1;
      sess.missed[item.id] = (sess.missed[item.id] || 0) + 1;
      w.box = 1; w.due = addDays(1);
      if (sess.missed[item.id] <= 1) sess.q.splice(Math.min(sess.q.length, sess.i + 3), 0, { id: item.id, retry: true });
    } else {
      sess.right++; d.right = (d.right || 0) + 1; w.ok = (w.ok || 0) + 1;
      if (!item.retry) {
        if (sess.missed[item.id] || w.box === 0) { w.box = 1; w.due = addDays(1); }
        else if (g === 'hard') { w.box = Math.max(1, w.box - 1); w.due = addDays(Math.max(1, INTERVAL[w.box])); }
        else { w.box = Math.min(MAX_BOX, w.box + 1); w.due = addDays(INTERVAL[w.box]); }
      }
    }
    save('words/' + item.id, 'profile/main');
  }

  // --- reading
  function tokenize(text, vocab) {
    // wrap every word in a tappable span; vocabulary forms get the highlighter
    const forms = new Map();
    vocab.forEach((v, i) => [v.w, ...(v.f || [])].forEach(f => forms.set(f.toLowerCase(), i)));
    return String(text).split(/([A-Za-z][A-Za-z'’-]*)/).map((m, i) => {
      if (i % 2 === 0) return esc(m);
      const k = m.toLowerCase().replace(/[’']s$/, '');
      const vi = forms.has(m.toLowerCase()) ? forms.get(m.toLowerCase()) : forms.get(k);
      return `<span class="tk${vi != null ? ' v' : ''}" data-t="${esc(m)}"${vi != null ? ` data-v="${vi}"` : ''}>${esc(m)}</span>`;
    }).join('');
  }
  function articleHTML(a, opts) {
    return `<article class="article">
      <div class="meta"><span class="chip on">${esc(a.topic || 'Reading')}</span>
        <span class="chip">${a.source === 'ai' ? 'Claude 今日撰写' : '精选文章'}</span>
        <span class="chip">${a.paragraphs.map(p => p.en).join(' ').split(/\s+/).length} words</span></div>
      <h2>${esc(a.title)}</h2>
      <div class="hint">点任意单词查释义 · <span style="background:linear-gradient(transparent 52%,var(--mark) 52%);font-weight:700">荧光笔</span>标出的是今天的重点词</div>
      ${a.paragraphs.map((p, i) => `<div class="para"><p data-p="${i}">${tokenize(p.en, a.vocab)}</p>
        <div class="zh" hidden>${esc(p.zh)}</div>
        <div class="ptools"><button class="ptool" data-say="${i}">▶ 朗读</button>${p.zh ? `<button class="ptool" data-zh="${i}">中文</button>` : ''}</div></div>`).join('')}
      ${opts && opts.allZh ? '' : ''}
    </article>`;
  }
  function bindArticle(root, a) {
    root.querySelectorAll('[data-say]').forEach(b => b.onclick = () => sayLong(a.paragraphs[+b.dataset.say].en));
    root.querySelectorAll('[data-zh]').forEach(b => b.onclick = () => {
      const z = b.closest('.para').querySelector('.zh'); z.hidden = !z.hidden; b.textContent = z.hidden ? '中文' : '收起中文';
    });
    root.querySelectorAll('.tk').forEach(t => t.onclick = () => {
      root.querySelectorAll('.tk.sel').forEach(x => x.classList.remove('sel')); t.classList.add('sel');
      const sentence = (t.closest('p').textContent.match(/[^.!?]*[.!?]?/g) || []).find(s => s.includes(t.dataset.t)) || '';
      if (t.dataset.v != null) showWord(a.vocab[+t.dataset.v], { src: a.title });
      else lookup(t.dataset.t, sentence.trim(), a.title);
    });
  }
  function readStep() {
    const stage = document.getElementById('stage');
    const art = todaysArticle();
    if (!art) {
      stage.innerHTML = `<div class="card loading"><div class="spin"></div><b>正在准备今天的文章…</b>
        <span class="muted small">如果是第一次使用，claude.ai 会先问你是否允许页面调用 Claude 写文章。<br>不允许也没关系，会改用内置的精选文章。</span></div>`;
      ensureArticle().then(a => { if (view === 'session' && sess.phase === 'read') { if (a) readStep(); else stage.innerHTML = '<div class="card empty">文章没有准备好，请稍后再试。</div>'; } });
      return;
    }
    stage.innerHTML = articleHTML(art) + `<button class="btn block" id="done">读完了，去做题 →</button>`;
    bindArticle(stage, art);
    stage.querySelector('#done').onclick = () => {
      art.read = true; art.times = (art.times || 0) + 1; save('articles/' + art.id);
      closeSheet(); stopSpeech(); sess.phase = 'quiz'; window.scrollTo(0, 0); nextPhase();
    };
  }

  // --- quiz
  function quizStep() {
    const art = todaysArticle(); if (!art) { sess.phase = 'read'; return nextPhase(); }
    const stage = document.getElementById('stage');
    let qi = 0, score = 0;
    const show = () => {
      if (qi >= art.questions.length) {
        day().quiz = score; art.score = score; save('profile/main', 'articles/' + art.id);
        sess.phase = 'words'; return nextPhase();
      }
      const q = art.questions[qi], order = shuffle(q.o.map((t, i) => i));
      stage.innerHTML = `<div class="label" style="text-align:center">第 ${qi + 1} / ${art.questions.length} 题</div>
        <div class="prompt" style="text-align:left;font-family:var(--read);font-weight:600;font-size:19px">${esc(q.q)}</div>
        <div class="opts">${order.map(i => `<button class="opt" data-i="${i}">${esc(q.o[i])}</button>`).join('')}</div>
        <div class="fb" id="fb"></div><div id="why"></div>
        <button class="btn ghost block" id="peek">回看文章</button>`;
      stage.querySelector('#peek').onclick = () => peekArticle(art);
      stage.querySelectorAll('.opt').forEach(b => b.onclick = () => {
        const ok = +b.dataset.i === q.a; if (ok) score++;
        stage.querySelectorAll('.opt').forEach(o => { o.disabled = true; if (+o.dataset.i === q.a) o.classList.add('right'); });
        if (!ok) b.classList.add('wrong');
        const fb = stage.querySelector('#fb'); fb.className = 'fb ' + (ok ? 'ok' : 'no'); fb.textContent = ok ? 'Correct ✓' : 'Not quite';
        stage.querySelector('#why').innerHTML = `${q.why ? `<div class="vcard"><div class="small">${esc(q.why)}</div></div>` : ''}<button class="btn block" style="margin-top:10px" id="nq">${qi + 1 < art.questions.length ? '下一题' : '看今天的新词'}</button>`;
        stage.querySelector('#peek').remove();
        stage.querySelector('#nq').onclick = () => { qi++; window.scrollTo(0, 0); show(); };
      });
    };
    show();
  }
  function peekArticle(a) {
    const m = document.createElement('div'); m.className = 'modal'; m.style.placeItems = 'start center'; m.style.overflow = 'auto';
    m.innerHTML = `<div style="width:100%;max-width:640px">${articleHTML(a)}<button class="btn block" style="margin-top:12px" id="cl">回到题目</button></div>`;
    document.body.appendChild(m); bindArticle(m, a);
    m.querySelector('#cl').onclick = () => { closeSheet(); stopSpeech(); m.remove(); };
  }

  // --- new words
  function wordsStep() {
    const art = todaysArticle(), stage = document.getElementById('stage');
    const fresh = art.vocab.filter(v => !S.words[wid(v.w)]);
    if (!fresh.length) { sess.phase = 'done'; return nextPhase(); }
    const state = fresh.map(() => 'add');
    const render = () => {
      stage.innerHTML = `<div class="prompt">今天的新词</div><div class="hint" style="text-align:center">默认全部加入生词本，已经认识的点「我认识」，以后会少出现。</div>
        ${fresh.map((v, i) => `<div class="vcard ${state[i] === 'known' ? 'known' : ''}"><div class="hd"><span class="w">${esc(v.w)}</span><span class="muted small">${esc(v.ipa)}</span>
          <button class="spk" data-s="${i}" aria-label="发音">🔊</button></div>
          <div><span class="muted">${esc(v.pos)}</span> <b>${esc(v.zh)}</b></div>${v.ex ? `<div class="ex">${esc(v.ex)}</div>` : ''}
          <div class="act"><button class="chip ${state[i] === 'add' ? 'on' : ''}" data-a="${i}">${state[i] === 'add' ? '✓ 加入生词本' : '加入生词本'}</button>
          <button class="chip ${state[i] === 'known' ? 'on' : ''}" data-k="${i}">我认识</button></div></div>`).join('')}
        <button class="btn block" id="fin">完成今天</button>`;
      stage.querySelectorAll('[data-s]').forEach(b => b.onclick = () => sayWord(fresh[+b.dataset.s].w));
      stage.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { state[+b.dataset.a] = 'add'; render(); });
      stage.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { state[+b.dataset.k] = 'known'; render(); });
      stage.querySelector('#fin').onclick = () => {
        fresh.forEach((v, i) => addWord(v, { known: state[i] === 'known', src: art.title }));
        sess.newWords = state.filter(x => x === 'add').length;
        const d = day(); d.newWords = (d.newWords || 0) + sess.newWords; save('profile/main');
        sess.phase = 'done'; nextPhase();
      };
    };
    render();
  }

  function finishSession() {
    const d = day(); const first = !d.done; d.done = true; save('profile/main');
    inSession = false;
    const art = todaysArticle();
    $app.innerHTML = `<div class="card sum"><div class="big">${first ? '🎉' : '👍'}</div>
      <h2>今天完成了</h2>
      <div class="chips" style="justify-content:center">
        <span class="chip on">阅读 ${Math.floor((d.sec || 0) / 60)} 分钟</span>
        ${d.reviewed ? `<span class="chip">复习 ${d.reviewed} 次</span>` : ''}
        ${d.quiz != null ? `<span class="chip">理解题 ${d.quiz}/3</span>` : ''}
        <span class="chip">新词 +${d.newWords || 0}</span>
        <span class="chip">连续 ${streak()} 天</span></div>
      ${art ? `<p class="muted small" style="margin:0">今天读的是《${esc(art.title)}》，随时可以在「往期文章」里重读。</p>` : ''}
      <p class="muted small" style="margin:0">生词本里共 ${learning().length} 个词，${dueWords().length ? '还有 ' + dueWords().length + ' 个今天到期。' : '明天见。'}</p>
      <button class="btn block" id="ok">回到首页</button></div>`;
    document.getElementById('ok').onclick = () => go('home');
  }

  // ---------- word sheet & lookup ----------
  function closeSheet() { const s = document.querySelector('.sheet'); if (s) s.remove(); document.querySelectorAll('.tk.sel').forEach(x => x.classList.remove('sel')); }
  function showWord(v, opts) {
    closeSheet();
    const s = document.createElement('div'); s.className = 'sheet';
    const inBook = S.words[wid(v.w)];
    s.innerHTML = `<div class="card"><button class="x" aria-label="关闭">✕</button>
      <div class="hd" style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span style="font:600 24px var(--read)">${esc(v.w)}</span>
        <span class="muted small">${esc(v.ipa)}</span><button class="spk" id="sp" aria-label="发音">🔊</button></div>
      <div><span class="muted">${esc(v.pos)}</span> <b>${esc(v.zh)}</b></div>
      ${v.ex ? `<div style="font:italic 15px var(--read)" class="muted">${esc(v.ex)}</div>` : ''}
      ${opts && opts.loading ? '<div class="muted small">Claude 正在查…</div>' : ''}
      ${opts && opts.loading ? '' : `<button class="btn ${inBook ? 'ghost' : ''} block" id="add" ${inBook ? 'disabled' : ''}>${inBook ? '已在生词本' : '加入生词本'}</button>`}</div>`;
    document.body.appendChild(s);
    s.querySelector('.x').onclick = closeSheet;
    s.querySelector('#sp').onclick = () => sayWord(v.w);
    sayWord(v.w);
    const add = s.querySelector('#add');
    if (add && !inBook) add.onclick = () => { addWord(v, { src: opts && opts.src }); toast('已加入生词本'); closeSheet(); if (view === 'words') wordbook(); };
  }
  const lookCache = {};
  async function lookup(word, sentence, src) {
    const key = word.toLowerCase();
    const known = Object.values(S.words).find(w => w.w.toLowerCase() === key || (w.f || []).some(f => f.toLowerCase() === key));
    if (known) return showWord(known, { src });
    if (lookCache[key + '|' + sentence]) return showWord(lookCache[key + '|' + sentence], { src });
    const sample = await use('sample');
    if (!sample) { showWord({ w: word, ipa: '', pos: '', zh: '（离线模式下只能查荧光笔标出的词）', ex: '' }, { loading: true }); sayWord(word); return; }
    showWord({ w: word, ipa: '', pos: '', zh: '', ex: '' }, { loading: true });
    try {
      const r = await sample.json(`A Chinese learner of English tapped the word "${word}" in this sentence: "${sentence}".
Return ONLY JSON: {"w": dictionary base form, "f": [the form "${word}" if different from w], "ipa": British IPA in slashes, "pos": part of speech like "n." "v." "adj.", "zh": concise Chinese meaning as used in this sentence (max 12 Chinese characters), "ex": a short new example sentence}.`, { modelTier: 'quick' });
      if (!r || !r.w) throw 0;
      const v = { w: String(r.w).slice(0, 60), f: Array.isArray(r.f) ? r.f.slice(0, 4).map(String) : [], ipa: String(r.ipa || '').slice(0, 60), pos: String(r.pos || '').slice(0, 20), zh: String(r.zh || '').slice(0, 60), ex: String(r.ex || '').slice(0, 300) };
      lookCache[key + '|' + sentence] = v;
      if (document.querySelector('.sheet')) showWord(v, { src });
    } catch (e) {
      if (document.querySelector('.sheet')) showWord({ w: word, ipa: '', pos: '', zh: e && e.code === 'not_granted' ? '（未允许调用 Claude，只能查荧光笔标出的词）' : '暂时查不到，请稍后再试', ex: '' }, { loading: true });
    }
  }

  // ---------- WORD BOOK ----------
  let wbTab = 'all', wbQ = '';
  function wordbook() {
    const all = wordList();
    const lists = {
      all: all.filter(w => !w.known).sort((a, b) => (b.added || '').localeCompare(a.added || '')),
      due: dueWords(),
      hard: all.filter(w => (w.bad || 0) > 0 && !w.known).sort((a, b) => (b.bad || 0) - (a.bad || 0)),
      done: all.filter(w => w.box >= MASTER || w.known)
    };
    const q = wbQ.trim().toLowerCase();
    const rows = lists[wbTab].filter(w => !q || w.w.toLowerCase().includes(q) || (w.zh || '').includes(q));
    const level = w => { const n = w.known ? 5 : Math.min(5, Math.ceil(w.box * 5 / MASTER)); return '<span class="dots">' + [0, 1, 2, 3, 4].map(i => `<i class="${i < n ? 'f' : ''}"></i>`).join('') + '</span>'; };
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>生词本</h1></div>
      <input class="search" id="q" placeholder="搜索单词或中文" value="${esc(wbQ)}">
      <div class="tabs">${[['all', '在学 ' + lists.all.length], ['due', '今天到期 ' + lists.due.length], ['hard', '易错 ' + lists.hard.length], ['done', '已掌握 ' + lists.done.length]]
        .map(([k, l]) => `<button data-t="${k}" class="${wbTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="list">${rows.length ? rows.map(w => `<button class="li" data-w="${esc(wid(w.w))}"><div class="m"><div class="w">${esc(w.w)}</div>
        <div class="muted small">${esc(w.pos)} ${esc(w.zh)}</div></div>${level(w)}</button>`).join('')
        : `<div class="empty">${all.length ? '这里还没有单词' : '读完第一篇文章后，新词会出现在这里'}</div>`}</div>`;
    document.getElementById('back').onclick = () => go('home');
    const qi = document.getElementById('q');
    qi.oninput = () => { wbQ = qi.value; const pos = qi.selectionStart; wordbook(); const n = document.getElementById('q'); n.focus(); n.setSelectionRange(pos, pos); };
    $app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { wbTab = b.dataset.t; wordbook(); });
    $app.querySelectorAll('[data-w]').forEach(b => b.onclick = () => wordDetail(b.dataset.w));
  }
  function wordDetail(id) {
    const w = S.words[id]; if (!w) return;
    closeSheet();
    const s = document.createElement('div'); s.className = 'sheet';
    s.innerHTML = `<div class="card"><button class="x" aria-label="关闭">✕</button>
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span style="font:600 24px var(--read)">${esc(w.w)}</span><span class="muted small">${esc(w.ipa)}</span><button class="spk" id="sp">🔊</button></div>
      <div><span class="muted">${esc(w.pos)}</span> <b>${esc(w.zh)}</b></div>
      ${w.ex ? `<div style="font:italic 15px var(--read)" class="muted">${esc(w.ex)}</div>` : ''}
      <div class="muted tiny">来自《${esc(w.src || '—')}》 · 加入于 ${esc(w.added)} · 答对 ${w.ok || 0} 次 / 答错 ${w.bad || 0} 次 · ${w.known ? '已标为认识' : '下次复习 ' + (w.due <= today() ? '今天' : esc(w.due))}</div>
      <div class="row"><button class="btn ghost" id="del">删除</button>${w.known ? '<button class="btn" id="relearn">重新学习</button>' : '<button class="btn" id="kn">我认识了</button>'}</div></div>`;
    document.body.appendChild(s);
    s.querySelector('.x').onclick = closeSheet;
    s.querySelector('#sp').onclick = () => sayWord(w.w);
    s.querySelector('#del').onclick = () => ask(`从生词本删除 “${w.w}”？`, '删除').then(ok => { if (!ok) return; delete S.words[id]; save('words/' + id); closeSheet(); wordbook(); });
    const kn = s.querySelector('#kn'); if (kn) kn.onclick = () => { w.known = true; w.box = Math.max(w.box, 5); w.due = addDays(INTERVAL[5]); save('words/' + id); closeSheet(); wordbook(); };
    const rl = s.querySelector('#relearn'); if (rl) rl.onclick = () => { w.known = false; w.box = 1; w.due = today(); save('words/' + id); closeSheet(); wordbook(); };
  }

  // ---------- PAST ARTICLES ----------
  function pastArticles() {
    const list = Object.values(S.articles).filter(a => a && a.title).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>往期文章</h1></div>
      <div class="list">${list.length ? list.map(a => `<button class="li" data-a="${esc(a.id)}"><div class="m"><div class="w">${esc(a.title)}</div>
        <div class="muted small">${esc(a.date || '')} · ${esc(a.topic || '')}${a.score != null ? ' · 理解题 ' + a.score + '/3' : ''}${a.read ? '' : ' · 未读完'}</div></div><span class="muted">›</span></button>`).join('')
        : '<div class="empty">还没有读过文章</div>'}</div>`;
    document.getElementById('back').onclick = () => go('home');
    $app.querySelectorAll('[data-a]').forEach(b => b.onclick = () => go('reread', b.dataset.a));
  }
  function reread(id) {
    const a = S.articles[id]; if (!a) return go('history');
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>重读</h1></div>${articleHTML(a)}
      <div class="card" style="margin-top:14px;display:flex;flex-direction:column;gap:10px"><div class="label">本文重点词</div>
        ${a.vocab.map(v => `<div><b style="font-family:var(--read)">${esc(v.w)}</b> <span class="muted small">${esc(v.pos)}</span> ${esc(v.zh)}</div>`).join('')}</div>`;
    document.getElementById('back').onclick = () => go(a.id === (S.days[today()] || {}).article ? 'home' : 'history');
    bindArticle($app, a);
  }

  // ---------- STATS ----------
  const fmtMin = sec => { sec = sec || 0; if (!sec) return '—'; const m = Math.floor(sec / 60), r = sec % 60; return m ? (r >= 30 ? m + 1 : m) + ' 分钟' : r + ' 秒'; };
  function stats() {
    const N = 14, rows = [];
    for (let i = N - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = dayStr(d); rows.push({ d, ds, h: S.days[ds] || {} }); }
    const last7 = rows.slice(-7), sum7 = last7.reduce((a, r) => a + (r.h.sec || 0), 0);
    const W = Math.round(Math.min(640, Math.max(300, Math.min(window.innerWidth, 700) - 70))), H = 190, L = 30, R = 8, T = 10, B = 26, pw = W - L - R, ph = H - T - B, bw = pw / N;
    const maxM = Math.max(15, Math.ceil(Math.max(...rows.map(r => (r.h.sec || 0) / 60)) / 5) * 5);
    const y = m => T + ph - m / maxM * ph;
    const ticks = []; for (let m = 0; m <= maxM; m += 5) ticks.push(m);
    const svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="最近 ${N} 天每天阅读分钟数">
      ${ticks.map(m => `<line x1="${L}" x2="${W - R}" y1="${y(m)}" y2="${y(m)}" class="gl"/><text x="${L - 6}" y="${y(m) + 4}" class="ax" text-anchor="end">${m}</text>`).join('')}
      ${rows.map((r, i) => {
        const m = (r.h.sec || 0) / 60, x = L + i * bw + bw * .2, w = bw * .6, top = y(m), hh = T + ph - top, rr = Math.min(4, w / 2, hh);
        const path = hh > 0 ? `M${x},${T + ph} V${top + rr} Q${x},${top} ${x + rr},${top} H${x + w - rr} Q${x + w},${top} ${x + w},${top + rr} V${T + ph} Z` : '';
        const tip = `${r.d.getMonth() + 1}月${r.d.getDate()}日：${fmtMin(r.h.sec)}${r.h.quiz != null ? '，理解题 ' + r.h.quiz + '/3' : ''}`;
        return `<g class="bar" data-tip="${esc(tip)}"><rect x="${L + i * bw}" y="${T}" width="${bw}" height="${ph}" fill="transparent"/>${path ? `<path d="${path}" class="${(r.h.sec || 0) >= GOAL_SEC ? 'b-hit' : 'b'}"/>` : ''}
          <text x="${L + i * bw + bw / 2}" y="${H - 8}" class="ax" text-anchor="middle">${i === N - 1 ? '今' : r.d.getDate()}</text></g>`;
      }).join('')}
      <line x1="${L}" x2="${W - R}" y1="${y(10)}" y2="${y(10)}" class="target"/><text x="${W - R}" y="${y(10) - 6}" class="ax tl" text-anchor="end">目标 10 分钟</text></svg>`;
    const wk = ['日', '一', '二', '三', '四', '五', '六'];
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>学习记录</h1></div>
      <div class="nums">
        <div class="num"><b>${Math.round(sum7 / 60)}</b><span>近 7 天分钟</span></div>
        <div class="num"><b>${last7.filter(r => r.h.done).length}/7</b><span>完成天数</span></div>
        <div class="num"><b>${Object.values(S.articles).filter(a => a.read).length}</b><span>累计读完</span></div>
      </div>
      <div class="card"><h3 style="font-size:16px">每天阅读时间（分钟）· 最近 ${N} 天</h3>
        <div class="chart-wrap" id="cw">${svg}<div class="tip" id="tip" hidden></div></div>
        <p class="muted small" style="margin:6px 0 0">深色柱子表示当天读满 10 分钟。页面在后台或超过 2.5 分钟没有任何操作时不计时。</p></div>
      <div class="card" style="margin-top:14px;padding:10px 0"><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>日期</th><th>时长</th><th>复习</th><th>正确率</th><th>理解题</th><th>新词</th><th>打开时间</th></tr></thead>
        <tbody>${rows.slice().reverse().map(r => { const h = r.h, t = (h.right || 0) + (h.wrong || 0);
          return `<tr class="${h.sec ? '' : 'none'}"><td>${r.d.getMonth() + 1}/${r.d.getDate()} 周${wk[r.d.getDay()]}</td><td>${fmtMin(h.sec)}${(h.sec || 0) >= GOAL_SEC ? ' ✓' : ''}</td>
            <td>${h.reviewed || 0}</td><td>${t ? Math.round((h.right || 0) / t * 100) + '%' : '—'}</td><td>${h.quiz != null ? h.quiz + '/3' : '—'}</td><td>${h.newWords || 0}</td>
            <td>${h.firstAt ? esc(h.firstAt) + (h.lastAt && h.lastAt !== h.firstAt ? '–' + esc(h.lastAt) : '') : '—'}</td></tr>`; }).join('')}</tbody></table></div></div>`;
    document.getElementById('back').onclick = () => go('home');
    const cw = document.getElementById('cw'), tip = document.getElementById('tip');
    cw.querySelectorAll('.bar').forEach(g => { const show = () => { tip.textContent = g.dataset.tip; tip.hidden = false;
      const br = g.getBoundingClientRect(), cr = cw.getBoundingClientRect();
      tip.style.left = Math.min(Math.max(br.left - cr.left + br.width / 2 - tip.offsetWidth / 2, 0), cr.width - tip.offsetWidth) + 'px'; };
      g.addEventListener('pointerenter', show); g.addEventListener('click', show); });
    cw.addEventListener('pointerleave', () => { tip.hidden = true; });
  }

  // ---------- SETTINGS ----------
  function settings() {
    const p = S.profile;
    $app.innerHTML = `<div class="top"><button class="icon-btn" id="back" aria-label="返回">←</button><h1>设置</h1></div>
      <div class="card" style="display:flex;flex-direction:column;gap:16px">
        <label class="field">你的名字（首页问候用，可不填）<input id="nm" value="${esc(p.name)}" maxlength="20"></label>
        <label class="field">学习目标<select id="goal">${Object.entries(GOALS).map(([k, v]) => `<option value="${k}" ${p.goal === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <div class="field">感兴趣的话题（每天从中随机选一个）<div class="chips" id="tp">${TOPICS.map(t => `<button class="chip ${p.topics.includes(t) ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div></div>
        <label class="field">文章长度<select id="len">${[[180, '短 · 约 180 词'], [260, '中 · 约 260 词'], [350, '长 · 约 350 词']].map(([n, l]) => `<option value="${n}" ${p.length === n ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="ai" ${p.ai ? 'checked' : ''} style="width:20px;height:20px">每天让 Claude 写一篇新文章</label>
        <p class="muted small" style="margin:0">在 claude.ai 登录打开时，每天的新文章由 Claude 按你的目标和兴趣撰写，并避开生词本里已有的词；第一次会请你允许。没有登录或不允许时，使用内置的 ${BANK.length || 10} 篇精选文章。</p>
      </div>
      <div class="card" style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
        <h3 style="font-size:16px">备份</h3>
        <p class="muted small" style="margin:0">登录 claude.ai 时进度会自动同步到各个设备。也可以下载一份备份文件，在别的设备导入。</p>
        <div class="row"><button class="btn ghost" id="exp">下载备份</button><button class="btn ghost" id="imp">导入备份</button></div>
        <input type="file" id="file" accept="application/json,.json" hidden>
      </div>`;
    document.getElementById('back').onclick = () => go('home');
    document.getElementById('nm').oninput = e => { p.name = e.target.value.trim(); save('profile/main'); };
    document.getElementById('goal').onchange = e => { p.goal = e.target.value; save('profile/main'); };
    document.getElementById('len').onchange = e => { p.length = +e.target.value; save('profile/main'); };
    document.getElementById('ai').onchange = e => { p.ai = e.target.checked; save('profile/main'); };
    $app.querySelectorAll('#tp [data-t]').forEach(b => b.onclick = () => {
      const t = b.dataset.t, i = p.topics.indexOf(t);
      if (i >= 0) { if (p.topics.length > 1) p.topics.splice(i, 1); } else p.topics.push(t);
      save('profile/main'); b.classList.toggle('on', p.topics.includes(t));
    });
    document.getElementById('exp').onclick = async () => {
      const json = JSON.stringify(S), name = `english-backup-${today()}.json`;
      const dl = await use('downloads');
      if (dl) { try { await dl.save({ filename: name, data: json }); toast('备份已保存'); } catch (e) { if (!e || e.code !== 'declined') toast('这里没法下载文件，请换浏览器打开'); } return; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    };
    const file = document.getElementById('file');
    document.getElementById('imp').onclick = () => file.click();
    file.onchange = () => {
      const f = file.files[0]; if (!f) return;
      f.text().then(t => {
        const d = JSON.parse(t); if (!d || !d.profile || !d.words || !d.days) throw 0;
        return ask('导入后会覆盖现在的进度，确定吗？', '导入').then(ok => {
          if (!ok) return;
          const oldW = Object.keys(S.words), oldA = Object.keys(S.articles);
          S = { profile: d.profile, days: d.days, words: d.words, articles: d.articles || {} };
          oldW.filter(id => !S.words[id]).forEach(id => dirty.add('words/' + id));
          oldA.filter(id => !S.articles[id]).forEach(id => dirty.add('articles/' + id));
          save('profile/main', ...Object.keys(S.words).map(id => 'words/' + id), ...Object.keys(S.articles).map(id => 'articles/' + id));
          toast('导入成功'); settings();
        });
      }).catch(() => toast('文件格式不对')).finally(() => { file.value = ''; });
    };
  }

  bankReady.then(() => { if (view === 'home') home(); });
  go('home');
})();
