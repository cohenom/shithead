/*
 * test-net.mjs — the redaction contract.
 *
 * In a card game, a leaked card is a real bug: anyone can open devtools and
 * read whatever the host sent them. These tests exist to prove that what leaves
 * the host contains no rank or suit for any card the recipient is not entitled
 * to see, under every phase of the game.
 *
 *   node test-net.mjs
 */

import { newGame, commitSwap } from './game.js';
import { redact, redactGame, HostSession, makeCode } from './network.js';

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eqCards(a, b, msg) {
  assert(a.length === b.length, `${msg} — length ${a.length} != ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    assert(a[i].id === b[i].id && a[i].r === b[i].r && a[i].s === b[i].s, `${msg} — card ${i} differs`);
  }
}

/** Every card-shaped object anywhere in the payload, however deeply nested. */
function everyCardLike(node, out = []) {
  if (Array.isArray(node)) { for (const x of node) everyCardLike(x, out); return out; }
  if (node && typeof node === 'object') {
    if ('id' in node && ('r' in node || 'hidden' in node)) out.push(node);
    for (const v of Object.values(node)) everyCardLike(v, out);
  }
  return out;
}

/* ------------------------------------------------------------- fixture --- */

function fixture() {
  const state = {
    code: 'ABCD',
    stage: 'game',
    hostId: 'p-host',
    seats: [
      { id: 'p-host', name: 'Omri', connected: true },
      { id: 'p-two', name: 'Nora', connected: true },
      { id: 'p-three', name: 'Vik', connected: false },
    ],
    game: newGame({ players: [{ name: 'Omri' }, { name: 'Nora' }, { name: 'Vik' }], seed: 7 }),
  };
  // Drive it out of the swap phase deterministically.
  for (const p of state.game.players) commitSwap(state.game, p.index, p.hand.slice(0, 3).map((c) => c.id));
  // Put some cards on the pile and some in the burn pile so the public halves
  // are non-empty.
  state.game.pile.push(state.game.deck.pop(), state.game.deck.pop());
  state.game.burned.push(state.game.deck.pop());
  return state;
}

/* --------------------------------------------------------------- tests --- */

const full = fixture();
const g = full.game;

check('your own hand comes through in full', () => {
  const v = redact(full, 'p-host');
  eqCards(v.game.players[0].hand, g.players[0].hand, 'own hand');
  assert(v.you === 0, 'own seat index');
  assert(v.game.players[0].hand.every((c) => typeof c.r === 'number' && typeof c.s === 'string'),
    'own hand cards must carry rank and suit');
});

check('your own blind cards come through in full', () => {
  const v = redact(full, 'p-two');
  eqCards(v.game.players[1].blind, g.players[1].blind, 'own blind');
  assert(v.game.players[1].blind.length === 3, 'three blind cards');
});

check("another player's hand is counts only — no rank, no suit", () => {
  const v = redact(full, 'p-host');
  for (const i of [1, 2]) {
    const seen = v.game.players[i].hand;
    assert(seen.length === g.players[i].hand.length, `player ${i} hand count must be preserved`);
    assert(v.game.players[i].handCount === g.players[i].hand.length, `player ${i} handCount`);
    for (const c of seen) {
      assert(c.hidden === true, `player ${i} hand card must be flagged hidden`);
      assert(!('r' in c), `player ${i} hand card leaked a rank`);
      assert(!('s' in c), `player ${i} hand card leaked a suit`);
    }
  }
});

check("another player's blind cards are counts only", () => {
  const v = redact(full, 'p-host');
  for (const i of [1, 2]) {
    const seen = v.game.players[i].blind;
    assert(seen.length === g.players[i].blind.length, `player ${i} blind count must be preserved`);
    for (const c of seen) {
      assert(c.hidden === true, `player ${i} blind card must be flagged hidden`);
      assert(!('r' in c) && !('s' in c), `player ${i} blind card leaked its value`);
    }
  }
});

check('the undealt stock never leaves the host', () => {
  const v = redact(full, 'p-two');
  assert(v.game.deck.length === g.deck.length, 'stock count preserved');
  assert(v.game.deckCount === g.deck.length, 'deckCount');
  for (const c of v.game.deck) {
    assert(c.hidden === true && !('r' in c) && !('s' in c), 'a stock card leaked its value');
  }
});

check('public info is unchanged: face-up rows, pile, burn pile', () => {
  const v = redact(full, 'p-two');
  for (const i of [0, 1, 2]) eqCards(v.game.players[i].faceUp, g.players[i].faceUp, `player ${i} faceUp`);
  eqCards(v.game.pile, g.pile, 'discard pile');
  eqCards(v.game.burned, g.burned, 'burn pile');
  assert(v.game.current === g.current, 'turn');
  assert(v.game.phase === g.phase, 'phase');
  assert(v.game.turnCount === g.turnCount, 'turn count');
  assert(JSON.stringify(v.game.finishOrder) === JSON.stringify(g.finishOrder), 'finish order');
});

check('no card object in the whole payload leaks a value it should not', () => {
  for (const [pid, seat] of [['p-host', 0], ['p-two', 1], ['p-three', 2]]) {
    const v = redact(full, pid);
    // Every value-carrying card in the payload must be one this seat may see.
    const allowed = new Set();
    for (const c of g.players[seat].hand) allowed.add(c.id);
    for (const c of g.players[seat].blind) allowed.add(c.id);
    for (const p of g.players) for (const c of p.faceUp) allowed.add(c.id);
    for (const c of g.pile) allowed.add(c.id);
    for (const c of g.burned) allowed.add(c.id);

    for (const c of everyCardLike(v)) {
      if (c.hidden) {
        assert(!('r' in c) && !('s' in c), `hidden placeholder for ${pid} carried a value`);
        continue;
      }
      assert(allowed.has(c.id), `${pid} was sent card ${c.id} (${c.r}${c.s}) they may not see`);
    }
  }
});

check('the serialised wire payload contains no forbidden card id', () => {
  // Belt and braces: search the actual JSON that would go down the wire.
  const v = redact(full, 'p-host');
  const wire = JSON.stringify(v);
  const forbidden = [
    ...g.players[1].hand, ...g.players[1].blind,
    ...g.players[2].hand, ...g.players[2].blind,
    ...g.deck,
  ].filter((c) => !g.pile.some((p) => p.id === c.id));
  for (const c of forbidden) {
    assert(!wire.includes(`"${c.id}"`), `wire payload contained ${c.id}`);
  }
});

check('during the swap, other players\' chosen face-up rows stay hidden', () => {
  const s = {
    code: 'WXYZ', stage: 'game', hostId: 'a',
    seats: [{ id: 'a', name: 'A', connected: true }, { id: 'b', name: 'B', connected: true }],
    game: newGame({ players: [{ name: 'A' }, { name: 'B' }], seed: 3 }),
  };
  commitSwap(s.game, 1, s.game.players[1].hand.slice(0, 3).map((c) => c.id));
  assert(s.game.phase === 'swap', 'still swapping');
  const v = redact(s, 'a');
  assert(v.game.players[1].faceUp.length === 3, 'count still visible');
  for (const c of v.game.players[1].faceUp) {
    assert(c.hidden === true && !('r' in c), 'a face-up pick leaked before play began');
  }
  // ...and B still sees their own choice.
  const vb = redact(s, 'b');
  eqCards(vb.game.players[1].faceUp, s.game.players[1].faceUp, "B's own face-up row");
});

check('redaction never mutates the host state', () => {
  const before = JSON.stringify(full.game);
  redact(full, 'p-host');
  redact(full, 'p-two');
  assert(JSON.stringify(full.game) === before, 'redact mutated the authoritative state');
});

check('disconnected players are marked, not removed', () => {
  const v = redact(full, 'p-host');
  assert(v.seats.length === 3, 'seat kept');
  assert(v.seats[2].connected === false, 'disconnect flagged on the seat');
  assert(v.seats[0].isHost === true && v.seats[1].isHost === false, 'host flagged');
  assert(v.seats[0].isYou === true, 'you flagged');
});

check('a lobby snapshot redacts cleanly with no game yet', () => {
  const v = redact({ code: 'AAAA', stage: 'lobby', hostId: 'a', seats: [{ id: 'a', name: 'A', connected: true }], game: null }, 'a');
  assert(v.game === null, 'no game');
  assert(v.stage === 'lobby' && v.you === 0, 'lobby shape');
});

check('a stranger gets no private cards at all', () => {
  const v = redact(full, 'p-nobody');
  assert(v.you === -1, 'no seat');
  for (const c of everyCardLike(v)) {
    if (c.hidden) continue;
    const publicIds = new Set([
      ...g.pile.map((x) => x.id), ...g.burned.map((x) => x.id),
      ...g.players.flatMap((p) => p.faceUp.map((x) => x.id)),
    ]);
    assert(publicIds.has(c.id), `a stranger was sent ${c.id}`);
  }
});

check('redactGame tolerates a null game', () => {
  assert(redactGame(null, 0) === null, 'null game');
});

/* ------------------------------------------------- host plumbing, offline - */

check('room codes avoid ambiguous glyphs', () => {
  for (let i = 0; i < 400; i++) {
    const c = makeCode(4);
    assert(c.length === 4, 'length');
    assert(!/[IO01]/.test(c), `ambiguous glyph in ${c}`);
    assert(/^[A-Z2-9]+$/.test(c), `unexpected glyph in ${c}`);
  }
});

check('the host validates actions through the real engine', () => {
  const h = new HostSession({ hostName: 'Omri' });
  h.code = 'TEST';
  h._seat('p2', 'Nora');
  assert(h.canStart(), 'two seats can start');
  h.startGame();
  assert(h.game.phase === 'swap', 'starts in the swap phase');

  // Someone who isn't seated gets nowhere.
  assert(h.applyAction('nope', { kind: 'pickup' }).reason === 'no-seat', 'stranger rejected');
  // Wrong number of swap cards.
  assert(h.applyAction(h.hostId, { kind: 'swap', cardIds: ['2C'] }).reason === 'need-3', 'bad swap rejected');
  // Playing before the swap is done.
  assert(h.applyAction(h.hostId, { kind: 'play', cardIds: [] }).reason === 'not-playing', 'early play rejected');
  // Garbage.
  assert(h.applyAction(h.hostId, { kind: 'wat' }).reason === 'unknown-action', 'garbage rejected');
  // Claiming a card you don't hold.
  const otherCard = h.game.players[1].hand[0].id;
  assert(h.applyAction(h.hostId, { kind: 'swap', cardIds: [otherCard, otherCard, otherCard] }).reason === 'bad-card',
    "can't swap cards you don't hold");

  // Real swaps, then play begins.
  for (const p of h.game.players) {
    const id = h.seats[p.index].id;
    assert(h.applyAction(id, { kind: 'swap', cardIds: p.hand.slice(0, 3).map((c) => c.id) }).ok, 'swap accepted');
  }
  assert(h.game.phase === 'playing', 'play begins once everyone has swapped');

  // Out-of-turn play is refused by the engine.
  const notCurrent = h.game.current === 0 ? 1 : 0;
  const card = h.game.players[notCurrent].hand[0];
  assert(h.applyAction(h.seats[notCurrent].id, { kind: 'play', cardIds: [card.id] }).reason === 'not-your-turn',
    'out-of-turn play rejected');
  h._clearSwapTimeout();
});

check('a rejoin lands in the same seat; a stranger cannot join mid-game', () => {
  const h = new HostSession({ hostName: 'Omri' });
  h.code = 'TEST';
  h._seat('p2', 'Nora');
  h.startGame();
  h._setConnected('p2', false);
  assert(h.seats.length === 2, 'seat kept on disconnect');
  assert(h.game.players[1].connected === false, 'engine state shows the drop');
  assert(h._seat('p2', 'Nora').ok, 'rejoin accepted');
  assert(h.seats.length === 2, 'no duplicate seat');
  assert(h.seats[1].connected === true, 'reconnect flagged');
  assert(h._seat('p9', 'Late').ok === false, 'stranger refused mid-game');
  h._clearSwapTimeout();
});

check('a party is capped at four', () => {
  const h = new HostSession({ hostName: 'Omri' });
  assert(h._seat('b', 'B').ok && h._seat('c', 'C').ok && h._seat('d', 'D').ok, 'four seats fill');
  assert(h._seat('e', 'E').ok === false, 'fifth refused');
  assert(h.canStart(), 'four can start');
});

check('the host broadcasts a redacted view to each seat', () => {
  const seen = [];
  const h = new HostSession({ hostName: 'Omri', onState: (s) => seen.push(s) });
  h.code = 'TEST';
  h._seat('p2', 'Nora');
  h.startGame();
  const last = seen[seen.length - 1];
  assert(last.you === 0 && last.isHost, 'host sees their own seat');
  for (const c of last.game.players[1].hand) {
    assert(c.hidden === true, "the host's own view still hides the other hand");
  }
  h._clearSwapTimeout();
});

/* -------------------------------------------------------------- report --- */

if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ redaction: ${passed} checks passed`);
