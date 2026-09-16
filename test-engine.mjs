/*
 * test-engine.mjs — headless sanity suite for the rules engine.
 *
 *   node test-engine.mjs            # 600 seeded bot-vs-bot games
 *   node test-engine.mjs 2000       # more
 *
 * Asserts: every game terminates, all 52 cards stay accounted for after every
 * single action, no illegal card ever reaches the pile, burns/skips/4-of-a-kind
 * behave, and the finish order names every player exactly once.
 */

import {
  newGame, commitSwap, playCards, playBlind, pickUpPile,
  legalGroups, activeZone, pileRequirement, isLegalCard,
  auditCards, cardsLeft, makeRng, cardLabel,
} from './game.js';
import { chooseSwap, chooseMove } from './ai.js';

const GAMES = Number(process.argv[2] || 600);
const MAX_TURNS = 4000;

let failures = 0;
const stats = { games: 0, turns: 0, burns: 0, skips: 0, pickups: 0, blindFlips: 0, blindFails: 0 };

function fail(msg, ctx) {
  failures++;
  console.error('FAIL:', msg, ctx ? '\n  ' + ctx : '');
  if (failures > 8) { console.error('too many failures, stopping'); process.exit(1); }
}

function check(cond, msg, ctx) { if (!cond) fail(msg, ctx); return cond; }

function describe(state) {
  return state.players
    .map((p) => `P${p.index}[h${p.hand.length} f${p.faceUp.length} b${p.blind.length}]`)
    .join(' ') + ` pile=${state.pile.length} deck=${state.deck.length} burn=${state.burned.length}`;
}

function runGame(numPlayers, seed) {
  const rng = makeRng(seed ^ 0x9e3779b9);
  const state = newGame({
    seed,
    players: Array.from({ length: numPlayers }, (_, i) => ({ name: `Bot ${i + 1}`, isBot: true })),
  });

  check(state.phase === 'swap', 'expected swap phase');
  for (const p of state.players) {
    check(p.hand.length === 6, `dealt hand should be 6, got ${p.hand.length}`);
    check(p.blind.length === 3, `blind should be 3, got ${p.blind.length}`);
    const res = commitSwap(state, p.index, chooseSwap(p.hand));
    check(res.ok, 'commitSwap failed: ' + res.reason);
    check(p.faceUp.length === 3 && p.hand.length === 3, 'post-swap zones wrong');
  }
  check(state.phase === 'playing', 'should be playing after all swaps');
  check(state.deck.length === 52 - 9 * numPlayers, 'stock size wrong');

  // Double-check the "wrong number of cards" guard.
  check(!commitSwap(state, 0, []).ok, 'empty swap should be rejected');

  let turns = 0;
  while (state.phase === 'playing') {
    if (++turns > MAX_TURNS) { fail(`game did not terminate (${numPlayers}p seed ${seed})`, describe(state)); return; }

    const pi = state.current;
    const me = state.players[pi];
    check(me.finishedAt === null, 'a finished player got the turn');
    const zone = activeZone(me);
    check(zone !== null, 'active player has no cards but is still in the game');

    const reqBefore = pileRequirement(state.pile);
    const move = chooseMove(state, pi, rng);
    let res;

    if (move.action === 'pickup') {
      check(legalGroups(state, pi).length === 0, 'bot passed up a legal play', describe(state));
      const before = state.pile.length + me.hand.length;
      res = pickUpPile(state, pi);
      check(res.ok, 'pickUpPile rejected: ' + res.reason);
      check(state.pile.length === 0, 'pile not empty after pickup');
      check(me.hand.length === before, 'pickup lost cards');
      stats.pickups++;
    } else if (move.action === 'blind') {
      check(zone === 'blind', 'blind move outside blind zone');
      res = playBlind(state, pi, move.cardId);
      check(res.ok, 'playBlind rejected: ' + res.reason);
      const ev = res.events[0];
      stats.blindFlips++;
      if (!ev.legal) {
        stats.blindFails++;
        check(state.players[pi].hand.length > 0, 'failed blind flip should hand back the pile');
      }
    } else {
      const cards = move.cardIds.map((id) => me[zone].find((c) => c.id === id) || me.hand.find((c) => c.id === id));
      check(cards.every(Boolean), 'bot picked a card it does not hold');
      const rank = cards[0].r;
      check(cards.every((c) => c.r === rank), 'bot played mixed ranks');
      check(isLegalCard(cards[0], reqBefore), `illegal play ${cardLabel(cards[0])} on req ${reqBefore.kind}:${reqBefore.rank}`);
      res = playCards(state, pi, move.cardIds);
      check(res.ok, 'playCards rejected a move the bot believed legal: ' + res.reason);
    }

    for (const ev of res.events || []) {
      if (ev.type === 'burn') stats.burns++;
      if (ev.type === 'skip') stats.skips++;
    }

    // ---- invariants, checked after every single action ----
    const problems = auditCards(state);
    check(problems.length === 0, 'card audit: ' + problems.join('; '), describe(state));

    if (state.pile.length) {
      const top = state.pile[state.pile.length - 1];
      check(top.r !== 10, 'a 10 was left sitting on the pile (should have burned)');
      let run = 0;
      for (let i = state.pile.length - 1; i >= 0 && state.pile[i].r === top.r; i--) run++;
      check(run < 4, 'four of a kind left on the pile (should have burned)');
    }

    for (const p of state.players) {
      if (p.hand.length < 3 && state.deck.length > 0 && p.finishedAt === null) {
        check(false, `P${p.index} under-drawn: hand ${p.hand.length} with ${state.deck.length} in stock`, describe(state));
      }
      check(p.hand.length <= 52 && p.faceUp.length <= 3 && p.blind.length <= 3, 'zone overflow');
      if (p.faceUp.length && p.hand.length === 0 && state.deck.length > 0) {
        check(false, 'hand empty while stock remains', describe(state));
      }
      // While the game is live, being placed means you got rid of everything.
      // (At game end the last player is placed too, still holding cards.)
      if (state.phase === 'playing' && p.finishedAt !== null) {
        check(cardsLeft(p) === 0, 'finished player still holds cards');
      }
    }
  }

  stats.games++;
  stats.turns += turns;

  check(state.finishOrder.length === numPlayers, `finish order has ${state.finishOrder.length} of ${numPlayers}`);
  check(new Set(state.finishOrder).size === numPlayers, 'finish order has duplicates');
  for (const p of state.players) check(p.finishedAt !== null, 'player never placed');
  const winner = state.players[state.finishOrder[0]];
  check(cardsLeft(winner) === 0, 'winner still holds cards');
  const last = state.players[state.finishOrder[numPlayers - 1]];
  check(numPlayers === 1 || cardsLeft(last) > 0 || state.finishOrder.length === numPlayers, 'last place sanity');
  check(state.burned.length + state.pile.length + state.deck.length +
    state.players.reduce((n, p) => n + cardsLeft(p), 0) === 52, 'cards lost by the end');
}

/* -------------------------------------------------- targeted rule tests --- */

function ruleTests() {
  const c = (r, s) => ({ id: `${r}${s}`, r, s });
  const blank = () => {
    const st = newGame({ seed: 1, players: [{ name: 'A', isBot: true }, { name: 'B', isBot: true }] });
    for (const p of st.players) commitSwap(st, p.index, p.hand.slice(0, 3).map((x) => x.id));
    return st;
  };

  // pile requirement
  check(pileRequirement([]).kind === 'free', 'empty pile should be free');
  check(pileRequirement([c(2, 'H')]).kind === 'free', '2 should reset the pile');
  check(pileRequirement([c(7, 'H')]).kind === 'lower', '7 should demand equal-or-lower');
  check(pileRequirement([c(9, 'H')]).kind === 'higher', 'normal card should demand equal-or-higher');

  const hi = pileRequirement([c(9, 'H')]);
  check(isLegalCard(c(9, 'S'), hi), 'equal rank must be legal');
  check(isLegalCard(c(14, 'S'), hi), 'higher rank must be legal');
  check(!isLegalCard(c(8, 'S'), hi), 'lower rank must be illegal');
  check(isLegalCard(c(2, 'S'), hi), '2 must always be legal');
  check(isLegalCard(c(10, 'S'), hi), '10 must always be legal');
  const lo = pileRequirement([c(7, 'H')]);
  check(isLegalCard(c(4, 'S'), lo), 'lower than 7 must be legal on a 7');
  check(isLegalCard(c(7, 'S'), lo), '7 on 7 must be legal');
  check(!isLegalCard(c(9, 'S'), lo), 'higher than 7 must be illegal on a 7');
  check(isLegalCard(c(2, 'S'), lo) && isLegalCard(c(10, 'S'), lo), '2/10 must beat the 7 rule');

  // 10 burns and the same player leads again
  let st = blank();
  const p0 = st.players[0];
  st.current = 0;
  st.pile = [c(5, 'H'), c(6, 'D')];
  p0.hand = [c(10, 'S'), c(3, 'C'), c(4, 'C')];
  st.deck = [];
  let r = playCards(st, 0, ['10S']);
  check(r.ok, '10 should be playable on a 6');
  check(st.pile.length === 0 && st.burned.length === 3, '10 should burn the pile');
  check(st.current === 0, 'burner should lead the new pile');

  // four of a kind accumulating across players burns
  st = blank();
  st.deck = [];
  st.current = 0;
  st.pile = [c(9, 'C'), c(9, 'D')];
  st.players[0].hand = [c(9, 'H'), c(9, 'S'), c(4, 'C')];
  r = playCards(st, 0, ['9H', '9S']);
  check(r.ok, 'pair of 9s on 9s should be legal');
  check(st.pile.length === 0, 'four 9s should burn');
  check(r.events.some((e) => e.type === 'burn' && e.reason === 'four'), 'burn event should cite four-of-a-kind');
  check(st.current === 0, 'completer of the four leads again');

  // 8 skips the next player (heads-up: you go again)
  st = blank();
  st.deck = [];
  st.current = 0;
  st.pile = [c(3, 'C')];
  st.players[0].hand = [c(8, 'H'), c(4, 'C'), c(5, 'C')];
  r = playCards(st, 0, ['8H']);
  check(r.ok, '8 on a 3 should be legal');
  check(r.events.some((e) => e.type === 'skip' && e.player === 1), 'an 8 should skip player 1');
  check(st.current === 0, 'heads-up, an 8 returns the turn to you');

  // two 8s in a 3-player game skip two players
  st = newGame({ seed: 7, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }].map((x) => ({ ...x, isBot: true })) });
  for (const p of st.players) commitSwap(st, p.index, p.hand.slice(0, 3).map((x) => x.id));
  st.deck = [];
  st.current = 0;
  st.pile = [c(3, 'C')];
  st.players[0].hand = [c(8, 'H'), c(8, 'S'), c(5, 'C')];
  r = playCards(st, 0, ['8H', '8S']);
  check(r.events.filter((e) => e.type === 'skip').length === 2, 'two 8s should skip two players');
  check(st.current === 0, 'after skipping both opponents the turn comes back');

  // a failed blind flip eats the pile
  st = blank();
  st.deck = [];
  st.current = 0;
  st.pile = [c(13, 'C')];
  st.players[0].hand = [];
  st.players[0].faceUp = [];
  st.players[0].blind = [c(4, 'H'), c(5, 'H'), c(6, 'H')];
  r = playBlind(st, 0, '4H');
  check(r.ok && r.events[0].legal === false, 'a 4 on a king should be an illegal flip');
  check(st.players[0].hand.length === 2, 'failed flip should take pile + flipped card');
  check(st.pile.length === 0, 'pile should be gone after a failed flip');
  check(st.current === 1, 'turn passes after eating the pile');

  // you may not pick up while you hold a legal play
  st = blank();
  st.current = 0;
  st.pile = [c(4, 'C')];
  st.players[0].hand = [c(9, 'H')];
  check(!pickUpPile(st, 0).ok, 'pickup must be refused when a legal play exists');

  // ...and you may not pick up instead of flipping a blind card
  st = blank();
  st.current = 0;
  st.deck = [];
  st.pile = [c(13, 'C')];
  st.players[0].hand = [];
  st.players[0].faceUp = [];
  st.players[0].blind = [c(4, 'H')];
  check(!pickUpPile(st, 0).ok, 'pickup must be refused in the blind phase');

  // out-of-turn and illegal plays are refused
  st = blank();
  st.current = 0;
  st.pile = [c(13, 'C')];
  st.players[0].hand = [c(4, 'H')];
  check(!playCards(st, 1, []).ok, 'out-of-turn play must be refused');
  check(!playCards(st, 0, ['4H']).ok, 'illegal play must be refused');
  check(!playCards(st, 0, ['4H', '4S']).ok, 'playing a card you do not hold must be refused');
}

/* ---------------------------------------------------------------- run ---- */

console.log(`Shithead engine tests — ${GAMES} simulated games\n`);
ruleTests();
console.log('rule unit tests ' + (failures === 0 ? 'passed' : 'FAILED'));

for (let i = 0; i < GAMES; i++) {
  const numPlayers = 2 + (i % 3); // 2, 3, 4 players in rotation
  runGame(numPlayers, i + 1);
}

const avg = (stats.turns / Math.max(1, stats.games)).toFixed(1);
console.log(`
games completed : ${stats.games}/${GAMES}
avg turns/game  : ${avg}
burns           : ${stats.burns}
skips (8s)      : ${stats.skips}
pile pickups    : ${stats.pickups}
blind flips     : ${stats.blindFlips} (${stats.blindFails} failed)
`);

if (failures === 0) {
  console.log('ALL CHECKS PASSED');
  process.exit(0);
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
