/*
 * ai.js — bot decision making. Pure functions over engine state; no DOM.
 *
 * Deliberately "good club player", not perfect: it dumps its cheapest legal
 * cards, hoards 2s and 10s until they buy something, grabs four-of-a-kind
 * burns, and keeps its power cards for the face-up endgame.
 */

import { legalGroups, activeZone, pileRequirement } from './game.js';

/** Endgame value of a card — what it's worth to still be holding it. */
export function cardPower(c) {
  if (c.r === 10) return 16;   // burns anything
  if (c.r === 2) return 15.5;  // resets anything
  if (c.r === 8) return 14.5;  // skip is strong heads-up
  return c.r;                  // A K Q J ...
}

/**
 * Deal-time selection: the three cards that will sit face-up are played *last*,
 * when the pile is usually high and nasty — so the bot banks its strongest
 * cards there and keeps the cheap ones in hand to start with.
 */
export function chooseSwap(hand) {
  return hand
    .slice()
    .sort((a, b) => cardPower(b) - cardPower(a))
    .slice(0, 3)
    .map((c) => c.id);
}

/**
 * @returns {{action:'play',cardIds:string[]}|{action:'pickup'}|{action:'blind',cardId:string}}
 */
export function chooseMove(state, playerIndex, rng = Math.random) {
  const me = state.players[playerIndex];
  const zone = activeZone(me);
  if (zone === 'blind') {
    const pick = me.blind[Math.floor(rng() * me.blind.length)] || me.blind[0];
    return { action: 'blind', cardId: pick.id };
  }

  const groups = legalGroups(state, playerIndex);
  if (!groups.length) return { action: 'pickup' };

  // Small amount of noise on top of the heuristic. Two purposes: bots that
  // never play a position identically twice feel human, and — more importantly
  // — perfectly deterministic policies can lock two bots into an endless
  // play/pick-up cycle. A little variance guarantees games actually finish.
  const scored = groups
    .map((g) => ({ g, cost: scoreGroup(state, me, g, zone) + (rng() - 0.5) * 2 }))
    .sort((a, b) => a.cost - b.cost);

  let pick = scored[0];
  if (scored.length > 1 && rng() < 0.12) {
    pick = scored[1 + Math.floor(rng() * Math.min(2, scored.length - 1))];
  }
  return { action: 'play', cardIds: pick.g.map((c) => c.id) };
}

function scoreGroup(state, me, group, zone) {
  const card = group[0];
  const n = group.length;
  const pileSize = state.pile.length;
  const req = pileRequirement(state.pile);
  const stockGone = state.deck.length === 0;

  let cost;
  if (card.r === 10) {
    // Burning a fat pile is a gift; burning two cards is a waste of a 10.
    cost = pileSize >= 4 ? 4 : 46 - pileSize * 2;
  } else if (card.r === 2) {
    // A 2 is an escape hatch. Only spend it when the pile is genuinely high.
    cost = req.kind === 'higher' && req.rank >= 12 ? 10 : 44;
  } else if (card.r === 8) {
    // Skips are good, but not worth leading with while cheap cards remain.
    cost = 11;
  } else {
    cost = card.r;
  }

  // Shedding several at once is progress — more so once the stock is dry.
  cost -= (n - 1) * (stockGone ? 3.5 : 2.2);

  // Completing four-of-a-kind burns the pile and hands us another turn.
  if (countTopRun(state.pile, card.r) + n >= 4) cost -= 40;

  // Face-up cards are a shield for later; while in hand phase prefer the hand
  // (this only matters when zone === 'faceUp', where it's a no-op) — instead,
  // in the face-up phase spend the weakest card first.
  if (zone === 'faceUp' && card.r !== 10 && card.r !== 2) cost -= 1;

  // Don't strand yourself: holding literally nothing playable next turn is bad,
  // so gently favour keeping one high card back while the hand is large.
  if (zone === 'hand' && stockGone && me.hand.length - n === 0 && card.r < 9) cost += 2;

  return cost;
}

function countTopRun(pile, rank) {
  let n = 0;
  for (let i = pile.length - 1; i >= 0 && pile[i].r === rank; i--) n++;
  return n;
}

/** Randomised "thinking" pause so turns land at a human tempo. */
export function thinkDelay(rng = Math.random) {
  return 400 + Math.floor(rng() * 400);
}
