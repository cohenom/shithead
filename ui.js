/*
 * ui.js — everything that touches the DOM.
 *
 * Rendering is a plain re-render of the whole board from state; continuity of
 * motion comes from FLIP: snapshot every card's rect before the state changes,
 * re-render, then animate each card from where it used to be. Cards that are
 * new to the board animate in from a source rect the caller nominates (the
 * stock, the pile, an opponent's seat), which is what makes deals, draws and
 * pick-ups read as physical movement rather than a pop.
 *
 * Gesture-driven motion (dragging a card) uses a real spring integrator so it
 * can be grabbed, thrown and reversed at any moment; scripted feedback
 * (flying cards, burns, toasts) uses WAAPI with an iOS-flavoured ease.
 */

import { SUIT_GLYPH, SUIT_COLOR, rankLabel } from './game.js';

export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * Animations must never be able to hold the game hostage. A Web Animations
 * `finished` promise can stay pending forever (element detached mid-flight,
 * the page throttled in a background tab), and anything awaiting it would
 * freeze the turn loop. Every animation wait is therefore a race against a
 * deadline slightly longer than the animation itself.
 */
function within(promise, ms) {
  return Promise.race([
    promise.catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);
}
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const EASE_POP = 'cubic-bezier(0.34, 1.28, 0.44, 1)';

const $ = (id) => document.getElementById(id);
export const els = {};
let handlers = {};

export function initUI(h) {
  handlers = h;
  for (const id of ['topbar', 'status', 'btn-new', 'btn-rules', 'opponents', 'table',
    'deck', 'deck-cards', 'deck-count', 'discard', 'discard-cards', 'discard-ghost',
    'discard-label', 'burn', 'burn-cards', 'burn-count', 'me', 'my-stacks', 'my-hand',
    'actionbar', 'btn-action', 'btn-secondary', 'fx', 'toasts']) {
    els[id] = $(id);
  }
  attachDrag(els['my-hand']);
  attachDrag(els['my-stacks']);
  initSheets();
}

/* ------------------------------------------------------------- cards ----- */

function cardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (opts.mini ? ' mini' : '');
  if (opts.fid) el.dataset.fid = opts.fid;
  // `card.hidden` is a redacted placeholder from an online party — a card we
  // know is there but are not entitled to see. It renders exactly like any
  // other back, and carries no data-id, so it can never be grabbed or played.
  if (!card || card.hidden) {
    el.classList.add('back');
    return el;
  }
  el.dataset.id = card.id;
  el.dataset.rank = card.r;
  if (SUIT_COLOR[card.s] === 'red') el.classList.add('red');
  const corner = document.createElement('div');
  corner.className = 'c-corner';
  corner.innerHTML = `<span class="c-rank">${rankLabel(card.r)}</span><span class="c-suit">${SUIT_GLYPH[card.s]}</span>`;
  const pip = document.createElement('div');
  pip.className = 'c-pip';
  pip.textContent = SUIT_GLYPH[card.s];
  el.append(corner, pip);
  el.setAttribute('aria-label', `${rankLabel(card.r)} of ${{ C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' }[card.s]}`);
  return el;
}

/** Stable, tiny hash → the same card always sits at the same jaunty angle. */
function tilt(id, spread = 5) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return ((h % 1000) / 1000 - 0.5) * 2 * spread;
}

/* ------------------------------------------------------------ render ----- */

/**
 * @param {{state:object, you:number, mode:'swap'|'play'|'over', selection:Set<string>,
 *          swapPicks:(string|null)[], thinking:number|null, legal:Set<string>,
 *          interactive:boolean}} v
 */
export function renderBoard(v) {
  renderOpponents(v);
  renderTable(v);
  renderMine(v);
}

function renderOpponents(v) {
  const wrap = els.opponents;
  wrap.textContent = '';
  const { state, you } = v;
  wrap.classList.toggle('many', state.players.length > 3);
  for (const p of state.players) {
    if (p.index === you) continue;
    const box = document.createElement('div');
    box.className = 'opp';
    box.dataset.p = p.index;
    if (state.phase === 'playing' && state.current === p.index) box.classList.add('is-turn');
    if (p.finishedAt !== null) box.classList.add('is-out');
    if (p.connected === false) box.classList.add('is-offline');

    const head = document.createElement('div');
    head.className = 'opp-head';
    const name = document.createElement('span');
    name.className = 'opp-name';
    name.textContent = p.name;
    head.append(name);
    if (v.thinking === p.index) {
      const t = document.createElement('span');
      t.className = 'thinking';
      t.innerHTML = '<i></i><i></i><i></i>';
      head.append(t);
    }
    const badge = document.createElement('span');
    badge.className = 'opp-badge';
    if (p.finishedAt !== null) {
      badge.classList.add('opp-place');
      badge.textContent = ordinal(p.finishedAt + 1);
    } else {
      badge.textContent = p.hand.length + p.faceUp.length + p.blind.length;
    }
    head.append(badge);

    const rows = document.createElement('div');
    rows.className = 'opp-rows';

    const stacks = document.createElement('div');
    stacks.className = 'opp-row stacks';
    for (let i = 0; i < 3; i++) {
      const slot = document.createElement('div');
      slot.className = 'opp-stack';
      if (p.blind[i]) slot.append(cardEl(null, { mini: true, fid: `b${p.index}-${i}` }));
      if (p.faceUp[i]) slot.append(cardEl(p.faceUp[i], { mini: true, fid: p.faceUp[i].id }));
      if (p.blind[i] || p.faceUp[i]) stacks.append(slot);
    }
    if (stacks.children.length) rows.append(stacks);

    const hand = document.createElement('div');
    hand.className = 'opp-row hand';
    for (let i = 0; i < Math.min(p.hand.length, 7); i++) {
      hand.append(cardEl(null, { mini: true, fid: `h${p.index}-${i}` }));
    }
    if (p.hand.length) rows.append(hand);

    box.append(head, rows);
    wrap.append(box);
  }
}

function renderTable(v) {
  const { state } = v;

  // stock
  els['deck-cards'].textContent = '';
  for (let i = 0; i < Math.min(state.deck.length, 3); i++) {
    const c = cardEl(null, { fid: `deck-${i}` });
    c.style.transform = `translate(${i * -1.5}px, ${i * -1.5}px)`;
    els['deck-cards'].append(c);
  }
  els['deck-count'].textContent = state.deck.length;

  // burned
  els['burn-cards'].textContent = '';
  for (let i = 0; i < Math.min(Math.ceil(state.burned.length / 6), 3); i++) {
    const c = cardEl(null, { fid: `burn-${i}` });
    c.style.transform = `translate(${i * -1.5}px, ${i * -1.5}px) rotate(${i * 3 - 3}deg)`;
    c.style.opacity = '0.45';
    els['burn-cards'].append(c);
  }
  els['burn-count'].textContent = state.burned.length;

  // discard
  const dc = els['discard-cards'];
  dc.textContent = '';
  const shown = state.pile.slice(-4);
  shown.forEach((card, i) => {
    const el = cardEl(card, { fid: card.id });
    el.style.transform = `rotate(${tilt(card.id, i === shown.length - 1 ? 3.5 : 7)}deg)`;
    if (i < shown.length - 1) el.classList.add('dim');
    dc.append(el);
  });
  // Keep the table quiet until it has something to say.
  const burnSlot = els.burn.closest('.table-slot');
  if (burnSlot) burnSlot.hidden = state.burned.length === 0;
  els['discard-ghost'].hidden = state.pile.length > 0 || v.mode === 'swap';
  els['discard-label'].innerHTML = v.mode === 'swap' ? '' : pileLabel(v);
}

function pileLabel(v) {
  const { state } = v;
  const n = state.pile.length;
  if (!n) return 'Fresh pile';
  const top = state.pile[n - 1];
  let demand;
  if (top.r === 2) demand = 'anything goes';
  else if (top.r === 7) demand = '7 or lower';
  else demand = `${rankLabel(top.r)} or higher`;
  return `${n} card${n === 1 ? '' : 's'} · <span class="hint">${demand}</span>`;
}

function renderMine(v) {
  const { state, you, mode } = v;
  const me = state.players[you];

  // ---- the three stacks -------------------------------------------------
  const cap = document.getElementById('stacks-caption');
  if (cap) {
    if (mode === 'swap') cap.textContent = 'Your face-up row';
    else if (me.faceUp.length) cap.textContent = 'Face-up · blind beneath';
    else if (me.blind.length) cap.textContent = 'Blind cards';
    else cap.textContent = '';
  }
  const stacks = els['my-stacks'];
  stacks.textContent = '';
  for (let i = 0; i < 3; i++) {
    const slot = document.createElement('div');
    slot.className = 'my-slot';
    slot.dataset.slot = i;
    const blind = me.blind[i];
    if (blind) slot.append(cardEl(null, { fid: `b${you}-${i}`, faceDown: true }));

    if (mode === 'swap') {
      const pickId = v.swapPicks[i];
      if (pickId) {
        const card = me.hand.find((c) => c.id === pickId);
        if (card) {
          const el = cardEl(card, { fid: card.id });
          el.classList.add('faceup-on-blind', 'playable');
          slot.append(el);
        }
      } else {
        slot.classList.add('empty');
        if (v.swapNext === i) slot.classList.add('is-target');
      }
    } else {
      const up = me.faceUp[i];
      if (up) {
        const el = cardEl(up, { fid: up.id });
        el.classList.add('faceup-on-blind');
        markPlayability(el, up.id, v, 'faceUp');
        slot.append(el);
      } else if (!blind) {
        slot.classList.add('empty');
      }
      if (!me.hand.length && !me.faceUp.length && blind && v.interactive) {
        slot.classList.add('is-target');
        const el = slot.querySelector('.card');
        if (el) el.classList.add('playable');
      }
    }
    stacks.append(slot);
  }

  // ---- hand -------------------------------------------------------------
  const hand = els['my-hand'];
  hand.textContent = '';
  const cards = mode === 'swap'
    ? me.hand.filter((c) => !v.swapPicks.includes(c.id))
    : me.hand.slice().sort((a, b) => a.r - b.r || a.s.localeCompare(b.s));

  const plan = planHand(hand, cards.length);
  hand.style.setProperty('--hand-cw', `${plan.cw}px`);
  let i = 0;
  for (const count of plan.rows) {
    const row = document.createElement('div');
    row.className = 'hand-row';
    row.style.setProperty('--hand-gap', `${gapFor(count, plan.cw, plan.avail)}px`);
    for (let k = 0; k < count; k++, i++) {
      const c = cards[i];
      const el = cardEl(c, { fid: c.id });
      if (mode === 'swap') el.classList.add('playable');
      else markPlayability(el, c.id, v, 'hand');
      if (v.selection.has(c.id)) el.classList.add('selected');
      row.append(el);
    }
    hand.append(row);
  }
}

function markPlayability(el, id, v, zone) {
  // Only editorialise about legality on the player's own turn — dimming the
  // whole hand while a bot thinks is noise.
  if (v.state.phase !== 'playing' || v.state.current !== v.you) return;
  if (v.activeZone !== zone) { el.classList.add('dim'); return; }
  if (v.legal.has(id)) el.classList.add('playable');
  else el.classList.add('unplayable');
}

const OVERLAP = -0.66;     // tightest margin ratio: the rank corner must survive
const MIN_SLIVER = 26;     // px of each card you can actually see and hit

/**
 * Fan the hand so it always fits the width and stays touchable. Cards overlap
 * first; when the visible sliver of each card would fall below a hittable size
 * the hand wraps onto a second (then third) row rather than shaving the cards
 * down to unusable splinters. Measured against the viewport rather than the
 * container, so an overflowing row can never feed its own overflow back in.
 */
function planHand(hand, n) {
  const avail = Math.min(hand.parentElement.clientWidth || Infinity, window.innerWidth) - 20;
  const base = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 80;
  if (n < 1) return { rows: [], cw: base, avail };

  let rowCount = 1;
  let cw = base;
  for (; rowCount <= 3; rowCount++) {
    const per = Math.ceil(n / rowCount);
    // multi-row hands get shorter cards so two rows still fit the thumb zone
    const cap = rowCount === 1 ? base : base * 0.66;
    cw = Math.min(cap, avail / Math.max(1, per + (per - 1) * OVERLAP));
    if (per === 1 || cw * (1 + OVERLAP) >= MIN_SLIVER || rowCount === 3) break;
  }
  rowCount = Math.min(rowCount, 3);

  const rows = [];
  const per = Math.ceil(n / rowCount);
  let left = n;
  for (let r = 0; r < rowCount && left > 0; r++) {
    const take = Math.min(per, left);
    rows.push(take);
    left -= take;
  }
  return { rows, cw: Math.max(28, cw), avail };
}

function gapFor(count, cw, avail) {
  if (count < 2) return 0;
  return Math.max(OVERLAP * cw, Math.min(8, (avail - count * cw) / (count - 1)));
}

export function ordinal(n) {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teens ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suffix;
}

/* -------------------------------------------------------------- FLIP ----- */

export function snapshot() {
  const m = new Map();
  for (const el of document.querySelectorAll('[data-fid]')) {
    m.set(el.dataset.fid, el.getBoundingClientRect());
  }
  return m;
}

function baseTransform(el) {
  const t = getComputedStyle(el).transform;
  return !t || t === 'none' ? '' : ` ${t}`;
}

/**
 * Animate every card from where it was to where it now is.
 * @param {Map<string,DOMRect>} prev
 * @param {(el:Element,fid:string)=>DOMRect|null} [enterFrom] source for new cards
 */
export function flipFrom(prev, enterFrom, opts = {}) {
  const dur = reduced.matches ? 1 : (opts.duration ?? 420);
  const anims = [];
  for (const el of document.querySelectorAll('[data-fid]')) {
    const fid = el.dataset.fid;
    const r1 = el.getBoundingClientRect();
    if (!r1.width) continue;
    let r0 = prev.get(fid);
    let entering = false;
    if (!r0) {
      entering = true;
      r0 = enterFrom ? enterFrom(el, fid) : null;
      if (!r0 || !r0.width) continue;
    }
    const dx = (r0.left + r0.width / 2) - (r1.left + r1.width / 2);
    const dy = (r0.top + r0.height / 2) - (r1.top + r1.height / 2);
    const sc = r0.width / r1.width;
    if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6 && Math.abs(sc - 1) < 0.015) continue;
    const base = baseTransform(el);
    const a = el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sc})${base}`, opacity: entering ? 0.6 : 1, offset: 0 },
        { transform: `translate(0,0) scale(1)${base}`, opacity: 1, offset: 1 },
      ],
      {
        duration: dur,
        delay: opts.stagger ? Math.min(anims.length * opts.stagger, 600) : 0,
        easing: opts.easing || EASE,
        fill: opts.stagger ? 'backwards' : 'none',
      },
    );
    if (entering) el.style.zIndex = '3';
    anims.push(a.finished.catch(() => {}));
  }
  return within(Promise.all(anims), dur + (opts.stagger ? 700 : 0) + 500);
}

/* ---------------------------------------------------- scripted effects --- */

export function rectOf(el) {
  return el ? el.getBoundingClientRect() : null;
}
export function discardRect() { return els.discard.getBoundingClientRect(); }
export function deckRect() { return els.deck.getBoundingClientRect(); }
export function seatRect(state, you, playerIndex) {
  if (playerIndex === you) return els['my-hand'].getBoundingClientRect();
  const box = els.opponents.querySelector(`.opp[data-p="${playerIndex}"]`);
  return box ? box.getBoundingClientRect() : els.opponents.getBoundingClientRect();
}
export function slotRect(i) {
  const s = els['my-stacks'].children[i];
  return s ? s.getBoundingClientRect() : null;
}

export function toast(html, { big = false, ms = 1500 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (big ? ' big' : '');
  t.innerHTML = html;
  els.toasts.append(t);
  const d = reduced.matches ? 1 : 260;
  t.animate([{ opacity: 0, transform: 'translateY(-14px) scale(0.94)' }, { opacity: 1, transform: 'none' }],
    { duration: d, easing: EASE_POP });
  setTimeout(() => {
    t.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }],
      { duration: reduced.matches ? 1 : 240, easing: 'ease-in' }).finished
      .catch(() => {}).then(() => t.remove());
  }, ms);
  return t;
}

/**
 * Fly free-standing copies of cards from wherever they are onto a target
 * (used when the real cards won't survive the next render — a burn, or a pile
 * disappearing into an opponent's hand).
 * Clones persist until clearFX() so the caller controls the hand-off.
 */
export function flyCards(items, toRect, opts = {}) {
  const dur = reduced.matches ? 1 : (opts.duration ?? 340);
  const jobs = [];
  items.forEach((it, i) => {
    if (!it.rect || !toRect) return;
    const el = cardEl(it.card || null);
    el.style.position = 'absolute';
    el.style.setProperty('--cw', `${it.rect.width}px`);
    Object.assign(el.style, {
      left: `${it.rect.left}px`, top: `${it.rect.top}px`,
      width: `${it.rect.width}px`, height: `${it.rect.height}px`,
    });
    els.fx.append(el);
    const sc = toRect.width / it.rect.width;
    const spread = (i - (items.length - 1) / 2) * (opts.spread ?? 10);
    const dx = toRect.left + toRect.width / 2 - (it.rect.left + it.rect.width / 2) + spread;
    const dy = toRect.top + toRect.height / 2 - (it.rect.top + it.rect.height / 2);
    jobs.push(el.animate(
      [
        { transform: 'translate(0,0) scale(1) rotate(0deg)' },
        { transform: `translate(${dx}px, ${dy}px) scale(${sc}) rotate(${tilt(it.card?.id || String(i))}deg)` },
      ],
      { duration: dur, delay: i * (opts.stagger ?? 40), easing: EASE, fill: 'forwards' },
    ).finished.catch(() => {}));
  });
  return within(Promise.all(jobs), dur + items.length * (opts.stagger ?? 40) + 500);
}

export function clearFX() { els.fx.textContent = ''; }

/** Satisfying little detonation over the pile. */
export function burnFX(rect) {
  if (!rect) return Promise.resolve();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (reduced.matches) {
    const f = document.createElement('div');
    f.className = 'flash';
    Object.assign(f.style, { left: `${cx - 60}px`, top: `${cy - 60}px`, width: '120px', height: '120px' });
    els.fx.append(f);
    return within(f.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 260 }).finished
      .catch(() => {}).then(() => f.remove()), 700);
  }

  const done = [];
  const size = Math.max(rect.width, rect.height) * 2.2;
  const flash = document.createElement('div');
  flash.className = 'flash';
  Object.assign(flash.style, {
    left: `${cx - size / 2}px`, top: `${cy - size / 2}px`, width: `${size}px`, height: `${size}px`,
  });
  els.fx.append(flash);
  done.push(flash.animate(
    [{ transform: 'scale(0.25)', opacity: 0 }, { transform: 'scale(0.8)', opacity: 1, offset: 0.22 }, { transform: 'scale(1.5)', opacity: 0 }],
    { duration: 620, easing: 'ease-out' },
  ).finished.catch(() => {}).then(() => flash.remove()));

  for (let i = 0; i < 12; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 60 + Math.random() * 90;
    Object.assign(s.style, { left: `${cx - 4}px`, top: `${cy - 4}px` });
    els.fx.append(s);
    done.push(s.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist + 26}px) scale(0.2)`, opacity: 0 },
      ],
      { duration: 520 + Math.random() * 260, easing: 'cubic-bezier(0.16,0.7,0.3,1)' },
    ).finished.catch(() => {}).then(() => s.remove()));
  }
  return within(Promise.all(done), 1400);
}

/** Turn a blind card over in place, for everyone to see. */
export function blindReveal(rect, card) {
  if (!rect) return Promise.resolve();
  const wrap = document.createElement('div');
  wrap.className = 'flip3d';
  Object.assign(wrap.style, {
    position: 'absolute',
    left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
  const face = cardEl(card);
  const back = cardEl(null);
  for (const f of [face, back]) {
    f.classList.add('face');
    f.style.width = '100%';
    f.style.height = '100%';
    f.style.setProperty('--cw', `${rect.width}px`);
  }
  back.classList.add('b');
  wrap.append(face, back);
  els.fx.append(wrap);

  const dur = reduced.matches ? 1 : 540;
  const anim = wrap.animate(
    [
      { transform: 'rotateY(180deg) scale(1)' },
      { transform: 'rotateY(90deg) scale(1.16)', offset: 0.5 },
      { transform: 'rotateY(0deg) scale(1.08)' },
    ],
    { duration: dur, easing: EASE },
  );
  return within(anim.finished.catch(() => {}), dur + 400)
    .then(() => new Promise((r) => setTimeout(r, reduced.matches ? 1 : 220)))
    .then(() => wrap.remove());
}

export function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  if (navigator.vibrate) { try { navigator.vibrate(18); } catch { /* ignore */ } }
  setTimeout(() => el.classList.remove('shake'), 460);
}

export function cardElById(id) {
  return document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
}

export function setStatus(text) { els.status.textContent = text; }

export function setActions({ primary, secondary, primaryEnabled = true }) {
  const a = els['btn-action'];
  const b = els['btn-secondary'];
  a.hidden = !primary;
  if (primary) { a.textContent = primary; a.disabled = !primaryEnabled; }
  b.hidden = !secondary;
  if (secondary) b.textContent = secondary;
}

/* ------------------------------------------------------------- drag ------ */

function translateOf(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

function attachDrag(root) {
  let drag = null;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    const el = e.target.closest('.card[data-id]');
    if (!el || !root.contains(el)) return;
    const id = el.dataset.id;
    if (!handlers.canGrab || !handlers.canGrab(id)) return;

    const base = translateOf(el);
    drag = {
      el, id, base,
      x0: e.clientX, y0: e.clientY,
      moved: false,
      hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    };
    el.setPointerCapture(e.pointerId);
    el.classList.add('pressed');           // response on pointer-down, not release
    e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    drag.hist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (drag.hist.length > 6) drag.hist.shift();

    if (!drag.moved && Math.hypot(dx, dy) > 8) {
      drag.moved = true;
      drag.el.classList.add('dragging');
      if (handlers.onGrab) handlers.onGrab(drag.id);
    }
    if (!drag.moved) return;

    drag.el.style.transform =
      `translate(${drag.base.x + dx}px, ${drag.base.y + dy}px) scale(1.07)`;

    drag.target = handlers.dropTargetAt?.(e.clientX, e.clientY, drag.id) || null;
    highlightTarget(drag.target, drag.id);
  });

  const finish = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('pressed');
    clearTargets();

    if (!d.moved) {
      d.el.style.transform = '';
      handlers.onTap?.(d.id, d.el);
      return;
    }

    d.el.classList.remove('dragging');
    const target = handlers.dropTargetAt?.(e.clientX, e.clientY, d.id) || null;
    const vel = velocityOf(d.hist);
    const cur = { x: d.base.x + (e.clientX - d.x0), y: d.base.y + (e.clientY - d.y0) };

    // Consumed by the drop? The re-render + FLIP carries the card onward from
    // exactly where the finger let go.
    if (target && handlers.onDrop?.(d.id, d.el, target)) return;
    if (target) shake(d.el);
    springHome(d.el, cur, d.base, vel);
  };

  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('pressed', 'dragging');
    clearTargets();
    springHome(d.el, translateOf(d.el), d.base, { x: 0, y: 0 });
  });
}

function clearTargets() {
  els.discard.classList.remove('drop-ok', 'drop-bad');
  for (const s of els['my-stacks'].querySelectorAll('.drop-hot')) s.classList.remove('drop-hot');
}

function highlightTarget(target, id) {
  clearTargets();
  if (!target) return;
  if (target.kind === 'discard') {
    const ok = !!handlers.wouldBeLegal?.(id);
    els.discard.classList.add(ok ? 'drop-ok' : 'drop-bad');
  } else if (target.kind === 'slot') {
    els['my-stacks'].children[target.index]?.classList.add('drop-hot');
  }
}

/** Is a point within `pad` of an element? Generous targets, per iOS. */
export function nearRect(el, x, y, pad = 34) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad;
}

function velocityOf(hist) {
  if (hist.length < 2) return { x: 0, y: 0 };
  const a = hist[0];
  const b = hist[hist.length - 1];
  const dt = Math.max(8, b.t - a.t) / 1000;
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}

/** Critically-ish damped spring home, carrying the release velocity. */
function springHome(el, from, to, vel) {
  if (reduced.matches) { el.style.transform = ''; return Promise.resolve(); }
  const damping = 0.82;
  const w = (2 * Math.PI) / 0.34;
  let x = from.x, y = from.y, s = 1.07;
  let vx = vel.x, vy = vel.y, vs = 0;
  let last = performance.now();
  el.style.willChange = 'transform';
  return new Promise((res) => {
    const step = (now) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      vx += (-2 * damping * w * vx - w * w * (x - to.x)) * dt;
      vy += (-2 * damping * w * vy - w * w * (y - to.y)) * dt;
      vs += (-2 * 1.0 * w * vs - w * w * (s - 1)) * dt;
      x += vx * dt; y += vy * dt; s += vs * dt;
      el.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      const settled = Math.hypot(x - to.x, y - to.y) < 0.5 && Math.hypot(vx, vy) < 14 && Math.abs(s - 1) < 0.004;
      if (settled) {
        el.style.transform = '';
        el.style.willChange = '';
        res();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/* ------------------------------------------------------------- sheets ---- */

const openSheets = [];

function initSheets() {
  for (const sheet of document.querySelectorAll('.sheet')) {
    sheet.querySelector('.sheet-scrim').addEventListener('click', () => {
      if (sheet.dataset.modal !== 'true') closeSheet(sheet.id);
    });
    attachSheetDrag(sheet);
  }
}

export function openSheet(id, { modal = false } = {}) {
  const sheet = $(id);
  if (!sheet || openSheets.includes(id)) return;
  sheet.hidden = false;
  sheet.dataset.modal = String(modal);
  openSheets.push(id);
  const panel = sheet.querySelector('.sheet-panel');
  const scrim = sheet.querySelector('.sheet-scrim');
  const dur = reduced.matches ? 1 : 460;
  scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dur, easing: EASE, fill: 'forwards' });
  scrim.style.opacity = '1';
  panel.animate(
    reduced.matches
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }],
    { duration: dur, easing: EASE },
  );
  const body = sheet.querySelector('.sheet-scroll');
  if (body) body.scrollTop = 0;
}

export function closeSheet(id) {
  const sheet = $(id);
  const i = openSheets.indexOf(id);
  if (!sheet || i === -1) return Promise.resolve();
  openSheets.splice(i, 1);
  const panel = sheet.querySelector('.sheet-panel');
  const scrim = sheet.querySelector('.sheet-scrim');
  const dur = reduced.matches ? 1 : 320;
  const from = translateOf(panel).y;
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: 'ease-in', fill: 'forwards' });
  const a = panel.animate(
    reduced.matches
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ transform: `translateY(${from}px)` }, { transform: 'translateY(101%)' }],
    { duration: dur, easing: 'cubic-bezier(0.4, 0, 1, 1)' },
  );
  return within(a.finished, dur + 400).then(() => {
    sheet.hidden = true;
    panel.style.transform = '';
    scrim.style.opacity = '0';
    handlers.onSheetClosed?.(id);
  });
}

export function sheetIsOpen(id) { return openSheets.includes(id); }

/** Clear the deck of sheets — nothing should ever stack over the result. */
export function closeAllSheets(except) {
  return Promise.all(openSheets.slice().filter((id) => id !== except).map(closeSheet));
}
export function anySheetOpen() { return openSheets.length > 0; }

/** Rubber-banded drag-to-dismiss, velocity aware. */
function attachSheetDrag(sheet) {
  const panel = sheet.querySelector('.sheet-panel');
  let d = null;

  panel.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, input')) return;
    const scroller = e.target.closest('.sheet-scroll');
    if (scroller && scroller.scrollTop > 0) return;
    d = { y0: e.clientY, y: 0, scroller, id: e.pointerId, active: false,
          hist: [{ y: e.clientY, t: performance.now() }] };
  });

  panel.addEventListener('pointermove', (e) => {
    if (!d) return;
    let dy = e.clientY - d.y0;
    d.hist.push({ y: e.clientY, t: performance.now() });
    if (d.hist.length > 6) d.hist.shift();
    if (!d.active) {
      if (dy < 6) return;
      if (d.scroller && d.scroller.scrollTop > 0) { d = null; return; }
      d.active = true;
      panel.setPointerCapture(d.id);
    }
    if (dy < 0) dy = -rubberband(-dy, panel.offsetHeight);   // resist upward pull
    d.y = dy;
    panel.style.transform = `translateY(${dy}px)`;
  });

  const end = (e) => {
    if (!d) return;
    const was = d;
    d = null;
    if (!was.active) return;
    const h = was.hist;
    const vy = h.length > 1
      ? (h[h.length - 1].y - h[0].y) / (Math.max(8, h[h.length - 1].t - h[0].t) / 1000)
      : 0;
    const projected = was.y + (vy / 1000) * 0.998 / (1 - 0.998);   // momentum projection
    if (sheet.dataset.modal !== 'true' && (projected > panel.offsetHeight * 0.32 || vy > 900)) {
      closeSheet(sheet.id);
    } else {
      springPanel(panel, was.y, vy);
    }
  };
  panel.addEventListener('pointerup', end);
  panel.addEventListener('pointercancel', end);
}

function rubberband(overshoot, dim, c = 0.55) {
  return (overshoot * dim * c) / (dim + c * Math.abs(overshoot));
}

function springPanel(panel, from, vel) {
  if (reduced.matches) { panel.style.transform = ''; return; }
  const w = (2 * Math.PI) / 0.32;
  let y = from, v = vel;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.032, (now - last) / 1000);
    last = now;
    v += (-2 * 0.85 * w * v - w * w * y) * dt;
    y += v * dt;
    panel.style.transform = `translateY(${y}px)`;
    if (Math.abs(y) < 0.4 && Math.abs(v) < 12) { panel.style.transform = ''; return; }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
