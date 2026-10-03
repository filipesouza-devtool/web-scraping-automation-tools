(() => {
  'use strict';

  // Rodar de novo fecha a instância anterior e começa limpo
  if (window.__uniDestroy) { try { window.__uniDestroy(); } catch (_) {} }

  // ───────────────────────── Estado ─────────────────────────
  const OPTS = { wait: 400, maxMs: 120000, maxSteps: 400 };
  const S = {
    cols: [],            // { id, name, mode, scope, sig, path?, ord?, css?, last? }
    card: null,          // elemento-exemplo do "card"
    sig: null,           // assinatura do card
    pending: null,       // ação aguardando o clique
    recs: [],            // registros brutos { vals }
    byEl: new Map(),     // card (elemento) -> registro
    headers: [],
    rows: [],            // linhas finais (arrays)
    running: false,
    abort: false
  };

  const SCOPE_LABEL = { card: '▣ card', context: '↑ contexto', global: '🌐 fixo', index: '# posição' };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (_) { return u; } };

  // Helper de DOM: sem innerHTML (compatível com Trusted Types / CSP estrita)
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };

  // ───────────────────────── UI (Shadow DOM) ─────────────────────────
  const CSS_TEXT = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif}
    [hidden]{display:none!important}
    .panel{position:fixed;top:15px;right:15px;width:360px;background:#0f172a;color:#f8fafc;padding:14px;border-radius:12px;border:1px solid #334155;box-shadow:0 10px 30px rgba(0,0,0,.8);display:flex;flex-direction:column;gap:10px;font-size:12px}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155;padding-bottom:8px}
    .head b{color:#38bdf8;font-size:13px}
    .row{display:flex;gap:6px;align-items:center}
    input[type=text],input[type=number],select{background:#1e293b;color:#fff;border:1px solid #475569;padding:6px 8px;border-radius:6px;font-size:11px}
    input[type=text]{flex:1;min-width:0}
    select{flex:1;min-width:0}
    input.num{width:64px}
    .btn{border:none;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer;font-weight:700;font-size:11px;white-space:nowrap}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .blue{background:#0284c7}.green{background:#059669}.red{background:#dc2626}.ghost{background:#334155}
    .x{background:none;border:none;color:#ef4444;cursor:pointer;font-size:13px}
    .cols{max-height:130px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;background:#1e293b;padding:6px;border-radius:6px;border:1px solid #334155}
    .col{display:flex;justify-content:space-between;align-items:center;gap:6px;background:#0f172a;padding:4px 8px;border-radius:4px;border:1px solid #334155}
    .col b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tag{color:#94a3b8;font-size:10px;white-space:nowrap}
    .muted{color:#64748b;text-align:center}
    .opts{display:flex;justify-content:space-between;align-items:center;color:#cbd5e1;font-size:11px;gap:6px}
    .opts label{display:flex;gap:4px;align-items:center}
    .status{font-size:10px;color:#94a3b8;text-align:center;min-height:14px}
    .ov{position:fixed;pointer-events:none;border:2px solid #38bdf8;background:rgba(56,189,248,.15);border-radius:3px}
    .modal{position:fixed;inset:5%;background:#0f172a;color:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.8);display:flex;flex-direction:column;overflow:hidden}
    .mh{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 16px;background:#1e293b;flex-wrap:wrap;font-size:14px}
    .mb{flex:1;overflow:auto;padding:12px}
    table{border-collapse:collapse;width:100%;font-size:12px}
    th{position:sticky;top:0;background:#1e293b;padding:8px;text-align:left;border-bottom:2px solid #334155}
    td{padding:6px;border:1px solid #1e293b;max-width:360px;overflow-wrap:anywhere;vertical-align:top}
    td[contenteditable]:focus{outline:1px solid #38bdf8;background:#1e293b}
    td.act{text-align:center;width:36px}
  `;

  const host = h('div');
  host.id = '__uni_host__';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    root.adoptedStyleSheets = [sheet];
  } catch (_) {
    root.append(h('style', { text: CSS_TEXT }));
  }
  // Evita que atalhos de teclado do site capturem o que digitamos no painel
  ['keydown', 'keyup', 'keypress'].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));

  const btn = (text, cls, fn, title) => h('button', { class: 'btn ' + cls, text, onclick: fn, title });
  const opt = ([v, t]) => h('option', { value: v, text: t });

  const nameIn = h('input', { type: 'text', placeholder: 'Nome da coluna (ex: Preço)', maxlength: 60,
    onkeydown: (e) => { if (e.key === 'Enter') startPick(); } });
  const addBtn = btn('+ Mapear', 'blue', startPick);
  const modeSel = h('select', { title: 'O que ler do elemento' },
    ...[['auto', 'Tipo: auto'], ['text', 'Texto'], ['img', 'Imagem'], ['link', 'Link']].map(opt));
  const scopeSel = h('select', { title: 'Onde o dado está em relação ao card' },
    ...[['auto', 'Onde: auto'], ['card', 'No card'], ['context', 'Contexto ↑'], ['global', 'Fixo (1x)'], ['index', 'Por posição']].map(opt));
  const cardBtn = btn('🎯 Card', 'ghost', startPickCard, 'Definir (ou trocar) o card clicando dentro dele');
  const colsBox = h('div', { class: 'cols' });
  const dedupeIn = h('input', { type: 'checkbox', checked: true });
  const waitIn = h('input', { type: 'number', class: 'num', min: 100, max: 5000, step: 100, value: OPTS.wait });
  const runBtn = btn('🚀 Extrair tudo', 'green', run);
  const viewBtn = btn('📋 Ver resultados', 'blue', () => openResults());
  viewBtn.hidden = true;
  const clearBtn = btn('Limpar', 'ghost', () => { S.cols = []; resetCard(); renderCols(); setStatus('Mapeamento limpo.'); });
  const statusEl = h('div', { class: 'status', text: 'Clique em 🎯 Card ou mapeie a primeira coluna dentro de um card.' });
  const ov = h('div', { class: 'ov', hidden: true });

  const panel = h('div', { class: 'panel' },
    h('div', { class: 'head' }, h('b', { text: '⚡ Scraper Universal' }), h('button', { class: 'x', text: '✕', onclick: destroy })),
    h('div', { class: 'row' }, nameIn, addBtn),
    h('div', { class: 'row' }, modeSel, scopeSel, cardBtn),
    colsBox,
    h('div', { class: 'opts' },
      h('label', {}, dedupeIn, 'Sem duplicatas'),
      h('label', {}, 'Espera (ms)', waitIn),
      clearBtn),
    runBtn, viewBtn, statusEl);
  root.append(panel, ov);
  document.body.append(host);

  const setStatus = (t) => { statusEl.textContent = t; };

  function renderCols() {
    colsBox.replaceChildren(...(S.cols.length
      ? S.cols.map((c) => h('div', { class: 'col' },
          h('b', { text: c.name }),
          h('span', { class: 'tag', text: `${SCOPE_LABEL[c.scope]} · ${c.mode === 'auto' ? c.sig.tag.toLowerCase() : c.mode}` }),
          h('button', { class: 'x', title: 'Remover', text: '🗑', onclick: () => {
            S.cols = S.cols.filter((x) => x.id !== c.id);
            if (!S.cols.length) resetCard();
            renderCols();
          } })))
      : [h('span', { class: 'muted', text: 'Nenhuma coluna mapeada.' })]));
    runBtn.disabled = !S.running && !S.cols.length;
    addBtn.disabled = S.running;
    cardBtn.disabled = S.running;
  }

  function setRunning(b) {
    S.running = b;
    runBtn.textContent = b ? '⏹ Parar' : '🚀 Extrair tudo';
    renderCols();
  }

  // ───────────────────────── Mapeamento do DOM ─────────────────────────
  const ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-automation-id', 'itemprop'];

  // Ignora classes de estado/dinâmicas (active, hover, hashes numéricos...)
  const stableClasses = (el) => [...el.classList]
    .filter((c) => !/\d{4,}|^(active|selected|open|opened|hover|focus|visible|loaded|is-|has-)/i.test(c))
    .sort();

  // Assinatura = tag + classes estáveis + (se existir) atributo de teste estável
  const sig = (el) => {
    let attr = null;
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && !/\d{3,}/.test(v)) { attr = [a, v]; break; }
    }
    return { tag: el.tagName, classes: stableClasses(el), attr };
  };
  const specific = (s) => s.classes.length > 0 || !!s.attr;
  const matches = (el, s) => !!el && !!s && el.tagName === s.tag
    && s.classes.every((c) => el.classList.contains(c))
    && (!s.attr || el.getAttribute(s.attr[0]) === s.attr[1]);
  const selOf = (s) => s.tag.toLowerCase()
    + s.classes.map((c) => '.' + CSS.escape(c)).join('')
    + (s.attr ? `[${s.attr[0]}="${s.attr[1].replace(/["\\]/g, '\\$&')}"]` : '');
  const size = (el) => el.getElementsByTagName('*').length;
  const similar = (a, b) => a === b || Math.min(a, b) / Math.max(a, b) >= 0.5;

  // Sobe a partir do elemento clicado até achar um ancestral que se repete
  // entre os irmãos com estrutura parecida (= o "card")
  function findCard(el) {
    let cur = el.parentElement;
    for (let i = 0; i < 10 && cur && cur.parentElement && cur !== document.body; i++, cur = cur.parentElement) {
      const s = sig(cur);
      const n = size(cur);
      const twin = [...cur.parentElement.children].some((c) => c !== cur && matches(c, s) && similar(n, size(c)));
      if (twin) return cur;
    }
    return el.parentElement || el;
  }

  function closestCard(el) {
    if (!S.sig) return null;
    for (let c = el; c; c = c.parentElement) if (matches(c, S.sig)) return c;
    return null;
  }

  function resetCard() { S.card = null; S.sig = null; }

  function getCards() {
    if (!S.sig) return [];
    let list;
    if (specific(S.sig)) list = [...document.querySelectorAll(selOf(S.sig))];
    else if (S.card && S.card.parentElement) list = [...S.card.parentElement.children].filter((c) => matches(c, S.sig));
    else list = [];
    // só os mais externos e nunca o próprio painel
    return list.filter((c) => !host.contains(c) && !list.some((o) => o !== c && o.contains(c)));
  }

  // Elementos com a mesma assinatura que NÃO estão dentro de nenhum card
  function outsideList(s) {
    return [...document.querySelectorAll(selOf(s))].filter((n) => !host.contains(n) && !closestCard(n));
  }

  // Último elemento da lista (em ordem de documento) que vem ANTES do card
  function precedingIn(list, card) {
    let lo = 0, hi = list.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = list[mid];
      if ((n.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) && !n.contains(card)) { ans = n; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  function relPath(card, el) {
    const path = [];
    for (let c = el; c && c !== card; c = c.parentElement) {
      const p = c.parentElement;
      if (!p) return null;
      path.unshift({ tag: c.tagName, i: [...p.children].filter((x) => x.tagName === c.tagName).indexOf(c) });
    }
    return path;
  }

  function resolvePath(card, path) {
    let cur = card;
    for (const st of path) {
      if (!cur) return null;
      cur = [...cur.children].filter((c) => c.tagName === st.tag)[st.i] || null;
    }
    return cur;
  }

  // Caminho exato primeiro; se a estrutura variar, tenta pela assinatura do alvo
  function resolveNode(card, col) {
    const n = resolvePath(card, col.path);
    if (n && matches(n, col.sig)) return n;
    if (!specific(col.sig)) return n;
    const all = card.querySelectorAll(selOf(col.sig));
    return all[col.ord] || all[0] || null;
  }

  // Seletor CSS absoluto (para colunas "fixas" fora de qualquer card)
  function cssPath(el) {
    const parts = [];
    for (let c = el; c && c.nodeType === 1 && c !== document.documentElement; c = c.parentElement) {
      if (c.id && document.querySelectorAll('#' + CSS.escape(c.id)).length === 1) { parts.unshift('#' + CSS.escape(c.id)); break; }
      const p = c.parentElement;
      const same = p ? [...p.children].filter((x) => x.tagName === c.tagName) : [c];
      parts.unshift(c.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(c) + 1})` : ''));
    }
    return parts.join('>');
  }

  function resolveGlobal(col) {
    let n = null;
    try { n = document.querySelector(col.css); } catch (_) {}
    if (n && matches(n, col.sig)) return n;
    return outsideList(col.sig)[col.ord] || null;
  }

  // Decide o escopo quando o clique caiu FORA de um card
  function inferScope(el) {
    const n = outsideList(sig(el)).length;
    const cards = getCards().length;
    if (n <= 1) return 'global';        // aparece uma vez só: valor fixo da página
    if (n === cards) return 'index';    // um por card, em outra lista: casa por posição
    return 'context';                   // menos que os cards: título/seção que vale para os cards seguintes
  }

  // ───────────────────────── Inspetor (clique/hover) ─────────────────────────
  const PICK_EVTS = ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'click'];
  const pageTarget = (e) => {
    const path = e.composedPath();
    const t = path[0];
    return t instanceof Element && !path.includes(host) ? t : null;
  };

  function box(el) {
    const r = el.getBoundingClientRect();
    ov.style.left = r.left + 'px'; ov.style.top = r.top + 'px';
    ov.style.width = r.width + 'px'; ov.style.height = r.height + 'px';
    ov.hidden = false;
  }

  function onHover(e) { const t = pageTarget(e); if (t) box(t); }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    stopInspect(); S.pending = null; setStatus('Mapeamento cancelado.');
  }
  function onPick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    const el = pageTarget(e);
    stopInspect();
    if (el) registerColumn(el);
  }

  function startInspect() {
    document.addEventListener('mouseover', onHover, true);
    document.addEventListener('keydown', onKey, true);
    PICK_EVTS.forEach((t) => document.addEventListener(t, onPick, { capture: true, passive: false }));
  }
  function stopInspect() {
    document.removeEventListener('mouseover', onHover, true);
    document.removeEventListener('keydown', onKey, true);
    PICK_EVTS.forEach((t) => document.removeEventListener(t, onPick, true));
    ov.hidden = true;
  }

  function startPick() {
    const name = clean(nameIn.value);
    if (!name) return setStatus('⚠️ Digite um nome para a coluna.');
    if (S.cols.some((c) => c.name.toLowerCase() === name.toLowerCase())) return setStatus('⚠️ Já existe uma coluna com esse nome.');
    S.pending = { name, mode: modeSel.value, scope: scopeSel.value };
    setStatus(`👉 Clique no elemento da coluna "${name}" (Esc cancela)`);
    startInspect();
  }

  function startPickCard() {
    S.pending = { cardOnly: true };
    setStatus('👉 Clique em qualquer elemento DENTRO de um card (Esc cancela)');
    startInspect();
  }

  function registerColumn(el) {
    const p = S.pending;
    S.pending = null;
    if (!p) return;

    // Definir/trocar o card (zera as colunas, pois os caminhos dependem dele)
    if (p.cardOnly) {
      S.card = findCard(el);
      S.sig = sig(S.card);
      S.cols = [];
      renderCols();
      box(S.card);
      setTimeout(() => { ov.hidden = true; }, 700);
      return setStatus(`🎯 Card definido · ${getCards().length} cards detectados. Agora mapeie as colunas.`);
    }

    let scope = p.scope;
    if (!S.card) {
      if (scope !== 'auto' && scope !== 'card') return setStatus('⚠️ Defina o card primeiro (🎯 Card).');
      S.card = findCard(el);
      S.sig = sig(S.card);
      scope = 'card';
    }

    const inCard = closestCard(el);
    if (scope === 'auto') scope = inCard ? 'card' : inferScope(el);
    if (scope === 'card' && !inCard) return setStatus('⚠️ Para "No card", clique dentro de um card.');
    if (scope !== 'card' && inCard) return setStatus('⚠️ Esse elemento está dentro de um card; use "No card".');

    const s = sig(el);
    const col = { id: Date.now() + Math.random(), name: p.name, mode: p.mode, scope, sig: s };
    const nCards = getCards().length;
    let info;

    if (scope === 'card') {
      col.path = relPath(inCard, el);
      col.ord = [...inCard.querySelectorAll(selOf(s))].indexOf(el);
      info = `${nCards} cards`;
    } else {
      const list = outsideList(s);
      col.ord = list.indexOf(el);
      if (scope === 'global') {
        col.css = cssPath(el);
        info = `valor fixo: "${readNode(el, p.mode).slice(0, 40)}"`;
      } else if (scope === 'context') {
        info = `${list.length} títulos/seções para ${nCards} cards`;
      } else {
        info = `${list.length} elementos × ${nCards} cards` + (list.length !== nCards ? ' ⚠️ quantidades diferentes' : '');
      }
      if (!specific(s)) info += ' ⚠️ elemento sem classe: pode capturar demais';
    }

    S.cols.push(col);
    nameIn.value = '';
    renderCols();
    box(inCard || el);
    setTimeout(() => { ov.hidden = true; }, 700);
    setStatus(`✔ "${col.name}" (${SCOPE_LABEL[scope]}) · ${info}`);
  }

  // ───────────────────────── Leitura de valores ─────────────────────────
  function imgUrl(node) {
    const img = node.tagName === 'IMG' ? node : node.querySelector && node.querySelector('img');
    if (img) {
      const cands = [img.currentSrc, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'),
        img.getAttribute('data-original'), img.getAttribute('src')];
      for (const u of cands) if (u && !u.startsWith('data:')) return abs(u);
      const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (ss) return abs(ss.split(',').pop().trim().split(/\s+/)[0]);
    }
    const m = getComputedStyle(node).backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
    return m ? abs(m[2]) : '';
  }

  function readNode(node, mode) {
    if (!node) return '';
    if (mode === 'img' || (mode === 'auto' && (node.tagName === 'IMG' || node.tagName === 'PICTURE'))) return imgUrl(node);
    if (mode === 'link') { const a = node.closest('a') || node.querySelector('a'); return a ? a.href : ''; }
    return clean(node.innerText || node.textContent);
  }

  // ───────────────────────── Coleta ─────────────────────────
  // Lê os cards que estão no DOM agora. Cada elemento vira um registro e é
  // completado em varreduras seguintes (lazy loading); se o elemento for
  // reaproveitado para outro conteúdo (listas virtualizadas), vira registro novo.
  function harvest() {
    const cards = getCards();
    const lists = S.cols.map((c) => (c.scope === 'context' || c.scope === 'index') ? outsideList(c.sig) : null);
    S.cols.forEach((c) => {
      if (c.scope !== 'global') return;
      const v = readNode(resolveGlobal(c), c.mode);
      if (v) c.last = v;
    });
    const hasOwn = S.cols.some((c) => c.scope === 'card');

    cards.forEach((card, k) => {
      const vals = S.cols.map((c, i) => {
        if (c.scope === 'global') return c.last || '';
        if (c.scope === 'index') return readNode(lists[i][k], c.mode);
        if (c.scope === 'context') return readNode(precedingIn(lists[i], card), c.mode);
        return readNode(resolveNode(card, c), c.mode);
      });
      // Só conta se o próprio card trouxe algo (contexto/fixo sozinhos não criam linha)
      const ok = hasOwn ? S.cols.some((c, i) => c.scope === 'card' && vals[i]) : vals.some(Boolean);
      if (!ok) return;

      const prev = S.byEl.get(card);
      if (prev && prev.vals.every((v, i) => !v || !vals[i] || v === vals[i])) {
        vals.forEach((v, i) => { if (!prev.vals[i] && v) prev.vals[i] = v; });
        return;
      }
      const rec = { vals };
      S.recs.push(rec);
      S.byEl.set(card, rec);
    });
  }

  function scrollParent(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 20) return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function crawl() {
    const sp = S.card && S.card.isConnected ? scrollParent(S.card) : (document.scrollingElement || document.documentElement);
    const origTop = sp.scrollTop;
    sp.scrollTo({ top: 0, behavior: 'instant' });
    await delay(OPTS.wait);

    let still = 0, lastH = -1, steps = 0;
    const t0 = Date.now();
    while (!S.abort && steps < OPTS.maxSteps && Date.now() - t0 < OPTS.maxMs) {
      steps++;
      harvest();
      setStatus(`Varrendo… ${S.recs.length} registros`);
      const atBottom = sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 4;
      if (atBottom) {
        still = sp.scrollHeight === lastH ? still + 1 : 0;
        if (still >= 3) break; // 3 rodadas no fim sem crescer = acabou
      } else still = 0;
      lastH = sp.scrollHeight;
      sp.scrollBy({ top: Math.max(200, sp.clientHeight * 0.8), behavior: 'instant' });
      await delay(OPTS.wait);
    }
    harvest();
    sp.scrollTo({ top: origTop, behavior: 'instant' });
    return steps;
  }

  async function run() {
    if (S.running) { S.abort = true; return; }
    if (!getCards().length) return setStatus('⚠️ Nenhum card encontrado. A página mudou? Use "Limpar" e mapeie de novo.');
    OPTS.wait = Math.min(5000, Math.max(100, +waitIn.value || 400));
    S.abort = false; S.recs = []; S.byEl = new Map();
    S.cols.forEach((c) => { c.last = ''; });
    setRunning(true);
    const t0 = Date.now();
    let steps = 0;
    try { steps = await crawl(); } catch (err) { console.error('[Scraper]', err); setStatus('❌ Erro: ' + err.message); }

    const total = S.recs.length;
    let rows = S.recs.map((r) => r.vals);
    if (dedupeIn.checked) {
      const seen = new Set();
      rows = rows.filter((v) => { const k = v.join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    S.headers = S.cols.map((c) => c.name);
    S.rows = rows;
    S.byEl.clear(); // libera referências ao DOM
    window.__uniData = toObjects();

    // Telemetria: quanto cada coluna ficou vazia (ajuda a achar mapeamento ruim)
    const empty = Object.fromEntries(S.cols.map((c, i) => [
      `${c.name} (${c.scope})`,
      rows.length ? Math.round(100 * rows.filter((r) => !r[i]).length / rows.length) + '% vazio' : '-'
    ]));
    console.info('[Scraper]', { registros: rows.length, duplicados: total - rows.length, passos: steps, ms: Date.now() - t0, interrompido: S.abort });
    console.table(empty);

    setRunning(false);
    const dup = total - rows.length;
    setStatus(`${S.abort ? '⏹ Interrompido' : '✅ Concluído'}: ${rows.length} registros` + (dup ? ` (${dup} duplicados removidos)` : ''));
    viewBtn.hidden = !rows.length;
    if (rows.length) openResults();
  }

  const toObjects = () => S.rows.map((r) => Object.fromEntries(S.headers.map((hd, i) => [hd, r[i]])));

  // ───────────────────────── Resultados ─────────────────────────
  let modal = null;
  function closeResults() { if (modal) { modal.remove(); modal = null; } }

  function openResults() {
    closeResults();
    const tbody = h('tbody');
    const count = h('b');

    const paint = () => {
      count.textContent = `📦 ${S.rows.length} registros`;
      viewBtn.textContent = `📋 Ver resultados (${S.rows.length})`;
      const frag = document.createDocumentFragment();
      S.rows.forEach((row, r) => frag.append(h('tr', {},
        h('td', { class: 'act' }, h('button', { class: 'x', text: '✕', title: 'Remover linha', 'data-r': r })),
        ...row.map((v, c) => h('td', { contenteditable: 'true', 'data-r': r, 'data-c': c, text: v })))));
      tbody.replaceChildren(frag);
    };

    tbody.addEventListener('input', (e) => {
      const td = e.target.closest && e.target.closest('td[data-c]');
      if (td) S.rows[+td.dataset.r][+td.dataset.c] = td.textContent.trim();
    });
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('button[data-r]');
      if (b) { S.rows.splice(+b.dataset.r, 1); window.__uniData = toObjects(); paint(); }
    });

    modal = h('div', { class: 'modal' },
      h('div', { class: 'mh' }, count,
        h('div', { class: 'row' },
          btn('Copiar (Excel)', 'blue', copyTSV),
          btn('CSV', 'green', exportCSV),
          btn('XLSX', 'green', exportXLSX),
          btn('JSON', 'blue', exportJSON),
          btn('Minimizar', 'ghost', closeResults))),
      h('div', { class: 'mb' },
        h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: '' }), ...S.headers.map((x) => h('th', { text: x })))), tbody)));
    root.append(modal);
    paint();
  }

  // ───────────────────────── Exportação ─────────────────────────
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  function download(blob, name) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500); // revogar na hora pode cancelar o download
  }

  async function copyTSV() {
    const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');
    const text = [S.headers, ...S.rows].map((r) => r.map(cell).join('\t')).join('\n');
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setStatus('📋 Copiado! Cole direto no Excel.');
  }

  function exportJSON() {
    download(new Blob([JSON.stringify(toObjects(), null, 2)], { type: 'application/json' }), `extracao_${stamp()}.json`);
  }

  function exportCSV() {
    // Neutraliza células que o Excel interpretaria como fórmula
    const q = (v) => {
      let s = String(v ?? '');
      if (/^[=@\t\r]|^[+\-](?!\d)/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const csv = [S.headers, ...S.rows].map((r) => r.map(q).join(';')).join('\r\n');
    download(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }), `extracao_${stamp()}.csv`);
  }

  // XLSX real (ZIP sem compressão + OOXML mínimo), sem bibliotecas
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

  function zip(files) {
    const enc = new TextEncoder();
    const le = (...f) => { const b = []; for (const [n, sz] of f) for (let i = 0; i < sz; i++) b.push((n >>> (8 * i)) & 255); return new Uint8Array(b); };
    const parts = [], cd = [];
    let off = 0, cdSize = 0;
    for (const f of files) {
      const name = enc.encode(f.name), size = f.data.length, crc = crc32(f.data);
      const local = le([0x04034b50, 4], [20, 2], [0x0800, 2], [0, 2], [0, 2], [0x21, 2], [crc, 4], [size, 4], [size, 4], [name.length, 2], [0, 2]);
      const cen = le([0x02014b50, 4], [20, 2], [20, 2], [0x0800, 2], [0, 2], [0, 2], [0x21, 2], [crc, 4], [size, 4], [size, 4], [name.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4], [off, 4]);
      parts.push(local, name, f.data);
      cd.push(cen, name);
      off += local.length + name.length + size;
      cdSize += cen.length + name.length;
    }
    const end = le([0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [cdSize, 4], [off, 4], [0, 2]);
    return new Blob([...parts, ...cd, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function exportXLSX() {
    const enc = new TextEncoder();
    const bad = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
    const X = (s) => String(s ?? '').replace(bad, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const L = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
    const hdr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const rowsXml = [S.headers, ...S.rows].map((row, r) =>
      `<row r="${r + 1}">${row.map((v, c) => `<c r="${L(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${X(v)}</t></is></c>`).join('')}</row>`).join('');
    const files = [
      ['[Content_Types].xml', `${hdr}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
      ['_rels/.rels', `${hdr}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `${hdr}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dados" sheetId="1" r:id="rId1"/></sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `${hdr}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
      ['xl/worksheets/sheet1.xml', `${hdr}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`]
    ].map(([name, xml]) => ({ name, data: enc.encode(xml) }));
    download(zip(files), `extracao_${stamp()}.xlsx`);
  }

  // ───────────────────────── Encerramento ─────────────────────────
  function destroy() {
    S.abort = true;
    stopInspect();
    closeResults();
    host.remove();
    delete window.__uniDestroy;
  }
  window.__uniDestroy = destroy;

  renderCols();
})();
