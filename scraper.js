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
      const ok =
