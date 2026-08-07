/* Your Journal — static web app.
 *
 * Runs entirely in the browser. PubMed E-utilities is called directly (NCBI sends
 * Access-Control-Allow-Origin: *), so there is no backend and no shared rate-limit
 * pool — each reader spends their own 3 req/s against their own IP.
 *
 * Storage is localStorage, namespaced per profile. Optional: a reader can paste
 * their own Anthropic API key to enable the semantic re-rank pass; the key is kept
 * in their browser and sent only to api.anthropic.com.
 */
'use strict';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const STORE = 'yj:';
const MODEL = 'claude-opus-5';

const VERDICT_W = { love: 2, like: 1, dislike: -1 };
const STOP = new Set(('a an the and or but if of in on at to for with without from by as is are was were be been being ' +
  'this that these those it its their there here we our you your they them he she his her not no than then so such can ' +
  'could may might will would shall should do does did done have has had using use used study studies research results ' +
  'result methods method conclusion conclusions background objective objectives purpose aim aims findings show shows ' +
  'shown showed suggest suggests associated association between among within across during after before significant ' +
  'significantly higher lower increase increased decrease decreased effect effects however also more most less least ' +
  'both each other others all any some new novel first second via versus vs based upon into over under about which who ' +
  'whom whose what when where why how one two three four five patients patient group groups subjects participants data ' +
  'analysis analyses evidence review overview report reports case cases').split(' '));

let DATA = { taxonomy: null, axes: null, journals: null };
let USER = null;

/* ------------------------------------------------------------------ storage */

const lsGet = (k, d) => { try { const v = localStorage.getItem(STORE + k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(STORE + k, JSON.stringify(v)); } catch (e) { toast('Storage full — export your profile.'); } };

function listProfiles() { return lsGet('profiles', []); }

function newProfile(name) {
  const id = (name || 'reader').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reader';
  const profiles = listProfiles();
  const uid = profiles.some(p => p.id === id) ? id + '-' + Math.random().toString(36).slice(2, 6) : id;
  const u = {
    id: uid, name: name || 'Reader', created: new Date().toISOString(),
    step: 'specialties', specialties: [], subtopics: [], axisScores: {},
    journals: [], feedback: {}, library: {}, weights: {}, seen: [], run: null,
  };
  profiles.push({ id: uid, name: u.name });
  lsSet('profiles', profiles);
  lsSet('u:' + uid, u);
  lsSet('active', uid);
  return u;
}

function loadProfile(id) { return lsGet('u:' + id, null); }
function saveUser() { lsSet('u:' + USER.id, USER); }

const DAY = 864e5;
const EXPORT_EVERY = 7 * DAY;   // remind once a week
const SNOOZE_FOR = 3 * DAY;     // "not now" buys three days, not silence

function exportProfile() {
  USER.lastExport = new Date().toISOString();
  delete USER.exportSnooze;
  const blob = new Blob([JSON.stringify(USER, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `yourjournal-${USER.id}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  saveUser();
}

/* Nag to export, but only when there is something to lose and only once a week.
   A reader who has rated nothing has no state worth backing up, so stay quiet. */
function exportBannerHTML() {
  if (!USER || USER.step !== 'ready') return '';
  const worthLosing = Object.keys(USER.feedback).length + Object.keys(USER.library).length;
  if (worthLosing < 3) return '';

  const now = Date.now();
  if (USER.exportSnooze && now < Date.parse(USER.exportSnooze)) return '';
  const since = Date.parse(USER.lastExport || USER.created || 0);
  if (Number.isFinite(since) && now - since < EXPORT_EVERY) return '';

  const days = Math.floor((now - since) / DAY);
  const never = !USER.lastExport;
  const when = never
    ? `You have never exported this profile`
    : `Last export was ${days} day${days === 1 ? '' : 's'} ago`;
  return `<div class="banner"><div>
    <b>${when}.</b> Your ${worthLosing} ratings and saves live only in this browser —
    clearing site data or switching devices loses them.
    </div><div class="acts-row">
    <button class="btn" data-act="export">Export now</button>
    <button class="btn ghost" data-act="snooze">Not now</button>
    </div></div>`;
}

async function importProfile(file) {
  const u = JSON.parse(await file.text());
  if (!u.id || !Array.isArray(u.subtopics)) throw new Error('Not a Your Journal profile');
  const profiles = listProfiles().filter(p => p.id !== u.id);
  profiles.push({ id: u.id, name: u.name });
  lsSet('profiles', profiles);
  lsSet('u:' + u.id, u);
  lsSet('active', u.id);
  return u;
}

/* ------------------------------------------------------------------ scoring */

function tokenize(text) {
  const out = [];
  for (const raw of text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ').split(/\s+/)) {
    const w = raw.replace(/^-+|-+$/g, '');
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

function termsOf(text) {
  const t = tokenize(text);
  const out = t.slice();
  for (let i = 0; i + 1 < t.length; i++) out.push(t[i] + ' ' + t[i + 1]);
  return out;
}

const subtopicIndex = () => {
  const m = new Map();
  for (const s of DATA.taxonomy.specialties) for (const st of s.subtopics) m.set(s.id + ':' + st.id, [s, st]);
  return m;
};

function userTerms(u) {
  const idx = subtopicIndex(), counts = new Map();
  for (const key of u.subtopics) {
    const pair = idx.get(key);
    if (!pair) continue;
    for (const t of pair[1].terms) counts.set(t.toLowerCase(), (counts.get(t.toLowerCase()) || 0) + 1);
  }
  const out = new Map();
  for (const [t, c] of counts) out.set(t, Math.min(1, 0.62 + 0.16 * (c - 1)));
  return out;
}

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasPhrase = (hay, p) => new RegExp('(?<![a-z0-9])' + escRe(p) + '(?![a-z0-9])').test(hay);

function axisSignal(hay, ax) {
  let lo = 0, hi = 0;
  for (const s of ax.low_signals) if (hay.includes(s)) lo++;
  for (const s of ax.high_signals) if (hay.includes(s)) hi++;
  return lo + hi === 0 ? 0 : (hi - lo) / (lo + hi);
}

function scoreArticle(a, u, terms, priors) {
  const text = [a.title, a.abstract, (a.keywords || []).join(' '), (a.mesh || []).join(' '),
    (a.pubtypes || []).join(' ')].join(' ');
  const hay = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';

  const hits = [];
  for (const [t, w] of terms) if (hasPhrase(hay, t)) hits.push([t, w]);
  hits.sort((x, y) => y[1] - x[1]);
  const topic = hits.length ? Math.min(1, hits.slice(0, 6).reduce((s, h) => s + h[1], 0) / 2.6) : 0;

  let axTotal = 0, axN = 0;
  const axDetail = {};
  for (const ax of DATA.axes.axes) {
    const pref = u.axisScores[ax.id];
    if (pref === undefined) continue;
    const sig = axisSignal(hay, ax);
    if (sig === 0) continue;
    const c = pref * sig;
    axDetail[ax.id] = Math.round(c * 100) / 100;
    axTotal += c; axN++;
  }
  const axis = axN ? axTotal / axN : 0;

  const jp = priors[(a.journal || '').toLowerCase()] ?? 0.6;

  let learnedRaw = 0;
  const seen = new Set(termsOf(text));
  for (const t of seen) learnedRaw += u.weights[t] || 0;
  const learned = Math.tanh(learnedRaw / 4);

  let base = 0.52 * topic + 0.14 * jp
    + 0.18 * Math.max(0, axis) + 0.10 * Math.min(0, axis)
    + 0.16 * Math.max(0, learned) + 0.16 * Math.min(0, learned);

  const pt = (a.pubtypes || []).join(' ').toLowerCase();
  if (/editorial|comment|news/.test(pt)) base *= 0.55;
  if (/retracted|erratum/.test(pt)) base *= 0.15;
  if (!a.abstract) base *= 0.78;

  return {
    score: Math.round(Math.max(0, Math.min(1, base)) * 100),
    why: { topic: +topic.toFixed(3), axis: +axis.toFixed(3), journal: jp, learned: +learned.toFixed(3),
           matched: hits.slice(0, 8).map(h => h[0]), axisDetail: axDetail },
  };
}

function relearn(u) {
  const pos = new Map(), neg = new Map();
  let npos = 0, nneg = 0, n = 0;
  for (const r of Object.values(u.feedback)) {
    const w = VERDICT_W[r.verdict];
    if (!w) continue;
    n++;
    const ts = new Set(termsOf(r.text || r.title || ''));
    if (w > 0) { npos += w; for (const t of ts) pos.set(t, (pos.get(t) || 0) + w); }
    else { nneg += -w; for (const t of ts) neg.set(t, (neg.get(t) || 0) + -w); }
  }
  const weights = {};
  for (const t of new Set([...pos.keys(), ...neg.keys()])) {
    const p = pos.get(t) || 0, q = neg.get(t) || 0, mass = p + q;
    if (mass < 1.5 && n > 8) continue;
    let v = Math.log(((p + 0.5) / (npos + 1)) / ((q + 0.5) / (nneg + 1)));
    v *= mass / (mass + 3);
    if (Math.abs(v) > 0.05) weights[t] = +v.toFixed(4);
  }
  u.weights = weights;
}

/* ---------------------------------------------------------- journal picking */

function suggestJournals(u) {
  const idx = subtopicIndex(), score = new Map(), why = new Map();
  const depth = {};
  for (const k of u.subtopics) { const s = k.split(':')[0]; depth[s] = (depth[s] || 0) + 1; }

  const bump = (j, amt, label) => {
    score.set(j, (score.get(j) || 0) + amt);
    const list = why.get(j) || []; if (!list.includes(label)) list.push(label);
    why.set(j, list);
  };
  for (const sid of u.specialties) {
    const s = DATA.taxonomy.specialties.find(x => x.id === sid);
    if (!s) continue;
    const w = 1 + 0.35 * (depth[sid] || 0);
    for (const j of s.journals || []) bump(j, w, s.name);
  }
  for (const key of u.subtopics) {
    const pair = idx.get(key);
    if (!pair) continue;
    for (const j of pair[1].journals || []) bump(j, 1.6, pair[1].name);
  }
  if (!score.size) return [];
  const cutoff = Math.max(...score.values()) * 0.55;
  const out = [];
  for (const [abbrev, sc] of score) {
    const meta = DATA.journals.journals[abbrev];
    if (!meta) continue;
    out.push({ abbrev, name: meta.name, score: sc, volume: meta.count,
               why: (why.get(abbrev) || []).join(', ').slice(0, 120), core: sc >= cutoff });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, 48);
}

/* ------------------------------------------------------------------- pubmed */

async function eutils(path, params) {
  const url = EUTILS + path + '?' + new URLSearchParams(params);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`PubMed ${r.status}`);
  return r;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArticles(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const out = [];
  for (const pa of doc.querySelectorAll('PubmedArticle')) {
    const txt = sel => { const n = pa.querySelector(sel); return n ? n.textContent.trim() : ''; };
    const parts = [];
    for (const ab of pa.querySelectorAll('Abstract > AbstractText')) {
      const label = ab.getAttribute('Label');
      parts.push(label ? `${label}: ${ab.textContent.trim()}` : ab.textContent.trim());
    }
    const authors = [];
    for (const a of pa.querySelectorAll('AuthorList > Author')) {
      const ln = a.querySelector('LastName'), ini = a.querySelector('Initials');
      if (ln) authors.push((ln.textContent + ' ' + (ini ? ini.textContent : '')).trim());
    }
    let doi = '';
    for (const id of pa.querySelectorAll('ArticleIdList > ArticleId')) {
      if (id.getAttribute('IdType') === 'doi') doi = id.textContent.trim();
    }
    const pmid = txt('MedlineCitation > PMID');
    out.push({
      pmid, doi,
      title: txt('Article > ArticleTitle').replace(/\s+/g, ' ').replace(/^\[|\]\.?$/g, ''),
      abstract: parts.join(' '),
      journal: txt('Journal > ISOAbbreviation') || txt('Journal > Title'),
      year: txt('Journal PubDate > Year'),
      authors,
      keywords: [...pa.querySelectorAll('KeywordList > Keyword')].map(k => k.textContent.trim()),
      mesh: [...pa.querySelectorAll('MeshHeading > DescriptorName')].map(m => m.textContent.trim()),
      pubtypes: [...pa.querySelectorAll('PublicationTypeList > PublicationType')].map(p => p.textContent.trim()),
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    });
  }
  return out;
}

async function runScan(u, days, onProgress) {
  const until = new Date();
  const since = new Date(until.getTime() - days * 864e5);
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const clause = u.journals.map(a => `"${a}"[ta]`).join(' OR ');
  const term = `(${clause}) AND ("${fmt(since)}"[EDAT] : "${fmt(until)}"[EDAT])`;

  onProgress('searching PubMed…', 0, 0);
  const sr = await (await eutils('esearch.fcgi', { db: 'pubmed', term, retmax: 2000, retmode: 'json', sort: 'date' })).json();
  const ids = sr.esearchresult.idlist || [];
  const seen = new Set(u.seen);
  const fresh = ids.filter(i => !seen.has(i));
  if (!fresh.length) return { articles: [], since: fmt(since), until: fmt(until), total: ids.length };

  const arts = [];
  const CHUNK = 100;
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const batch = fresh.slice(i, i + CHUNK);
    onProgress('fetching records', Math.min(i + CHUNK, fresh.length), fresh.length);
    try {
      const r = await eutils('efetch.fcgi', { db: 'pubmed', id: batch.join(','), retmode: 'xml' });
      arts.push(...parseArticles(await r.text()));
    } catch (e) { console.warn('batch failed, skipping', e); }
    await sleep(400);
  }

  onProgress('scoring…', fresh.length, fresh.length);
  const terms = userTerms(u);
  const priors = {};
  for (const a of u.journals) priors[a.toLowerCase()] = (DATA.journals.journals[a] || {}).prior ?? 0.7;
  const names = {};
  for (const a of u.journals) names[a.toLowerCase()] = (DATA.journals.journals[a] || {}).name || a;

  for (const a of arts) {
    a.journalName = names[(a.journal || '').toLowerCase()] || a.journal;
    const { score, why } = scoreArticle(a, u, terms, priors);
    a.score = score; a.why = why;
  }
  arts.sort((x, y) => y.score - x.score);

  u.seen = [...new Set([...u.seen, ...arts.map(a => a.pmid)])].slice(-6000);
  return { articles: arts, since: fmt(since), until: fmt(until), total: ids.length,
           generated: new Date().toISOString(), journals: u.journals.length };
}

/* ---------------------------------------------------- optional Claude rerank */

async function claudeRerank(run, u, onProgress) {
  const key = lsGet('anthropicKey', '');
  if (!key) throw new Error('No API key set. Add one in Settings.');
  const top = run.articles.slice(0, 30);
  const payload = top.map((a, i) => ({
    rank: i + 1, pmid: a.pmid, prior: a.score, title: a.title,
    journal: a.journalName, abstract: (a.abstract || '').slice(0, 2200),
    matched: a.why.matched,
  }));
  const idx = subtopicIndex();
  const interests = u.subtopics.map(k => (idx.get(k) || [null, {}])[1].name).filter(Boolean);
  const axisSummary = Object.entries(u.axisScores).map(([id, v]) => {
    const ax = DATA.axes.axes.find(a => a.id === id);
    if (!ax || Math.abs(v) < 0.05) return null;
    return `${ax.name}: leans ${v > 0 ? ax.high_label : ax.low_label}`;
  }).filter(Boolean);

  const prompt =
`You are ranking this week's new medical literature for one reader.

READER PROFILE
Topics of interest: ${interests.join(', ')}
Reading style: ${axisSummary.join('; ') || 'no strong preferences recorded'}

The "prior" score on each article is a keyword heuristic. It is reliably wrong in
both directions: it over-rewards an article that merely repeats a matched phrase,
and under-rewards an on-topic article that happens not to use the configured
vocabulary. Correct it by reading the abstracts.

Return ONLY a JSON array, one object per article, no prose:
[{"pmid":"...","score":0-100,"blurb":"...","tag":"..."}]

score: predicted interest for THIS reader. 85-100 = will almost certainly read it.
70-84 = strong. 50-69 = runner-up. 25-49 = probably skip. 0-24 = off-target.
blurb: 1-2 concrete sentences. Lead with what was actually done and the number that
matters (n, effect, method). Not "this study investigates". Say why this reader
would care. If you moved something far from its prior, say so.
tag: 1-3 lowercase words.

ARTICLES
${JSON.stringify(payload)}`;

  onProgress('Claude is reading ' + top.length + ' abstracts…');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Anthropic API ${r.status}: ${body.slice(0, 300)}`);
  }
  const data = await r.json();
  if (data.stop_reason === 'refusal') throw new Error('Request was declined by safety classifiers.');
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text in response.');
  const m = textBlock.text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('Could not parse a JSON array from the response.');
  const scored = JSON.parse(m[0]);
  const byPmid = new Map(scored.map(s => [String(s.pmid), s]));
  for (const a of run.articles) {
    const s = byPmid.get(a.pmid);
    if (s) { a.claudeScore = Math.round(s.score); a.blurb = s.blurb || ''; a.tag = s.tag || ''; }
  }
  run.articles.sort((a, b) =>
    (b.claudeScore ?? b.score * 0.95) - (a.claudeScore ?? a.score * 0.95));
  run.reranked = new Date().toISOString();
  return scored.length;
}

const finalScore = a => (a.claudeScore ?? a.score);

/* ---------------------------------------------------------------------- ui */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3000);
}

function nav(view) {
  if (!USER) return '<nav><div class="in"><span class="brand">Your Journal</span></div></nav>';
  const ready = USER.step === 'ready';
  const tab = (v, label) => `<a class="tab ${view === v ? 'on' : ''}" data-view="${v}">${label}</a>`;
  const n = Object.keys(USER.library).length;
  return `<nav><div class="in"><span class="brand" data-view="${ready ? 'feed' : 'onboard'}">Your Journal</span>` +
    (ready
      ? tab('feed', 'Feed') + tab('paper', 'The Paper') + tab('saved', `Saved · ${n}`) + tab('settings', 'Settings')
      : tab('onboard', 'Set up')) +
    `<span class="sp"></span><span class="who">${esc(USER.name)} · <a data-view="switch">switch</a></span></div></nav>`;
}

const BANNER_ON = new Set(['feed', 'saved', 'settings']);
let VIEW = '';
const currentView = () => VIEW || 'feed';

function render(view, inner, wide) {
  VIEW = view;
  const banner = BANNER_ON.has(view) ? exportBannerHTML() : '';
  $('#app').innerHTML = nav(view) + `<div class="wrap${wide ? ' wide' : ''}">` + banner + inner + '</div>';
  document.title = view === 'paper' ? 'Your Journal — The Paper' : 'Your Journal';
}

/* views ------------------------------------------------------------------- */

function viewPick() {
  const ps = listProfiles();
  const rows = ps.map(p => `<button class="pick" data-use="${esc(p.id)}"><span class="ic">📰</span><span>
    <span class="nm">${esc(p.name)}</span><span class="ct">on this device</span></span></button>`).join('');
  render('', `<h1>Your Journal</h1>
    <div class="sub">A weekly feed of new research, ranked for one person's interests. Tell it what you
    care about once; it learns from what you read. Everything stays in this browser.</div>
    ${ps.length ? `<h2>Continue as</h2><div class="grid">${rows}</div>` : ''}
    <h2>New reader</h2>
    <div class="row"><input type="text" id="newname" placeholder="Your name">
      <button class="btn" id="create">Start</button></div>
    <h2>Or restore a profile</h2>
    <div class="row"><input type="file" id="importfile" accept="application/json">
      <span class="hint">Exported from another browser or device.</span></div>`);
}

function stepsBar(cur) {
  const steps = [['specialties', 'Specialties'], ['subtopics', 'Subtopics'], ['pairs', 'This or that'],
    ['journals', 'Journals'], ['ready', 'Done']];
  const i = steps.findIndex(s => s[0] === cur);
  return '<div class="steps">' + steps.map(([k, l], j) =>
    `<span class="${j === i ? 'on' : j < i ? 'done' : ''}">${l}</span>`).join('') + '</div>';
}

function viewSpecialties() {
  const chosen = new Set(USER.specialties);
  const cards = DATA.taxonomy.specialties.map(s =>
    `<button class="pick multi ${chosen.has(s.id) ? 'on' : ''}" data-val="${s.id}">
      <span class="ic">${s.icon}</span><span><span class="nm">${esc(s.name)}</span>
      <span class="ct">${s.subtopics.length} subtopics</span></span></button>`).join('');
  render('onboard', stepsBar('specialties') + `<h1>What do you practise?</h1>
    <div class="sub">Pick every field you want to follow. Most people pick one or two; picking more widens
    the net rather than diluting it, because you narrow again on the next screen.</div>
    <form id="multi" data-next="subtopics"><div class="grid">${cards}</div>
    <div class="row"><button class="btn" type="submit" data-count="Continue with {n} →">
      Continue with ${chosen.size} →</button></div></form>`);
}

function viewSubtopics() {
  const chosen = new Set(USER.subtopics);
  const groups = USER.specialties.map(sid => {
    const s = DATA.taxonomy.specialties.find(x => x.id === sid);
    if (!s) return '';
    const cards = s.subtopics.map(st => {
      const key = sid + ':' + st.id;
      return `<button class="pick multi ${chosen.has(key) ? 'on' : ''}" data-val="${esc(key)}">
        <span><span class="nm">${esc(st.name)}</span><span class="ct">${st.terms.length} keywords</span></span></button>`;
    }).join('');
    return `<div class="grp"><h3>${s.icon} ${esc(s.name)}</h3><div class="grid">${cards}</div></div>`;
  }).join('');
  render('onboard', stepsBar('subtopics') + `<h1>Narrow it down</h1>
    <div class="sub">These supply the vocabulary your ranking is built from — 3,700 keywords sit behind
    these tiles. An article scores high when it matches the ones you pick. 5–15 works well.</div>
    <form id="multi" data-next="pairs">${groups}
    <div class="row"><button class="btn" type="submit" data-count="Continue with {n} →">
      Continue with ${chosen.size} →</button>
    <button class="btn ghost" type="button" data-goto="specialties">← Back</button></div></form>`);
}

function buildPairs() {
  const idx = subtopicIndex();
  const topics = USER.subtopics.map(k => (idx.get(k) || [null, {}])[1].name).filter(Boolean).map(t => t.toLowerCase());
  const pool = [];
  for (const ax of DATA.axes.axes) ax.questions.forEach((q, qi) => pool.push({ ax, qi, q }));
  // deterministic shuffle seeded on the profile id, so the set is stable per reader
  let seed = [...USER.id].reduce((a, c) => a + c.charCodeAt(0), 0) || 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  pool.sort(() => rnd() - 0.5);
  return pool.slice(0, 12).map((p, i) => ({
    id: p.ax.id + '#' + p.qi, axis: p.ax.id, axisName: p.ax.name,
    low: p.q.low.replace('{topic}', topics[i % topics.length] || 'your field'),
    high: p.q.high.replace('{topic}', topics[i % topics.length] || 'your field'),
  }));
}

function viewPairs() {
  const pairs = buildPairs();
  const boxes = pairs.map(p => `<div class="pair" data-qid="${esc(p.id)}" data-axis="${esc(p.axis)}">
    <div class="ax">${esc(p.axisName)}</div>
    <div class="opts"><button type="button" data-choice="low">${esc(p.low)}</button>
    <button type="button" data-choice="high">${esc(p.high)}</button></div>
    <div class="skip"><button type="button" data-choice="both">Both equally</button>
    <button type="button" data-choice="neither">Neither</button></div></div>`).join('');
  render('onboard', stepsBar('pairs') + `<h1>This or that</h1>
    <div class="sub">Two papers land in your inbox on the same day and you only have time for one. Which do
    you open? There is no right answer — this measures the <b>kind</b> of paper you reach for, not the
    topic. Answer as many as you like and skip the rest.</div>
    <form id="pairform">${boxes}
    <div class="row"><button class="btn" type="submit" data-count="Build my formula ({n}/12) →" disabled>
      Build my formula (0/12) →</button>
    <button class="btn ghost" type="button" data-goto="subtopics">← Back</button></div></form>`);
}

function viewJournals() {
  const sugg = suggestJournals(USER);
  const chosen = new Set(USER.journals.length ? USER.journals : sugg.filter(j => j.core).map(j => j.abbrev));
  const card = j => `<button class="pick multi ${chosen.has(j.abbrev) ? 'on' : ''}" data-val="${esc(j.abbrev)}">
    <span><span class="nm">${esc(j.name)}</span><span class="ct">${esc(j.why)}<br>${j.volume.toLocaleString()} indexed</span></span></button>`;
  const core = sugg.filter(j => j.core), rest = sugg.filter(j => !j.core);
  render('onboard', stepsBar('journals') + `<h1>Where should we look?</h1>
    <div class="sub">Suggested from what you picked. The strongest matches are pre-selected — deselect
    anything you don't read. You can change this any time in Settings.</div>
    <form id="multi" data-next="ready">
    ${core.length ? `<div class="grp"><h3>Strong matches · ${core.length}</h3><div class="grid">${core.map(card).join('')}</div></div>` : ''}
    ${rest.length ? `<div class="grp"><h3>Also relevant · ${rest.length}</h3><div class="grid">${rest.map(card).join('')}</div></div>` : ''}
    <div class="row"><button class="btn" type="submit" data-count="Build my first issue ({n} journals) →">
      Build my first issue (${chosen.size} journals) →</button>
    <button class="btn ghost" type="button" data-goto="pairs">← Back</button></div></form>`);
}

function articleCard(a, rank, opts = {}) {
  const fb = USER.feedback[a.pmid] || {};
  const saved = !!USER.library[a.pmid];
  const sc = finalScore(a);
  const auth = a.authors || [];
  const who = auth.length > 2 ? auth[0] + ' et al.' : auth.join(', ') || '—';
  const cls = 'card' + (fb.verdict === 'dislike' ? ' dis' : '') + (saved ? ' sav' : '');
  const tags = (a.why?.matched || []).slice(0, 5).map(t => `<span class="tag">${esc(t)}</span>`).join('');
  return `<div class="${cls}">
    <div class="top"><span class="rk">${rank}</span><span class="sc">${sc}</span>
    <span class="ti"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></span></div>
    <div class="ind">
      <div class="meta">${esc(a.journalName || a.journal)} · ${esc(who)} · pmid ${esc(a.pmid)}</div>
      <div class="meter"><i style="width:${sc}%"></i></div>
      ${a.blurb ? `<div class="blurb">${esc(a.blurb)}</div>` : ''}
      ${tags ? `<div>${tags}</div>` : ''}
      <div class="acts" data-pmid="${esc(a.pmid)}" data-verdict="${esc(fb.verdict || '')}" data-saved="${saved ? '1' : ''}">
        <button data-v="love" class="${fb.verdict === 'love' ? 'on' : ''}" title="Very interested">👍👍</button>
        <button data-v="like" class="${fb.verdict === 'like' ? 'on' : ''}" title="Interested">👍</button>
        <button data-v="dislike" class="${fb.verdict === 'dislike' ? 'on' : ''}" title="Not interested">👎</button>
        <button class="sv ${saved ? 'on' : ''}" title="Save for later">${saved ? '★' : '☆'}</button>
        <span class="st"></span></div>
    </div></div>`;
}

function viewFeed() {
  const run = USER.run;
  if (!run) return render('feed', '<div class="empty">No issue yet. <a data-act="scan">Fetch this week</a>.</div>');
  const arts = run.articles;
  const top = arts.slice(0, 12), more = arts.slice(12, 27);
  const hasKey = !!lsGet('anthropicKey', '');
  render('feed', `<h1>This week</h1>
    <div class="sub">${run.since} → ${run.until} · ${run.journals} journals · ${arts.length} new articles screened ·
    scores are predicted interest (0–100) · <a data-view="paper">read it as a paper →</a></div>
    <div class="row" style="margin-top:-.6rem">
      <button class="btn ghost" data-act="scan">Fetch again</button>
      ${run.reranked
        ? '<span class="hint">✓ Re-ranked by Claude</span>'
        : `<button class="btn ghost" data-act="rerank">${hasKey ? 'Re-rank with Claude' : 'Re-rank (needs API key)'}</button>`}
    </div>
    <h2>Top picks</h2>${top.map((a, i) => articleCard(a, i + 1)).join('')}
    ${more.length ? `<h2>Also this week · 13–${12 + more.length}</h2>${more.map((a, i) => articleCard(a, i + 13)).join('')}` : ''}
    <div class="note"><b>👍👍 very interested · 👍 interested · 👎 not interested</b> teaches your formula —
    a double thumbs-up counts twice. <b>★</b> just saves it for later and does not change your ranking.
    ${run.reranked ? '' : 'Scores here are keyword pre-scores; the Claude re-rank reads the abstracts and corrects them.'}</div>`);
}

const STRUCT = /(?:^|(?<=[.\s]))(?:BACKGROUND|OBJECTIVES?|AIMS?|GOALS?|PURPOSE|INTRODUCTION|CONTEXT|RATIONALE|IMPORTANCE|DESCRIPTION|SUMMARY|UNLABELLED|METHODS?|MATERIALS|DESIGN|SETTINGS?|PARTICIPANTS|PATIENTS|SUBJECTS|INTERVENTIONS?|EXPOSURES?|MEASUREMENTS?|OUTCOMES?|MEASURES?|MAIN|PRIMARY|SECONDARY|STUDY|RESULTS|FINDINGS|CONCLUSIONS?|INTERPRETATION|DISCUSSION|IMPLICATIONS|SIGNIFICANCE|LIMITATIONS|KEY POINTS|TRIAL REGISTRATION|FUNDING)(?:[ /&,-]+(?:AND\s+)?(?:BACKGROUND|OBJECTIVES?|AIMS?|METHODS?|RESULTS|CONCLUSIONS?|MEASURES?|OUTCOMES?|DESIGN|FINDINGS))*\s*:\s*/g;

function firstSentences(text, n = 2, cap = 340) {
  if (!text) return '';
  let t = text.replace(STRUCT, '').replace(/\s{2,}/g, ' ').trim();
  const parts = t.split(/(?<=[.!?])\s+/);
  const out = parts.slice(0, n).join(' ').trim();
  return out.length > cap ? out.slice(0, cap).replace(/\s+\S*$/, '') + '…' : out;
}

function viewPaper() {
  const run = USER.run;
  if (!run) return render('paper', '<div class="empty">No issue yet.</div>', true);
  const arts = run.articles.filter(a => a.abstract).slice(0, 22);
  if (!arts.length) return render('paper', '<div class="empty">Nothing with abstracts this week.</div>', true);
  const lead = arts[0];
  const la = lead.authors || [];
  const leadWho = la.length > 2 ? la[0] + ' et al.' : la.join(', ');
  const kicker = lead.tag || (lead.why?.matched || [])[0] || 'Lead';
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const stories = arts.slice(1).map(a => {
    const au = a.authors || [];
    const who = au.length > 2 ? au[0] + ' et al.' : au.join(', ');
    return `<div class="story"><div class="src">${esc(a.journalName || a.journal)}</div>
      <h4><span class="scr">${finalScore(a)}</span>
      <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h4>
      <div class="dek">${esc(a.blurb || firstSentences(a.abstract, 2))}</div>
      <div class="src" style="margin-top:.4rem">${esc(who)}</div></div>`;
  }).join('');
  render('paper', `<div class="paper">
    <div class="masthead"><h1>Your Journal</h1>
      <div class="dek">Curated for ${esc(USER.name)}</div></div>
    <div class="rule"><span>${esc(today)}</span><span>${run.articles.length} papers screened</span>
      <span>${run.journals} journals</span></div>
    <div class="lead"><div class="kick">${esc(kicker)}</div>
      <h3><a href="${esc(lead.url)}" target="_blank" rel="noopener">${esc(lead.title)}</a></h3>
      <div class="byline">${esc(leadWho)} · ${esc(lead.journalName || lead.journal)}</div>
      <div class="body"><p>${esc(lead.blurb || firstSentences(lead.abstract, 4, 900))}</p></div></div>
    <div class="secthead">More in this issue</div><div class="cols">${stories}</div>
    <div class="papernote">Assembled from ${run.articles.length} articles indexed ${run.since} to ${run.until}.
      <a data-view="feed">Rate these in the feed →</a></div></div>`, true);
}

function viewSaved() {
  const items = Object.values(USER.library).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  if (!items.length) return render('saved', '<div class="empty">Nothing saved yet. Hit ☆ on any article.</div>');
  render('saved', `<h1>Saved</h1><div class="sub">${items.length} articles · newest first</div>` +
    items.map((it, i) => articleCard({ ...it, why: { matched: [] } }, i + 1)).join(''));
}

function viewSettings() {
  const idx = subtopicIndex();
  const subs = USER.subtopics.map(k => (idx.get(k) || [null, {}])[1].name).filter(Boolean);
  const axRows = Object.entries(USER.axisScores).map(([id, v]) => {
    const ax = DATA.axes.axes.find(a => a.id === id);
    if (!ax) return '';
    const strength = Math.abs(v) > 0.6 ? 'strongly' : Math.abs(v) > 0.2 ? 'mildly' : 'barely';
    const txt = Math.abs(v) > 0.05 ? `${strength} toward <b>${esc(v > 0 ? ax.high_label : ax.low_label)}</b>` : 'no preference';
    return `<div class="story"><div class="src">${esc(ax.name)}</div><div class="dek">${txt}</div></div>`;
  }).join('');
  const reg = DATA.journals.journals;
  const jl = USER.journals.map(a => (reg[a] || {}).name || a).join(', ');
  const n = { love: 0, like: 0, dislike: 0 };
  for (const r of Object.values(USER.feedback)) if (n[r.verdict] !== undefined) n[r.verdict]++;
  const key = lsGet('anthropicKey', '');
  render('settings', `<h1>Your formula</h1>
    <div class="sub">Everything here is editable. Changes apply from your next issue.</div>
    <h2>Topics</h2><div class="sub">${esc(subs.join(', ')) || 'none'} ·
      <a data-goto="subtopics">change</a></div>
    <h2>Reading style</h2><div class="cols two">${axRows}</div>
      <div class="sub" style="margin-top:1rem"><a data-goto="pairs">retake the this-or-that</a></div>
    <h2>Journals</h2><div class="sub">${esc(jl) || 'none'} · <a data-goto="journals">change</a></div>
    <h2>What it has learned</h2>
      <div class="sub">${n.love} 👍👍 · ${n.like} 👍 · ${n.dislike} 👎 · ${Object.keys(USER.weights).length}
      learned terms. The more you rate, the more your ranking diverges from the generic version of your specialty.</div>
    <h2>Claude re-rank (optional)</h2>
    <div class="sub">The feed ranks by keyword match. Paste an <a href="https://console.anthropic.com/settings/keys"
      target="_blank" rel="noopener">Anthropic API key</a> and Claude will read the top 30 abstracts and rewrite
      the scores — the same pass that makes the desktop version good. Roughly a few cents per issue.<br><br>
      <b>Your key is stored in this browser only</b> and sent directly to api.anthropic.com. Anyone with access to
      this device or browser profile can read it. Don't use a shared computer, and revoke the key if you're unsure.</div>
    <div class="row"><input type="password" id="apikey" placeholder="sk-ant-..." value="${esc(key)}" autocomplete="off">
      <button class="btn" data-act="savekey">Save key</button>
      ${key ? '<button class="btn ghost" data-act="clearkey">Remove key</button>' : ''}</div>
    <h2>Your data</h2>
    <div class="sub">Everything lives in this browser. Clearing site data erases it — export a copy to move
      to another device or keep a backup.</div>
    <div class="row"><button class="btn ghost" data-act="export">Export profile</button>
      <button class="btn ghost" data-view="switch">Switch reader</button>
      <button class="btn ghost" data-act="scan">Fetch a new issue</button></div>`);
}

function viewBuilding(msg) {
  render('onboard', `<h1>Building your issue</h1>
    <div class="sub">Searching ${USER.journals.length} journals, then scoring each result against your formula.</div>
    <div class="note" id="scanbox"><b>${esc(msg || 'starting…')}</b></div>`);
}

/* --------------------------------------------------------------- controller */

function go(view) {
  if (view === 'switch') { lsSet('active', null); USER = null; return viewPick(); }
  if (!USER) return viewPick();
  if (view === 'onboard') view = USER.step;
  switch (view) {
    case 'specialties': return viewSpecialties();
    case 'subtopics': return viewSubtopics();
    case 'pairs': return viewPairs();
    case 'journals': return viewJournals();
    case 'feed': case 'ready': return viewFeed();
    case 'paper': return viewPaper();
    case 'saved': return viewSaved();
    case 'settings': return viewSettings();
    default: return viewFeed();
  }
}

async function doScan() {
  if (!USER.journals.length) { toast('Pick some journals first.'); return go('journals'); }
  viewBuilding('starting…');
  const box = $('#scanbox');
  try {
    const run = await runScan(USER, 8, (msg, done, total) => {
      box.innerHTML = `<b>${esc(msg)}</b>${total ? ` — ${done.toLocaleString()} / ${total.toLocaleString()}` : ''}
        <div class="prog"><i style="width:${total ? Math.round(done / total * 100) : 5}%"></i></div>`;
    });
    if (!run.articles.length) {
      box.innerHTML = '<b>Nothing new since your last issue.</b> Try again in a few days.';
      setTimeout(() => go('feed'), 2200);
      return;
    }
    USER.run = run; USER.step = 'ready'; saveUser();
    go('feed');
  } catch (e) {
    box.innerHTML = `<b>Scan failed.</b> ${esc(e.message)}`;
  }
}

async function doRerank() {
  const run = USER.run;
  if (!run) return;
  const prev = $('#app').innerHTML;
  render('feed', `<h1>Re-ranking</h1><div class="note" id="rr"><b>starting…</b></div>`);
  try {
    const n = await claudeRerank(run, USER, msg => { $('#rr').innerHTML = `<b>${esc(msg)}</b>
      <div class="prog"><i style="width:60%"></i></div>`; });
    saveUser();
    toast(`Claude re-ranked ${n} articles.`);
    go('feed');
  } catch (e) {
    $('#rr').innerHTML = `<b>Re-rank failed.</b> ${esc(e.message)}
      <div style="margin-top:.6rem">Your keyword ranking is unchanged. <a data-view="feed">Back to the feed</a> ·
      <a data-view="settings">Settings</a></div>`;
  }
}

function findArticle(pmid) {
  return (USER.run?.articles || []).find(a => a.pmid === pmid) || USER.library[pmid] || { pmid, title: '', abstract: '' };
}

document.addEventListener('click', async e => {
  const t = e.target;

  const use = t.closest('[data-use]');
  if (use) { const u = loadProfile(use.dataset.use); if (u) { USER = u; lsSet('active', u.id); go(u.step === 'ready' ? 'feed' : 'onboard'); } return; }

  const viewEl = t.closest('[data-view]');
  if (viewEl) { e.preventDefault(); return go(viewEl.dataset.view); }

  const gotoEl = t.closest('[data-goto]');
  if (gotoEl) { e.preventDefault(); return go(gotoEl.dataset.goto); }

  if (t.id === 'create') {
    const name = $('#newname').value.trim();
    if (!name) return toast('Enter a name.');
    USER = newProfile(name.slice(0, 40));
    return go('onboard');
  }

  const multi = t.closest('.pick.multi');
  if (multi) {
    multi.classList.toggle('on');
    const form = multi.closest('form');
    const btn = form?.querySelector('[data-count]');
    if (btn) {
      const n = form.querySelectorAll('.pick.multi.on').length;
      btn.disabled = n === 0;
      btn.textContent = btn.dataset.count.replace('{n}', n);
    }
    return;
  }

  const pb = t.closest('.pair button[data-choice]');
  if (pb) {
    const box = pb.closest('.pair');
    box.querySelectorAll('button').forEach(b => b.classList.remove('on'));
    pb.classList.add('on');
    box.dataset.answer = pb.dataset.choice;
    const form = $('#pairform');
    const btn = form.querySelector('[data-count]');
    const done = form.querySelectorAll('.pair[data-answer]').length;
    btn.disabled = done === 0;
    btn.textContent = btn.dataset.count.replace('{n}', done);
    return;
  }

  const vb = t.closest('.acts button[data-v]');
  if (vb) {
    const w = vb.closest('.acts'), pmid = w.dataset.pmid;
    const v = w.dataset.verdict === vb.dataset.v ? '' : vb.dataset.v;
    w.dataset.verdict = v;
    w.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', !!v && b.dataset.v === v));
    w.closest('.card')?.classList.toggle('dis', v === 'dislike');
    const a = findArticle(pmid);
    if (v) {
      USER.feedback[pmid] = { verdict: v, ts: new Date().toISOString(), title: a.title,
        journal: a.journalName || a.journal, predicted: finalScore(a),
        text: [a.title, a.abstract, (a.keywords || []).join(' '), (a.mesh || []).join(' ')].join(' ') };
    } else delete USER.feedback[pmid];
    relearn(USER); saveUser();
    const st = w.querySelector('.st');
    st.textContent = v ? 'saved' : 'cleared'; st.classList.add('show');
    setTimeout(() => st.classList.remove('show'), 1600);
    return;
  }

  const sb = t.closest('.acts button.sv');
  if (sb) {
    const w = sb.closest('.acts'), pmid = w.dataset.pmid, on = !w.dataset.saved;
    w.dataset.saved = on ? '1' : '';
    sb.classList.toggle('on', on); sb.textContent = on ? '★' : '☆';
    w.closest('.card')?.classList.toggle('sav', on);
    const a = findArticle(pmid);
    if (on) {
      USER.library[pmid] = { pmid, title: a.title, journalName: a.journalName || a.journal,
        authors: (a.authors || []).slice(0, 6), url: a.url, score: finalScore(a),
        blurb: a.blurb || '', savedAt: new Date().toISOString() };
    } else delete USER.library[pmid];
    saveUser();
    return;
  }

  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'scan') return doScan();
  if (act === 'rerank') return doRerank();
  if (act === 'export') { exportProfile(); toast('Exported. Keep the file somewhere you will find it.'); return go(currentView()); }
  if (act === 'snooze') {
    USER.exportSnooze = new Date(Date.now() + SNOOZE_FOR).toISOString();
    saveUser();
    toast('Reminder paused for 3 days.');
    return go(currentView());
  }
  if (act === 'savekey') {
    const v = $('#apikey').value.trim();
    if (!v) return toast('Paste a key first.');
    lsSet('anthropicKey', v); toast('Key saved in this browser.'); return go('settings');
  }
  if (act === 'clearkey') { lsSet('anthropicKey', ''); toast('Key removed.'); return go('settings'); }
});

document.addEventListener('submit', e => {
  const form = e.target;
  e.preventDefault();
  if (form.id === 'multi') {
    const vals = [...form.querySelectorAll('.pick.multi.on')].map(p => p.dataset.val);
    const next = form.dataset.next;
    if (next === 'subtopics') {
      USER.specialties = vals;
      const valid = new Set();
      for (const sid of vals) {
        const s = DATA.taxonomy.specialties.find(x => x.id === sid);
        if (s) for (const st of s.subtopics) valid.add(sid + ':' + st.id);
      }
      USER.subtopics = USER.subtopics.filter(k => valid.has(k));
      USER.step = 'subtopics';
    } else if (next === 'pairs') {
      if (!vals.length) return toast('Pick at least one subtopic.');
      USER.subtopics = vals; USER.step = 'pairs';
    } else if (next === 'ready') {
      if (!vals.length) return toast('Pick at least one journal.');
      USER.journals = vals; USER.step = 'ready'; saveUser();
      return doScan();
    }
    saveUser();
    return go(USER.step);
  }
  if (form.id === 'pairform') {
    const tally = {};
    form.querySelectorAll('.pair').forEach(b => {
      const ans = b.dataset.answer;
      if (!ans) return;
      const ax = b.dataset.axis;
      tally[ax] = tally[ax] || [0, 0];
      if (ans === 'low') tally[ax][0] -= 1;
      else if (ans === 'high') tally[ax][0] += 1;
      tally[ax][1] += 1;
    });
    const scores = {};
    for (const [ax, [total, n]] of Object.entries(tally)) {
      if (n) scores[ax] = +Math.max(-1, Math.min(1, total / n)).toFixed(3);
    }
    USER.axisScores = scores; USER.step = 'journals'; saveUser();
    return go('journals');
  }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'importfile' && e.target.files[0]) {
    try { USER = await importProfile(e.target.files[0]); toast('Profile restored.'); go(USER.step === 'ready' ? 'feed' : 'onboard'); }
    catch (err) { toast('Import failed: ' + err.message); }
  }
});

/* -------------------------------------------------------------------- boot */

(async function boot() {
  try {
    const [tax, ax, jr] = await Promise.all([
      fetch('data/taxonomy.json').then(r => r.json()),
      fetch('data/axes.json').then(r => r.json()),
      fetch('data/journals.json').then(r => r.json()),
    ]);
    DATA = { taxonomy: tax, axes: ax, journals: jr };
  } catch (e) {
    $('#app').innerHTML = `<div class="wrap"><h1>Couldn't load data</h1>
      <div class="sub">${esc(e.message)}. If you opened this file directly, serve it over http
      (<code>python3 -m http.server</code>) — browsers block fetch on file:// URLs.</div></div>`;
    return;
  }
  const active = lsGet('active', null);
  USER = active ? loadProfile(active) : null;
  go(USER ? (USER.step === 'ready' ? 'feed' : 'onboard') : 'pick');
})();
