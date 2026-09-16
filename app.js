/*
 * app.js — wiring. Owns the game loop, the human's selection state, and the
 * choreography that turns engine events into motion.
 */

import {
  newGame, commitSwap, playCards, playBlind, pickUpPile,
  legalGroups, activeZone, cardsLeft, rankLabel, pileRequirement,
} from './game.js';
import { chooseSwap, chooseMove, thinkDelay } from './ai.js';
import * as ui from './ui.js';
import * as net from './network.js';

/* Your own seat. Always 0 offline; online it's whatever seat the host gave
   you, so everything below reads "me" through this one number. */
let YOU = 0;
const BOT_NAMES = ['Nora', 'Vik', 'Sam'];

const app = {
  state: null,
  mode: 'setup',          // 'setup' | 'swap' | 'play' | 'over'
  numPlayers: 2,
  selection: new Set(),
  swapPicks: [null, null, null],
  thinking: null,
  busy: false,

  // online party mode — null for the offline vs-bots game
  net: null,              // { isHost, session, send(action) }
  pending: 0,             // timestamp of an action awaiting the host's answer
  netState: null,         // last redacted snapshot from the host
  overShown: false,
};

const $ = (id) => document.getElementById(id);
const online = () => !!app.net;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- view --- */

function myZone() {
  if (!app.state || app.state.phase !== 'playing') return null;
  return activeZone(app.state.players[YOU]);
}

function myLegalIds() {
  const s = new Set();
  if (!app.state || app.state.phase !== 'playing' || app.state.current !== YOU) return s;
  for (const g of legalGroups(app.state, YOU)) for (const c of g) s.add(c.id);
  return s;
}

function interactive() {
  // Online, an action is a request: stay untouchable until the host's answer
  // lands, so a double-tap can't fire the same move twice. Self-healing — if
  // the host rejects it or the push is lost, the latch times out on its own.
  if (online() && app.pending && Date.now() - app.pending < 4000) return false;
  return !app.busy
    && app.state?.phase === 'playing'
    && app.state.current === YOU
    && app.mode === 'play';
}

/** Ask the host to make a move on our behalf. */
function sendNet(action) {
  app.pending = Date.now();
  app.net.send(action);
  render();
}

function view() {
  return {
    state: app.state,
    you: YOU,
    mode: app.mode === 'setup' ? 'play' : app.mode,
    selection: app.selection,
    swapPicks: app.swapPicks,
    swapNext: app.swapPicks.indexOf(null),
    thinking: app.thinking,
    legal: myLegalIds(),
    activeZone: myZone(),
    interactive: interactive(),
  };
}

function render() {
  if (!app.state) return;
  ui.renderBoard(view());
  updateChrome();
}

/* ------------------------------------------------------------- chrome --- */

function updateChrome() {
  const st = app.state;
  if (!st) return;

  // Online: you've locked in your face-up row, everyone else hasn't yet.
  if (online() && st.phase === 'swap' && app.mode !== 'swap') {
    const ready = st.players.filter((p) => p.swapped).length;
    ui.setStatus(`Waiting for players — ${ready}/${st.players.length} ready`);
    ui.setActions({ primary: null, secondary: null });
    return;
  }

  if (app.mode === 'swap') {
    const n = app.swapPicks.filter(Boolean).length;
    // Online, the Confirm is in flight to the host — don't let it be sent twice.
    const sent = online() && !!app.pending;
    ui.setStatus(sent
      ? 'Locking those in…'
      : (n === 3 ? 'Happy with those three?' : `Choose ${3 - n} more for your face-up row`));
    ui.setActions({ primary: 'Confirm', primaryEnabled: n === 3 && !sent, secondary: (n && !sent) ? 'Clear' : null });
    return;
  }

  if (st.phase === 'over') {
    ui.setStatus('Game over');
    ui.setActions({ primary: 'New game' });
    return;
  }

  if (st.current !== YOU) {
    const them = st.players[st.current];
    ui.setStatus(online()
      ? (them.connected === false ? `${them.name} dropped out — waiting…` : `${them.name}'s turn`)
      : `${them.name} is thinking…`);
    ui.setActions({ primary: null, secondary: null });
    return;
  }

  const zone = myZone();
  const legal = myLegalIds();
  if (zone === 'blind') {
    ui.setStatus('Blind card — tap one and hope');
    ui.setActions({ primary: null, secondary: null });
    return;
  }
  if (!legal.size) {
    ui.setStatus(zone === 'faceUp' ? 'Nothing plays from your face-up cards' : 'Nothing you can play');
    ui.setActions({ primary: `Take the pile (${st.pile.length})` });
    return;
  }
  if (app.selection.size) {
    const rank = rankLabel(cardById([...app.selection][0]).r);
    ui.setStatus(zone === 'faceUp' ? 'Your turn — face-up cards' : 'Your turn');
    ui.setActions({
      primary: app.selection.size > 1 ? `Play ${app.selection.size} × ${rank}` : `Play ${rank}`,
    });
    return;
  }
  ui.setStatus(zone === 'faceUp' ? 'Your turn — face-up cards' : 'Your turn');
  ui.setActions({ primary: null, secondary: null });
}

function cardById(id) {
  const p = app.state.players[YOU];
  return [...p.hand, ...p.faceUp].find((c) => c.id === id);
}

/* ------------------------------------------------------- new game ------- */

function deal() {
  leaveParty({ quiet: true });
  YOU = 0;
  const players = [{ name: 'You', isBot: false }];
  for (let i = 0; i < app.numPlayers - 1; i++) {
    players.push({ name: BOT_NAMES[i], isBot: true });
  }
  app.state = newGame({ players });
  app.mode = 'swap';
  app.overShown = false;
  app.selection.clear();
  app.swapPicks = [null, null, null];
  app.thinking = null;
  app.busy = false;
  ui.clearFX();
  ui.closeAllSheets();

  document.getElementById('board').classList.remove('pre-game');
  render();
  // deal animation: everything arrives from the stock
  const from = ui.deckRect();
  ui.flipFrom(new Map(), () => from, { stagger: 26, duration: 460 });
}

/* ----------------------------------------------------------- swap ------- */

function swapPlace(id) {
  if (app.swapPicks.includes(id)) return;
  const slot = app.swapPicks.indexOf(null);
  if (slot === -1) return;
  const prev = ui.snapshot();
  app.swapPicks[slot] = id;
  render();
  ui.flipFrom(prev, null, { duration: 380 });
}

function swapReturn(id) {
  const i = app.swapPicks.indexOf(id);
  if (i === -1) return;
  const prev = ui.snapshot();
  app.swapPicks[i] = null;
  render();
  ui.flipFrom(prev, null, { duration: 380 });
}

async function confirmSwap() {
  if (app.swapPicks.filter(Boolean).length !== 3) return;

  // Online the host owns the deal: send the picks and wait for the state push
  // that comes back with everyone else's readiness.
  if (online()) {
    sendNet({ kind: 'swap', cardIds: app.swapPicks.slice() });
    return;
  }

  await guarded(async () => {
    const prev = ui.snapshot();
    commitSwap(app.state, YOU, app.swapPicks.slice());
    for (const p of app.state.players) {
      if (p.isBot && !p.swapped) commitSwap(app.state, p.index, chooseSwap(p.hand));
    }
    app.mode = 'play';
    app.swapPicks = [null, null, null];
    render();
    await ui.flipFrom(prev, null, { duration: 420 });

    const starter = app.state.players[app.state.current];
    ui.toast(starter.index === YOU
      ? 'You hold the lowest card — you lead'
      : `${starter.name} holds the lowest card`, { ms: 1800 });
  });
  render();
  await sleep(700);
  runLoop();
}

/* ------------------------------------------------- move choreography ---- */

/**
 * Runs one action and animates the difference. `pre` may return the rects the
 * moving cards start from (used when the cards won't survive the render).
 */
async function applyAction(actor, fn, opts = {}) {
  const st = app.state;
  ui.clearFX();
  const discardR = ui.discardRect();
  const deckR = ui.deckRect();
  const seatR = ui.seatRect(st, YOU, actor);

  const res = fn();
  if (!res || !res.ok) return res;
  const events = res.events || [];
  const burn = events.find((e) => e.type === 'burn');
  const pickup = events.find((e) => e.type === 'pickup');
  const play = events.find((e) => e.type === 'play' || e.type === 'blind-flip');

  // Cards about to be destroyed by a burn get flown onto the pile first,
  // otherwise they'd never be seen landing.
  if (burn && play) {
    const played = play.cards || [play.card];
    const items = played.map((c) => {
      const el = ui.cardElById(c.id);
      const rect = el ? el.getBoundingClientRect() : (opts.fromRect || seatR);
      if (el) el.style.visibility = 'hidden';
      return { card: c, rect };
    });
    await ui.flyCards(items, discardR, { duration: 300, stagger: 50 });
  }

  // Likewise a pile vanishing into an opponent's hand.
  if (pickup && pickup.player !== YOU && pickup.cards.length) {
    const items = pickup.cards.slice(-4).map((c) => ({ card: c, rect: discardR }));
    await ui.flyCards(items, ui.seatRect(st, YOU, pickup.player), { duration: 340, stagger: 45, spread: 6 });
  }

  const prev = ui.snapshot();
  render();

  const enterFrom = (el, fid) => {
    if (ui.els['discard-cards'].contains(el)) return opts.fromRect || seatR;
    const owner = ownerOf(el, fid);
    if (pickup && owner === pickup.player) return discardR;
    return deckR;
  };
  await ui.flipFrom(prev, enterFrom, { duration: burn ? 220 : 420 });

  for (const ev of events) await announce(ev);
  ui.clearFX();
  render();
  return res;
}

function ownerOf(el, fid) {
  if (ui.els['my-hand'].contains(el) || ui.els['my-stacks'].contains(el)) return YOU;
  const m = /^[hb](\d+)-/.exec(fid);
  if (m) return Number(m[1]);
  const box = el.closest('.opp');
  return box ? Number(box.dataset.p) : -1;
}

async function announce(ev) {
  const st = app.state;
  const nameOf = (i) => (i === YOU ? 'You' : st.players[i].name);
  switch (ev.type) {
    case 'burn': {
      await ui.burnFX(ui.discardRect());
      ui.toast(ev.reason === 'ten'
        ? '<span class="em">◉</span> Ten burns the pile'
        : '<span class="em">◉</span> Four of a kind burned', { big: true, ms: 1500 });
      await sleep(ui.reduced.matches ? 60 : 380);
      break;
    }
    case 'skip':
      ui.toast(`${nameOf(ev.player)} skipped`, { ms: 1300 });
      await sleep(ui.reduced.matches ? 40 : 280);
      break;
    case 'pickup':
      if (ev.cards.length) {
        ui.toast(`${nameOf(ev.player)} ${ev.player === YOU ? 'take' : 'takes'} ${ev.cards.length} card${ev.cards.length === 1 ? '' : 's'}`, { ms: 1300 });
      }
      break;
    case 'out':
      ui.toast(`${nameOf(ev.player)} out — ${ordinalWord(ev.place)}`, { big: true, ms: 1700 });
      await sleep(ui.reduced.matches ? 60 : 420);
      break;
    case 'game-over':
      await sleep(450);
      showResults();
      break;
    default:
      break;
  }
}

function ordinalWord(n) {
  return ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;
}

/* --------------------------------------------------------- human turn --- */

function toggleSelect(id) {
  const legal = myLegalIds();
  const card = cardById(id);
  if (!card) return;
  if (!legal.has(id)) {
    ui.shake(ui.cardElById(id));
    const req = pileRequirement(app.state.pile);
    ui.toast(req.kind === 'lower' ? 'A 7 is showing — play 7 or lower' : `Needs ${rankLabel(req.rank)} or higher`, { ms: 1200 });
    return;
  }
  if (app.selection.has(id)) app.selection.delete(id);
  else {
    const cur = [...app.selection][0];
    if (cur && cardById(cur).r !== card.r) app.selection.clear();
    app.selection.add(id);
  }
  render();
}

async function playSelection(extraId) {
  if (!interactive()) return false;
  const ids = new Set(app.selection);
  if (extraId) ids.add(extraId);
  if (!ids.size) return false;
  const first = cardById([...ids][0]);
  for (const id of ids) if (cardById(id).r !== first.r) ids.delete(id);

  const legal = myLegalIds();
  if (![...ids].every((id) => legal.has(id))) return false;

  app.selection.clear();
  if (online()) { sendNet({ kind: 'play', cardIds: [...ids] }); return true; }
  await guarded(() => applyAction(YOU, () => playCards(app.state, YOU, [...ids])));
  render();
  runLoop();
  return true;
}

async function takePile() {
  if (!interactive()) return;
  app.selection.clear();
  if (online()) { sendNet({ kind: 'pickup' }); return; }
  await guarded(() => applyAction(YOU, () => pickUpPile(app.state, YOU)));
  render();
  runLoop();
}

async function flipMyBlind(slotIndex) {
  if (!interactive() || myZone() !== 'blind') return;
  const me = app.state.players[YOU];
  const card = me.blind[slotIndex];
  if (!card) return;
  const rect = ui.slotRect(slotIndex);
  if (online()) { sendNet({ kind: 'blind', cardId: card.id }); return; }
  await guarded(async () => {
    render();
    await ui.blindReveal(rect, card);
    await applyAction(YOU, () => playBlind(app.state, YOU, card.id), { fromRect: rect });
  });
  render();
  runLoop();
}

/**
 * Every state-changing action runs inside this: `busy` is always released, even
 * if the choreography throws, so a bad animation can never strand the turn.
 */
async function guarded(fn) {
  app.busy = true;
  try {
    return await fn();
  } catch (err) {
    console.error('[shithead] action failed', err);
    return null;
  } finally {
    app.busy = false;
  }
}

// Last line of defence: if anything ever leaves the game unable to accept
// input on the player's own turn, unstick it rather than freezing.
setInterval(() => {
  if (online()) return;   // online, the host's pushes are the heartbeat
  if (!app.state || app.state.phase !== 'playing') return;
  // Fingerprint the game; any progress at all resets the clock, so long but
  // legitimate sequences (a bot burning and going again) are never disturbed.
  const fp = `${app.state.turnCount}:${app.state.current}:${app.state.pile.length}:${app.state.deck.length}:${app.state.finishOrder.length}`;
  if (!app.busy || fp !== app.wdFp) {
    app.wdFp = fp;
    app.stuckSince = app.busy ? Date.now() : 0;
    return;
  }
  app.stuckSince = app.stuckSince || Date.now();
  if (Date.now() - app.stuckSince > 12000) {
    console.warn('[shithead] watchdog: releasing a stuck turn');
    app.stuckSince = 0;
    app.busy = false;
    looping = false;
    ui.clearFX();
    render();
    runLoop();
  }
}, 1000);

/* ----------------------------------------------------------- bot loop --- */

let looping = false;

async function runLoop() {
  if (looping || online()) return;   // an online party is all humans
  looping = true;
  try {
    while (app.state.phase === 'playing' && app.state.players[app.state.current].isBot) {
      const pi = app.state.current;
      app.thinking = pi;
      app.busy = true;
      render();
      await sleep(thinkDelay());
      app.thinking = null;

      const move = chooseMove(app.state, pi);
      try {
        if (move.action === 'pickup') {
          await applyAction(pi, () => pickUpPile(app.state, pi));
        } else if (move.action === 'blind') {
          const card = app.state.players[pi].blind.find((c) => c.id === move.cardId);
          const box = ui.els.opponents.querySelector(`.opp[data-p="${pi}"] .opp-stack`);
          const rect = box ? box.getBoundingClientRect() : ui.seatRect(app.state, YOU, pi);
          await ui.blindReveal(rect, card);
          await applyAction(pi, () => playBlind(app.state, pi, move.cardId), { fromRect: rect });
        } else {
          await applyAction(pi, () => playCards(app.state, pi, move.cardIds));
        }
      } catch (err) {
        console.error('[shithead] bot turn failed', err);
        render();
      }
      await sleep(180);
    }
  } finally {
    looping = false;
    app.busy = false;
    app.thinking = null;
    render();
  }
}

/* ------------------------------------------------------------ results --- */

function showResults() {
  if (app.overShown) return;
  app.overShown = true;
  app.mode = 'over';
  ui.closeAllSheets();
  const st = app.state;
  const list = document.getElementById('results');
  list.textContent = '';
  st.finishOrder.forEach((pi, i) => {
    const p = st.players[pi];
    const li = document.createElement('li');
    if (i === 0) li.classList.add('first');
    if (pi === YOU) li.classList.add('you');
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = i + 1;
    const name = document.createElement('span');
    name.textContent = pi === YOU ? 'You' : p.name;
    const tail = document.createElement('span');
    tail.className = 'tail';
    const left = cardsLeft(p);
    tail.textContent = left ? `${left} card${left === 1 ? '' : 's'} left` : 'cleared out';
    li.append(place, name, tail);
    list.append(li);
  });

  const iWon = st.finishOrder[0] === YOU;
  const myPlace = st.finishOrder.indexOf(YOU) + 1;
  document.getElementById('over-title').textContent = iWon ? 'You win' : `${ordinalWord(myPlace)} place`;
  document.getElementById('over-sub').textContent = iWon
    ? 'Cleared the lot — hand, face-ups and blind.'
    : `${st.players[st.finishOrder[0]].name} got out first.`;
  ui.openSheet('sheet-over');
  if (iWon) confetti();
}

function confetti() {
  if (ui.reduced.matches) return;
  const r = { left: window.innerWidth / 2 - 40, top: window.innerHeight * 0.34, width: 80, height: 80,
    right: window.innerWidth / 2 + 40, bottom: window.innerHeight * 0.34 + 80 };
  ui.burnFX(r);
}

/* ------------------------------------------------------ online party ---- */

/**
 * Every push from the host lands here. Pushes are applied one at a time — the
 * choreography is async, and two overlapping renders would fight each other.
 */
let netQueue = Promise.resolve();

function onNetState(s, events) {
  app.netState = s;
  netQueue = netQueue
    .then(() => applyNetState(s, events || []))
    .catch((err) => console.error('[shithead] state push failed', err));
}

async function applyNetState(s, events) {
  app.pending = 0;
  renderLobby(s);

  if (s.stage !== 'game' || !s.game) {
    // The host sent us back to the lobby — clear the table and wait there.
    if (app.state) {
      app.state = null;
      app.mode = 'setup';
      app.overShown = false;
      app.selection.clear();
      ui.clearFX();
      $('board').classList.add('pre-game');
      ui.setStatus('Shithead');
      showPane(s.isHost ? 'pane-host' : 'pane-wait');
      const hint = $('wait-hint');
      if (hint) hint.textContent = 'Waiting for the host to deal again…';
      ui.openSheet('sheet-setup');
    }
    return;
  }
  if (s.you < 0) return;                 // we're not seated (shouldn't happen)

  const firstFrame = !app.state;
  YOU = s.you;

  if (firstFrame) {
    app.selection.clear();
    app.swapPicks = [null, null, null];
    app.overShown = false;
    ui.clearFX();
    await ui.closeAllSheets();
    $('board').classList.remove('pre-game');
  }

  const burn = events.find((e) => e.type === 'burn');
  const play = events.find((e) => e.type === 'play' || e.type === 'blind-flip');
  const pickup = events.find((e) => e.type === 'pickup');
  const flip = events.find((e) => e.type === 'blind-flip');

  const discardR = ui.discardRect();
  const deckR = ui.deckRect();

  // Turn the blind card over where it sits, for everyone, before the board
  // changes underneath it.
  if (flip && !firstFrame) {
    const rect = flip.player === YOU ? myBlindRect(flip.card.id) : oppStackRect(flip.player);
    if (rect) await ui.blindReveal(rect, flip.card);
  }

  // Cards that a burn is about to delete get flown onto the pile first, or
  // they'd never be seen landing.
  if (burn && play && !firstFrame) {
    const played = play.cards || [play.card];
    const items = played.map((c) => {
      const el = ui.cardElById(c.id);
      const rect = el ? el.getBoundingClientRect() : ui.seatRect(app.state, YOU, play.player);
      if (el) el.style.visibility = 'hidden';
      return { card: c, rect };
    });
    await ui.flyCards(items, discardR, { duration: 300, stagger: 50 });
  }

  // Likewise a pile vanishing into somebody else's hand.
  if (pickup && pickup.player !== YOU && pickup.cards.length && !firstFrame) {
    const items = pickup.cards.slice(-4).map((c) => ({ card: c, rect: discardR }));
    await ui.flyCards(items, ui.seatRect(app.state, YOU, pickup.player), { duration: 340, stagger: 45, spread: 6 });
  }

  const prev = firstFrame ? new Map() : ui.snapshot();
  app.state = s.game;

  const me = s.game.players[YOU];
  if (s.game.phase === 'swap') app.mode = me.swapped ? 'play' : 'swap';
  else app.mode = 'play';
  if (me.swapped) app.swapPicks = [null, null, null];

  render();

  const enterFrom = (el, fid) => {
    if (ui.els['discard-cards'].contains(el)) return discardR;
    if (pickup && ownerOf(el, fid) === pickup.player) return discardR;
    return deckR;
  };
  await ui.flipFrom(prev, firstFrame ? (() => deckR) : enterFrom,
    { duration: burn ? 220 : 420, stagger: firstFrame ? 26 : 0 });

  for (const ev of events) await announce(ev);
  ui.clearFX();
  render();

  if (s.game.phase === 'over') showResults();
}

function myBlindRect(cardId) {
  const i = app.state?.players[YOU]?.blind.findIndex((c) => c.id === cardId);
  return i >= 0 ? ui.slotRect(i) : null;
}

function oppStackRect(playerIndex) {
  const box = ui.els.opponents.querySelector(`.opp[data-p="${playerIndex}"] .opp-stack`);
  return box ? box.getBoundingClientRect() : ui.seatRect(app.state, YOU, playerIndex);
}

/* -- lobby ---------------------------------------------------------------- */

const PANES = ['pane-home', 'pane-bots', 'pane-online', 'pane-host', 'pane-join', 'pane-wait'];

function showPane(id) {
  for (const p of PANES) {
    const el = $(p);
    if (el) el.hidden = p !== id;
  }
  const body = document.querySelector('#sheet-setup .sheet-body');
  if (body) body.scrollTop = 0;
}

function myName() {
  const input = $('my-name');
  const typed = (input?.value || '').trim().slice(0, 14);
  const name = typed || storedName() || 'Player';
  try { localStorage.setItem('shithead_name', name); } catch { /* ignore */ }
  return name;
}

function storedName() {
  try { return localStorage.getItem('shithead_name') || ''; } catch { return ''; }
}

function renderLobby(s) {
  if (!s) return;
  const list = $(s.isHost ? 'host-lobby' : 'join-lobby');
  if (!list) return;
  list.textContent = '';

  for (const seat of s.seats) {
    const li = document.createElement('li');
    if (!seat.connected) li.classList.add('off');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = seat.name + (seat.isYou ? ' (you)' : '');
    li.append(dot, name);
    if (seat.isHost) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'Host';
      li.append(tag);
    } else if (!seat.connected) {
      const tail = document.createElement('span');
      tail.className = 'waiting';
      tail.textContent = 'reconnecting…';
      li.append(tail);
    }
    list.append(li);
  }
  for (let i = s.seats.length; i < net.MAX_PLAYERS; i++) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'empty seat';
    list.append(li);
  }

  if (s.isHost) {
    const start = $('btn-start');
    if (start) start.disabled = s.seats.length < net.MIN_PLAYERS || s.stage !== 'lobby';
    const hint = $('host-hint');
    if (hint && s.stage === 'lobby') {
      hint.textContent = s.seats.length < net.MIN_PLAYERS
        ? 'Waiting for someone to join…'
        : `${s.seats.length} at the table. Start when you're ready.`;
    }
  }
}

/* -- hosting -------------------------------------------------------------- */

function joinURL(code) {
  const u = new URL(window.location.href);
  u.hash = '';
  u.search = '?join=' + code;
  return u.toString();
}

function drawQR(code) {
  const wrap = document.querySelector('.qr-wrap');
  const canvas = $('room-qr');
  if (!window.QRCode || !canvas) { if (wrap) wrap.hidden = true; return; }
  wrap.hidden = false;
  window.QRCode.toCanvas(canvas, joinURL(code), { width: 168, margin: 0 }, (err) => {
    if (err) { console.warn('[shithead] QR failed', err); wrap.hidden = true; }
  });
}

async function hostParty() {
  const name = myName();
  showPane('pane-host');
  $('host-hint').textContent = 'Opening a room…';
  $('room-code').textContent = '····';
  document.querySelector('.qr-wrap').hidden = true;

  const session = new net.HostSession({
    hostName: name,
    onState: onNetState,
    onLog: (m) => ui.toast(m, { ms: 1800 }),
  });
  try {
    const code = await session.open();
    app.net = {
      isHost: true,
      session,
      send(action) {
        const res = session.applyAction(session.hostId, action);
        if (!res.ok) { app.pending = 0; ui.toast(net.reasonText(res.reason), { ms: 1500 }); }
        return res.ok;
      },
    };
    $('room-code').textContent = code;
    drawQR(code);
    renderLobby(app.netState);
  } catch (err) {
    session.close();
    app.net = null;
    showPane('pane-online');
    ui.toast(err.message || 'Could not open a room.', { ms: 2400 });
  }
}

/* -- joining -------------------------------------------------------------- */

function setJoinStatus(text) {
  const el = $('join-status');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
}

async function joinParty() {
  const code = ($('join-code').value || '').trim().toUpperCase();
  if (code.length < 4) { setJoinStatus('A room code is four or five characters.'); return; }
  const name = myName();
  setJoinStatus('Connecting…');
  $('btn-join').disabled = true;

  const session = new net.ClientSession(code, name, {
    onState: onNetState,
    onError: (msg) => { app.pending = 0; ui.toast(msg, { ms: 1800 }); render(); },
    onStatus: onNetStatus,
  });
  try {
    await session.connect();
    app.net = { isHost: false, session, send: (action) => session.sendAction(action) };
    setJoinStatus('');
    showPane('pane-wait');
    renderLobby(app.netState);
  } catch (err) {
    session.close();
    setJoinStatus(err.message || 'Could not join that party.');
  } finally {
    $('btn-join').disabled = false;
  }
}

function onNetStatus(status) {
  const hint = $('wait-hint');
  if (status === 'reconnecting') {
    ui.setStatus('Reconnecting…');
    if (hint) hint.textContent = 'Lost the host — trying to get back in…';
  } else if (status === 'connected') {
    if (hint) hint.textContent = 'Waiting for the host to deal…';
    if (app.state) render();
  } else if (status === 'gave-up') {
    ui.toast("Couldn't get back to the party.", { ms: 2600 });
    if (hint) hint.textContent = "Couldn't reach the host. The party may be over.";
  }
}

/* -- leaving -------------------------------------------------------------- */

function leaveParty({ quiet = false } = {}) {
  if (!app.net) return;
  try { app.net.session.close(); } catch { /* ignore */ }
  app.net = null;
  app.netState = null;
  app.state = null;
  app.mode = 'setup';
  app.overShown = false;
  netQueue = Promise.resolve();
  app.pending = 0;
  ui.clearFX();
  if (!quiet) {
    $('board').classList.add('pre-game');
    ui.setStatus('Shithead');
    showPane('pane-home');
  }
}

/* ----------------------------------------------------------- handlers --- */

ui.initUI({
  canGrab(id) {
    if (app.mode === 'swap') return true;
    if (!interactive()) return false;
    const zone = myZone();
    if (zone !== 'hand' && zone !== 'faceUp') return false;
    return !!cardById(id);
  },

  onGrab(id) {
    if (app.mode === 'play' && interactive()) {
      const legal = myLegalIds();
      if (legal.has(id) && !app.selection.has(id)) {
        const cur = [...app.selection][0];
        if (cur && cardById(cur).r !== cardById(id).r) app.selection.clear();
        app.selection.add(id);
        updateChrome();
      }
    }
  },

  dropTargetAt(x, y, id) {
    if (app.mode === 'swap') {
      const slots = ui.els['my-stacks'].children;
      for (let i = 0; i < slots.length; i++) {
        if (ui.nearRect(slots[i], x, y, 26)) return { kind: 'slot', index: i };
      }
      return null;
    }
    if (ui.nearRect(ui.els.discard, x, y, 40)) return { kind: 'discard' };
    return null;
  },

  wouldBeLegal(id) {
    if (app.mode === 'swap') return true;
    return myLegalIds().has(id);
  },

  onDrop(id, el, target) {
    if (app.mode === 'swap') {
      if (target.kind !== 'slot') return false;
      if (app.swapPicks.includes(id)) {
        // moving an already-placed card to another slot
        const from = app.swapPicks.indexOf(id);
        const to = target.index;
        const prev = ui.snapshot();
        [app.swapPicks[from], app.swapPicks[to]] = [app.swapPicks[to], app.swapPicks[from]];
        render();
        ui.flipFrom(prev, null, { duration: 360 });
        return true;
      }
      if (app.swapPicks[target.index]) return false;
      const prev = ui.snapshot();
      app.swapPicks[target.index] = id;
      render();
      ui.flipFrom(prev, null, { duration: 380 });
      return true;
    }
    if (target.kind !== 'discard') return false;
    if (!myLegalIds().has(id)) return false;
    playSelection(id);
    return true;
  },

  onTap(id) {
    if (app.mode === 'swap') {
      if (app.swapPicks.includes(id)) swapReturn(id);
      else swapPlace(id);
      updateChrome();
      return;
    }
    if (!interactive()) return;
    toggleSelect(id);
  },
});

/* --------------------------------------------------------------- bind --- */

document.getElementById('btn-rules').addEventListener('click', () => ui.openSheet('sheet-rules'));
document.getElementById('btn-rules-2').addEventListener('click', () => ui.openSheet('sheet-rules'));
document.getElementById('btn-new').addEventListener('click', () => {
  showPane(online() ? (app.net.isHost ? 'pane-host' : 'pane-wait') : 'pane-home');
  ui.openSheet('sheet-setup');
});
document.getElementById('btn-again').addEventListener('click', async () => {
  await ui.closeSheet('sheet-over');
  if (online()) {
    // Keep the party together: the host re-deals to the same seats.
    if (app.net.isHost) { app.net.session.resetToLobby(); return; }
    showPane('pane-wait');
    const hint = $('wait-hint');
    if (hint) hint.textContent = 'Waiting for the host to deal again…';
    ui.openSheet('sheet-setup');
    return;
  }
  showPane('pane-home');
  ui.openSheet('sheet-setup');
});

/* -- start-screen panes --------------------------------------------------- */

document.querySelector('#sheet-setup .sheet-body').addEventListener('click', (e) => {
  const back = e.target.closest('[data-pane]');
  if (back) showPane(back.dataset.pane);
});

$('btn-mode-bots').addEventListener('click', () => showPane('pane-bots'));
$('btn-mode-online').addEventListener('click', () => {
  const input = $('my-name');
  if (input && !input.value) input.value = storedName();
  showPane('pane-online');
});
$('btn-host').addEventListener('click', hostParty);
$('btn-join-pane').addEventListener('click', () => { setJoinStatus(''); showPane('pane-join'); });

$('btn-start').addEventListener('click', () => {
  if (app.net?.isHost) app.net.session.startGame();
});
$('btn-host-cancel').addEventListener('click', () => leaveParty());
$('btn-leave').addEventListener('click', () => leaveParty());
$('btn-join').addEventListener('click', joinParty);
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinParty(); });
$('join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// The room code is the invite: tapping it copies a link that opens the game
// with the code already filled in.
$('room-code').addEventListener('click', async () => {
  const code = app.net?.isHost && app.net.session.code;
  if (!code) return;
  const link = joinURL(code);
  let ok = false;
  try {
    await navigator.clipboard.writeText(link);
    ok = true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { /* ignore */ }
  }
  const el = $('room-code');
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 900);
  ui.toast(ok ? 'Invite link copied' : `Room code: ${code}`, { ms: 1400 });
});

document.getElementById('player-count').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-n]');
  if (!b) return;
  app.numPlayers = Number(b.dataset.n);
  for (const x of e.currentTarget.children) {
    const on = x === b;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', String(on));
  }
});

document.getElementById('btn-deal').addEventListener('click', async () => {
  await ui.closeSheet('sheet-setup');
  if (ui.sheetIsOpen('sheet-over')) await ui.closeSheet('sheet-over');
  deal();
});

document.getElementById('btn-action').addEventListener('click', () => {
  if (app.mode === 'swap') { confirmSwap(); return; }
  if (app.state?.phase === 'over') {
    showPane(online() ? (app.net.isHost ? 'pane-host' : 'pane-wait') : 'pane-home');
    ui.openSheet('sheet-setup');
    return;
  }
  if (app.selection.size) { playSelection(); return; }
  if (!myLegalIds().size) takePile();
});

document.getElementById('btn-secondary').addEventListener('click', () => {
  if (app.mode !== 'swap') return;
  const prev = ui.snapshot();
  app.swapPicks = [null, null, null];
  render();
  ui.flipFrom(prev, null, { duration: 380 });
});

// tapping a face-down blind card (no data-id, so the drag layer ignores it)
ui.els['my-stacks'].addEventListener('click', (e) => {
  const slot = e.target.closest('.my-slot');
  if (!slot || app.mode !== 'play') return;
  if (myZone() !== 'blind') return;
  flipMyBlind(Number(slot.dataset.slot));
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});

// iOS: stop the page itself from being dragged around.
document.addEventListener('touchmove', (e) => {
  if (!e.target.closest('.sheet-scroll')) e.preventDefault();
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ---------------------------------------------------------------- go ---- */

ui.setStatus('Shithead');

// ?join=ABCD — the QR code and the copied invite link both land here, so a
// guest arrives with the code already typed in for them.
const invite = new URLSearchParams(location.search).get('join');
if (invite && /^[A-Z0-9]{4,5}$/i.test(invite)) {
  $('my-name').value = storedName();
  $('join-code').value = invite.toUpperCase();
  showPane('pane-join');
} else {
  showPane('pane-home');
}

ui.openSheet('sheet-setup', { modal: true });
