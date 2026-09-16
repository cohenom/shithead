/*
 * game.js — Shithead rules engine.
 *
 * Pure, DOM-free, deterministic (seedable). Everything the UI needs is derived
 * from a plain-object `state` plus the event list each action returns.
 *
 * Card = { id: string, r: number (2..14), s: 'C'|'D'|'H'|'S' }
 *   r: 2..10 face value, 11=J, 12=Q, 13=K, 14=A.  Suits never affect legality.
 */

export const SUITS = ['C', 'D', 'H', 'S'];
export const SUIT_GLYPH = { C: '♣', D: '♦', H: '♥', S: '♠' };
export const SUIT_COLOR = { C: 'black', S: 'black', D: 'red', H: 'red' };
const RANK_LABEL = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export function rankLabel(r) {
  return RANK_LABEL[r] || String(r);
}

export function cardLabel(c) {
  return rankLabel(c.r) + SUIT_GLYPH[c.s];
}

/* ------------------------------------------------------------------ rng --- */

export function makeRng(seed) {
  if (seed === undefined || seed === null) return Math.random;
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ id: `${r}${s}`, r, s });
  }
  return deck;
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* -------------------------------------------------------------- setup ---- */

export const HAND_SIZE = 3;      // cards held once play begins / refill target
export const DEAL_HAND = 6;      // dealt to hand before the face-up swap
export const BLIND_COUNT = 3;

/**
 * @param {{players: {name:string,isBot:boolean}[], seed?:number}} opts
 */
export function newGame(opts) {
  const rng = makeRng(opts.seed);
  const deck = shuffle(createDeck(), rng);
  const players = opts.players.map((p, i) => ({
    index: i,
    name: p.name,
    isBot: !!p.isBot,
    hand: [],
    faceUp: [],
    blind: [],
    swapped: false,
    finishedAt: null,
  }));

  for (const p of players) for (let i = 0; i < BLIND_COUNT; i++) p.blind.push(deck.pop());
  for (const p of players) for (let i = 0; i < DEAL_HAND; i++) p.hand.push(deck.pop());

  return {
    players,
    deck,
    pile: [],
    burned: [],
    current: 0,
    phase: 'swap',           // 'swap' | 'playing' | 'over'
    finishOrder: [],         // player indices, in the order they went out
    seed: opts.seed ?? null,
    turnCount: 0,
  };
}

/** Move 3 chosen hand cards face-up onto the blind stacks. */
export function commitSwap(state, playerIndex, cardIds) {
  const p = state.players[playerIndex];
  if (state.phase !== 'swap' || p.swapped) return { ok: false, reason: 'not-swapping' };
  if (!Array.isArray(cardIds) || cardIds.length !== BLIND_COUNT) return { ok: false, reason: 'need-3' };
  const picked = [];
  for (const id of cardIds) {
    const c = p.hand.find((x) => x.id === id);
    if (!c || picked.includes(c)) return { ok: false, reason: 'bad-card' };
    picked.push(c);
  }
  p.hand = p.hand.filter((c) => !picked.includes(c));
  p.faceUp = picked;
  p.swapped = true;
  if (state.players.every((x) => x.swapped)) beginPlay(state);
  return { ok: true };
}

/**
 * Starting player: whoever holds the single lowest-ranked card in hand.
 * Ties broken by suit order (C < D < H < S) then seat order — fully
 * deterministic, no coin flip.
 */
export function beginPlay(state) {
  let best = null;
  for (const p of state.players) {
    for (const c of p.hand) {
      const key = [c.r, SUITS.indexOf(c.s), p.index];
      if (!best || cmpKey(key, best.key) < 0) best = { key, index: p.index };
    }
  }
  state.current = best ? best.index : 0;
  state.phase = 'playing';
  return state.current;
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/* ------------------------------------------------------------ legality --- */

/**
 * What the pile currently demands.
 *  free   — anything goes (empty pile, or a 2 on top)
 *  lower  — a 7 is showing: next card must be rank <= 7
 *  higher — must be >= the shown rank
 */
export function pileRequirement(pile) {
  if (!pile.length) return { kind: 'free', rank: 0 };
  const top = pile[pile.length - 1];
  if (top.r === 2) return { kind: 'free', rank: 0 };
  if (top.r === 7) return { kind: 'lower', rank: 7 };
  return { kind: 'higher', rank: top.r };
}

/** 2 and 10 are always legal, whatever is showing. */
export function isLegalCard(card, req) {
  if (card.r === 2 || card.r === 10) return true;
  if (req.kind === 'free') return true;
  if (req.kind === 'lower') return card.r <= req.rank;
  return card.r >= req.rank;
}

export function canPlay(state, cards) {
  if (!cards.length) return false;
  const r = cards[0].r;
  if (!cards.every((c) => c.r === r)) return false;
  return isLegalCard(cards[0], pileRequirement(state.pile));
}

/** Which of a player's three stacks they must currently play from. */
export function activeZone(player) {
  if (player.hand.length) return 'hand';
  if (player.faceUp.length) return 'faceUp';
  if (player.blind.length) return 'blind';
  return null;
}

/**
 * Every legal move available to a player right now, as arrays of cards.
 * Blind cards are never enumerated (they're unknown) — see playBlind().
 */
export function legalGroups(state, playerIndex) {
  const p = state.players[playerIndex];
  const zone = activeZone(p);
  if (!zone || zone === 'blind') return [];
  const req = pileRequirement(state.pile);
  const byRank = new Map();
  for (const c of p[zone]) {
    if (!isLegalCard(c, req)) continue;
    if (!byRank.has(c.r)) byRank.set(c.r, []);
    byRank.get(c.r).push(c);
  }
  const groups = [];
  for (const cards of byRank.values()) {
    for (let n = 1; n <= cards.length; n++) groups.push(cards.slice(0, n));
  }
  return groups;
}

export function hasLegalPlay(state, playerIndex) {
  return legalGroups(state, playerIndex).length > 0;
}

/** Cards remaining to a player across all three stacks. */
export function cardsLeft(p) {
  return p.hand.length + p.faceUp.length + p.blind.length;
}

/* ---------------------------------------------------------------- play --- */

/**
 * Play one or more same-rank cards from the player's active (hand/faceUp) zone.
 * Returns { ok, events } — events drive the UI's animations.
 */
export function playCards(state, playerIndex, cardIds) {
  if (state.phase !== 'playing') return { ok: false, reason: 'not-playing' };
  if (playerIndex !== state.current) return { ok: false, reason: 'not-your-turn' };
  const p = state.players[playerIndex];
  const zone = activeZone(p);
  if (!zone || zone === 'blind') return { ok: false, reason: 'blind-zone' };

  const cards = [];
  for (const id of cardIds) {
    const c = p[zone].find((x) => x.id === id);
    if (!c || cards.includes(c)) return { ok: false, reason: 'bad-card' };
    cards.push(c);
  }
  if (!canPlay(state, cards)) return { ok: false, reason: 'illegal' };

  p[zone] = p[zone].filter((c) => !cards.includes(c));
  state.pile.push(...cards);

  const events = [{ type: 'play', player: playerIndex, cards: cards.slice(), zone }];
  resolveAfterPlay(state, playerIndex, cards, zone, events);
  return { ok: true, events };
}

/**
 * Turn over one blind card. If it happens to be legal it is played; if not,
 * the player swallows the pile (with the flipped card on top).
 */
export function playBlind(state, playerIndex, cardId) {
  if (state.phase !== 'playing') return { ok: false, reason: 'not-playing' };
  if (playerIndex !== state.current) return { ok: false, reason: 'not-your-turn' };
  const p = state.players[playerIndex];
  if (activeZone(p) !== 'blind') return { ok: false, reason: 'not-blind-zone' };
  const card = p.blind.find((x) => x.id === cardId);
  if (!card) return { ok: false, reason: 'bad-card' };

  const legal = isLegalCard(card, pileRequirement(state.pile));
  p.blind = p.blind.filter((c) => c !== card);
  state.pile.push(card);
  const events = [{ type: 'blind-flip', player: playerIndex, card, legal }];

  if (legal) {
    resolveAfterPlay(state, playerIndex, [card], 'blind', events);
  } else {
    const taken = state.pile.slice();
    p.hand.push(...taken);
    state.pile = [];
    events.push({ type: 'pickup', player: playerIndex, cards: taken, forced: true });
    endTurn(state, playerIndex, { again: false, skips: 0 }, events);
  }
  return { ok: true, events };
}

/** No legal play: swallow the pile. */
export function pickUpPile(state, playerIndex) {
  if (state.phase !== 'playing') return { ok: false, reason: 'not-playing' };
  if (playerIndex !== state.current) return { ok: false, reason: 'not-your-turn' };
  const p = state.players[playerIndex];
  // In the blind phase you must turn a card over and take your chances.
  if (activeZone(p) === 'blind') return { ok: false, reason: 'must-flip-blind' };
  if (hasLegalPlay(state, playerIndex)) return { ok: false, reason: 'have-legal-play' };
  const taken = state.pile.slice();
  p.hand.push(...taken);
  state.pile = [];
  const events = [{ type: 'pickup', player: playerIndex, cards: taken, forced: true }];
  endTurn(state, playerIndex, { again: false, skips: 0 }, events);
  return { ok: true, events };
}

function topRunLength(pile) {
  if (!pile.length) return 0;
  const r = pile[pile.length - 1].r;
  let n = 0;
  for (let i = pile.length - 1; i >= 0 && pile[i].r === r; i--) n++;
  return n;
}

function resolveAfterPlay(state, playerIndex, cards, zone, events) {
  const p = state.players[playerIndex];

  // Refill to 3 while any stock remains — hand phase only.
  if (zone === 'hand') {
    let drew = 0;
    while (p.hand.length < HAND_SIZE && state.deck.length) {
      p.hand.push(state.deck.pop());
      drew++;
    }
    if (drew) events.push({ type: 'draw', player: playerIndex, count: drew });
  }

  const playedTen = cards.some((c) => c.r === 10);
  const fourOfAKind = topRunLength(state.pile) >= 4;

  if (playedTen || fourOfAKind) {
    const burned = state.pile.slice();
    state.burned.push(...burned);
    state.pile = [];
    events.push({
      type: 'burn',
      player: playerIndex,
      cards: burned,
      reason: playedTen ? 'ten' : 'four',
    });
    // Whoever burns leads the fresh pile — unless they just went out.
    endTurn(state, playerIndex, { again: true, skips: 0 }, events);
    return;
  }

  const skips = cards.filter((c) => c.r === 8).length;
  endTurn(state, playerIndex, { again: false, skips }, events);
}

function endTurn(state, playerIndex, { again, skips }, events) {
  const p = state.players[playerIndex];

  if (cardsLeft(p) === 0 && p.finishedAt === null) {
    p.finishedAt = state.finishOrder.length;
    state.finishOrder.push(playerIndex);
    events.push({ type: 'out', player: playerIndex, place: p.finishedAt + 1 });
    again = false;
  }

  const active = state.players.filter((x) => x.finishedAt === null);
  if (active.length <= 1) {
    for (const x of active) {
      x.finishedAt = state.finishOrder.length;
      state.finishOrder.push(x.index);
    }
    state.phase = 'over';
    events.push({ type: 'game-over', order: state.finishOrder.slice() });
    return;
  }

  state.turnCount++;
  if (again) {
    events.push({ type: 'turn', player: playerIndex, again: true });
    return;
  }

  let next = nextActive(state, playerIndex);
  for (let i = 0; i < skips; i++) {
    events.push({ type: 'skip', player: next });
    next = nextActive(state, next);
  }
  state.current = next;
  events.push({ type: 'turn', player: next, again: false });
}

function nextActive(state, from) {
  const n = state.players.length;
  let i = from;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (state.players[i].finishedAt === null) return i;
  }
  return from;
}

/* ------------------------------------------------------------ integrity -- */

/** Every card accounted for exactly once — used by the test harness. */
export function auditCards(state) {
  const seen = new Map();
  const add = (c, where) => {
    if (seen.has(c.id)) return `duplicate ${c.id} (${seen.get(c.id)} & ${where})`;
    seen.set(c.id, where);
    return null;
  };
  const problems = [];
  for (const c of state.deck) { const e = add(c, 'deck'); if (e) problems.push(e); }
  for (const c of state.pile) { const e = add(c, 'pile'); if (e) problems.push(e); }
  for (const c of state.burned) { const e = add(c, 'burned'); if (e) problems.push(e); }
  for (const p of state.players) {
    for (const z of ['hand', 'faceUp', 'blind']) {
      for (const c of p[z]) { const e = add(c, `p${p.index}.${z}`); if (e) problems.push(e); }
    }
  }
  if (seen.size !== 52) problems.push(`card count ${seen.size} != 52`);
  return problems;
}
