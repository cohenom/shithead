/*
 * network.js — online "party" mode.
 *
 * Browser-to-browser multiplayer over WebRTC, brokered by PeerJS's free public
 * cloud. There is no backend and no accounts: the *host's own tab* is the
 * table. It runs the real game.js engine and holds the one true state; every
 * other player is a thin client that renders whatever redacted state the host
 * pushes and sends back action *requests* for the host to validate.
 *
 * The one thing that has to be airtight here is `redact()`. A card game where a
 * client can read another player's hand out of a network message is not a game,
 * so hidden cards never leave the host as anything but an opaque, value-free
 * placeholder. See test-net.mjs.
 *
 * DOM-free and window-free at module scope, so Node can import it for tests.
 * `window.Peer` (the PeerJS UMD build) is only touched inside the sessions.
 */

import { newGame, commitSwap, playCards, playBlind, pickUpPile } from './game.js';

/* --------------------------------------------------------------- ids ----- */

// No I/O/0/1 — these get read aloud and typed on a phone keyboard.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBytes(n) {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && c.getRandomValues) c.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

export function makeCode(len = 4) {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export function genId() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  return 'id-' + Array.from(randomBytes(16)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A player id that survives a refresh, keyed by room code — so reloading the
 * page drops you back into the same seat instead of spawning a new one.
 */
export function storedPlayerId(code) {
  const key = 'shithead_pid_' + code;
  try {
    let id = localStorage.getItem(key);
    if (!id) { id = genId(); localStorage.setItem(key, id); }
    return id;
  } catch {
    return genId();
  }
}

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;
export const SWAP_TIMEOUT_MS = 60000;

/* ---------------------------------------------------------- redaction ---- */

/**
 * Stand-ins for cards the recipient is not allowed to see. They carry an id
 * (so the renderer has a stable key to animate) and nothing else — no rank, no
 * suit, no way back to the real card.
 */
function hiddenList(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: `${prefix}#${i}`, hidden: true });
  return out;
}

const clone = (cards) => cards.map((c) => ({ id: c.id, r: c.r, s: c.s }));

/**
 * Redact one engine state for one seat.
 *
 * Public in Shithead, and sent verbatim: the discard pile, the burn pile,
 * everybody's face-up row (once play has begun), and every count.
 * Private, and never sent as values: any other player's hand, any other
 * player's blind cards, the undealt stock, and — until play begins — the
 * face-up row a player has already chosen but not yet revealed.
 *
 * You get your own hand and your own blind cards in full, exactly as the
 * offline game already holds them in your tab.
 */
export function redactGame(game, you) {
  if (!game) return null;
  const swapping = game.phase === 'swap';
  return {
    players: game.players.map((p, i) => {
      const mine = i === you;
      return {
        index: p.index,
        name: p.name,
        isBot: false,
        connected: p.connected !== false,
        swapped: p.swapped,
        finishedAt: p.finishedAt,
        handCount: p.hand.length,
        blindCount: p.blind.length,
        faceUpCount: p.faceUp.length,
        hand: mine ? clone(p.hand) : hiddenList(p.hand.length, `h${i}`),
        blind: mine ? clone(p.blind) : hiddenList(p.blind.length, `b${i}`),
        // A face-up row chosen during the swap stays hidden until everyone has
        // chosen — otherwise whoever picks last picks with extra information.
        faceUp: (mine || !swapping) ? clone(p.faceUp) : hiddenList(p.faceUp.length, `f${i}`),
      };
    }),
    // The stock is face-down to everyone, the host included. Counts only.
    deck: hiddenList(game.deck.length, 'd'),
    deckCount: game.deck.length,
    pile: clone(game.pile),
    burned: clone(game.burned),
    current: game.current,
    phase: game.phase,
    finishOrder: game.finishOrder.slice(),
    turnCount: game.turnCount,
  };
}

/**
 * Redact the whole party snapshot for one player.
 * @param {{code:string, stage:string, hostId:string, seats:object[], game:object|null}} state
 * @param {string} forPlayerId
 */
export function redact(state, forPlayerId) {
  const you = state.seats.findIndex((s) => s.id === forPlayerId);
  return {
    code: state.code,
    stage: state.stage,
    you,
    yourId: forPlayerId,
    isHost: forPlayerId === state.hostId,
    seats: state.seats.map((s, i) => ({
      index: i,
      name: s.name,
      connected: !!s.connected,
      isHost: s.id === state.hostId,
      isYou: s.id === forPlayerId,
    })),
    game: redactGame(state.game, you),
  };
}

/* ------------------------------------------------------------ messages --- */

const REASONS = {
  'not-your-turn': "It isn't your turn.",
  'not-playing': 'The hand has not started yet.',
  'blind-zone': 'Turn over a blind card instead.',
  'not-blind-zone': 'Play from your hand first.',
  'must-flip-blind': 'You have to turn a blind card over.',
  'have-legal-play': 'You have a legal play — you must make it.',
  'bad-card': "You don't have that card.",
  illegal: "That card doesn't beat the pile.",
  'need-3': 'Pick exactly three cards.',
  'not-swapping': 'Your face-up row is already set.',
  'no-seat': "You aren't seated at this table.",
  'not-started': 'The game has not started yet.',
  'unknown-action': 'That move made no sense.',
};

export function reasonText(reason) {
  return REASONS[reason] || 'That move was rejected.';
}

/* ---------------------------------------------------------------- host --- */

export class HostSession {
  constructor({ hostName = 'Host', onState, onLog } = {}) {
    this.code = null;
    this.hostId = genId();
    this.stage = 'lobby';           // 'lobby' | 'game'
    this.seats = [{ id: this.hostId, name: hostName, connected: true }];
    this.game = null;
    this.peer = null;
    this.conns = new Map();         // playerId -> DataConnection
    this.onState = onState || (() => {});
    this.onLog = onLog || (() => {});
    this._swapTimer = null;
    this._closed = false;
  }

  snapshot() {
    return {
      code: this.code,
      stage: this.stage,
      hostId: this.hostId,
      seats: this.seats,
      game: this.game,
    };
  }

  /** Open a room, retrying with a fresh code if PeerJS says it's taken. */
  async open() {
    const Peer = globalThis.Peer;
    if (!Peer) throw new Error('PeerJS failed to load — check your connection.');
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = makeCode(attempt < 3 ? 4 : 5);
      try {
        await this._openWith(Peer, code);
        this.code = code;
        this._broadcast();
        return code;
      } catch (err) {
        lastErr = err;
        if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } this.peer = null; }
        if (err && err.message === 'taken') continue;
        throw err;
      }
    }
    throw lastErr || new Error('Could not open a room. Try again.');
  }

  _openWith(Peer, code) {
    return new Promise((resolve, reject) => {
      const peer = new Peer(code, { debug: 0 });
      this.peer = peer;
      let settled = false;
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        peer.on('connection', (conn) => this._handleConnection(conn));
        resolve();
      });
      peer.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err && err.type === 'unavailable-id'
            ? new Error('taken')
            : new Error('Network error: ' + (err && err.type ? err.type : 'unknown')));
          return;
        }
        this.onLog('Network error: ' + (err && err.type ? err.type : 'unknown'));
      });
    });
  }

  _handleConnection(conn) {
    let playerId = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'join') {
        const res = this._seat(msg.playerId, String(msg.name || 'Player').slice(0, 14));
        if (!res.ok) { try { conn.send({ type: 'error', message: res.message, fatal: true }); } catch { /* ignore */ } return; }
        playerId = msg.playerId;
        const existing = this.conns.get(playerId);
        if (existing && existing !== conn) { try { existing.close(); } catch { /* ignore */ } }
        this.conns.set(playerId, conn);
        try { conn.send({ type: 'welcome', playerId, code: this.code }); } catch { /* ignore */ }
        this._broadcast();
      } else if (msg.type === 'action' && playerId) {
        const res = this.applyAction(playerId, msg.action);
        if (!res.ok) {
          try { conn.send({ type: 'error', message: reasonText(res.reason) }); } catch { /* ignore */ }
        }
      }
    });
    conn.on('close', () => {
      if (!playerId) return;
      if (this.conns.get(playerId) === conn) this.conns.delete(playerId);
      this._setConnected(playerId, false);
      this._broadcast();
    });
    conn.on('error', () => { /* 'close' does the bookkeeping */ });
  }

  /** Seat a joiner, or re-seat one who dropped and came back. */
  _seat(playerId, name) {
    if (!playerId) return { ok: false, message: 'Bad join request.' };
    const seat = this.seats.find((s) => s.id === playerId);
    if (seat) {
      seat.name = name || seat.name;
      seat.connected = true;
      return { ok: true };
    }
    if (this.stage !== 'lobby') return { ok: false, message: 'That game has already started.' };
    if (this.seats.length >= MAX_PLAYERS) return { ok: false, message: 'That party is full.' };
    this.seats.push({ id: playerId, name, connected: true });
    return { ok: true };
  }

  _setConnected(playerId, on) {
    const seat = this.seats.find((s) => s.id === playerId);
    if (seat) seat.connected = on;
    // Mirror onto the engine state so the renderer can show it on the seat.
    const i = this.seats.findIndex((s) => s.id === playerId);
    if (this.game && i >= 0 && this.game.players[i]) this.game.players[i].connected = on;
  }

  seatIndexOf(playerId) {
    return this.seats.findIndex((s) => s.id === playerId);
  }

  canStart() {
    return this.stage === 'lobby' && this.seats.length >= MIN_PLAYERS;
  }

  startGame() {
    if (!this.canStart()) return false;
    this.game = newGame({ players: this.seats.map((s) => ({ name: s.name, isBot: false })) });
    for (let i = 0; i < this.seats.length; i++) this.game.players[i].connected = this.seats[i].connected;
    this.stage = 'game';
    this._armSwapTimeout();
    this._broadcast();
    return true;
  }

  /** Back to the lobby after a finished game, so the same party can re-deal. */
  resetToLobby() {
    this._clearSwapTimeout();
    this.stage = 'lobby';
    this.game = null;
    this._broadcast();
    return true;
  }

  /**
   * Validate and apply one player's action through the real engine. Every
   * legality question is answered by game.js, exactly as it is offline.
   */
  applyAction(playerId, action) {
    const seat = this.seatIndexOf(playerId);
    if (seat < 0) return { ok: false, reason: 'no-seat' };
    if (!this.game) return { ok: false, reason: 'not-started' };
    if (!action || typeof action !== 'object') return { ok: false, reason: 'unknown-action' };

    let res;
    switch (action.kind) {
      case 'swap':
        res = commitSwap(this.game, seat, Array.isArray(action.cardIds) ? action.cardIds : []);
        break;
      case 'play':
        res = playCards(this.game, seat, Array.isArray(action.cardIds) ? action.cardIds : []);
        break;
      case 'blind':
        res = playBlind(this.game, seat, action.cardId);
        break;
      case 'pickup':
        res = pickUpPile(this.game, seat);
        break;
      default:
        res = { ok: false, reason: 'unknown-action' };
    }
    if (res.ok) {
      if (this.game.phase !== 'swap') this._clearSwapTimeout();
      this._broadcast(res.events || []);
    }
    return res;
  }

  /* -- the deal-time face-up swap happens simultaneously; one AFK player
        must not be able to stall the table forever. ------------------------ */

  _armSwapTimeout() {
    this._clearSwapTimeout();
    if (typeof setTimeout !== 'function') return;
    this._swapTimer = setTimeout(() => {
      this._swapTimer = null;
      if (!this.game || this.game.phase !== 'swap') return;
      for (const p of this.game.players) {
        if (p.swapped) continue;
        // Bank the three strongest cards face-up — what a sane player picks.
        const ids = p.hand.slice()
          .sort((a, b) => power(b) - power(a))
          .slice(0, 3)
          .map((c) => c.id);
        commitSwap(this.game, p.index, ids);
      }
      this._broadcast();
    }, SWAP_TIMEOUT_MS);
  }

  _clearSwapTimeout() {
    if (this._swapTimer) { clearTimeout(this._swapTimer); this._swapTimer = null; }
  }

  swapDeadline() { return this._swapTimer ? SWAP_TIMEOUT_MS : 0; }

  _broadcast(events = []) {
    if (this._closed) return;
    const snap = this.snapshot();
    for (const [playerId, conn] of this.conns) {
      if (!conn.open) continue;
      try { conn.send({ type: 'state', state: redact(snap, playerId), events }); } catch { /* ignore */ }
    }
    this.onState(redact(snap, this.hostId), events);
  }

  refresh() { this._broadcast(); }

  close() {
    this._closed = true;
    this._clearSwapTimeout();
    for (const conn of this.conns.values()) { try { conn.close(); } catch { /* ignore */ } }
    this.conns.clear();
    if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } this.peer = null; }
  }
}

function power(c) {
  if (c.r === 10) return 16;
  if (c.r === 2) return 15.5;
  if (c.r === 8) return 14.5;
  return c.r;
}

/* -------------------------------------------------------------- client --- */

export class ClientSession {
  constructor(code, name, { onState, onError, onStatus } = {}) {
    this.code = String(code || '').toUpperCase().trim();
    this.name = name;
    this.playerId = storedPlayerId(this.code);
    this.onState = onState || (() => {});
    this.onError = onError || (() => {});
    this.onStatus = onStatus || (() => {});
    this.peer = null;
    this.conn = null;
    this._retries = 0;
    this.isHost = false;
  }

  connect() {
    const Peer = globalThis.Peer;
    if (!Peer) return Promise.reject(new Error('PeerJS failed to load — check your connection.'));
    return new Promise((resolve, reject) => {
      const peer = new Peer(undefined, { debug: 0 });
      this.peer = peer;
      let settled = false;
      const done = (err) => {
        if (settled) return false;
        settled = true;
        if (err) reject(err); else resolve();
        return true;
      };
      peer.on('open', () => {
        this._wire(peer.connect(this.code, { reliable: true }), done);
      });
      peer.on('error', (err) => {
        const message = err && err.type === 'peer-unavailable'
          ? 'No party found with that code.'
          : 'Network error: ' + (err && err.type ? err.type : 'unknown');
        if (!done(new Error(message))) this.onError(message);
      });
    });
  }

  _wire(conn, done) {
    this.conn = conn;
    conn.on('open', () => {
      try { conn.send({ type: 'join', playerId: this.playerId, name: this.name }); } catch { /* ignore */ }
    });
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'welcome') {
        this._retries = 0;
        this.onStatus('connected');
        if (done) done(null);
      } else if (msg.type === 'state') {
        this.onState(msg.state, msg.events || []);
      } else if (msg.type === 'error') {
        if (msg.fatal) {
          this._retries = 999;
          if (done) done(new Error(msg.message));
          else this.onError(msg.message);
          this.onStatus('rejected');
        } else {
          this.onError(msg.message);
        }
      }
    });
    conn.on('close', () => {
      this.onStatus('disconnected');
      if (done) done(new Error('The party closed before you got in.'));
      this._tryReconnect();
    });
    conn.on('error', (err) => { if (done) done(err); });
  }

  /** Exponential backoff — the host may just be reloading their tab. */
  _tryReconnect() {
    if (this._retries >= 5) { this.onStatus('gave-up'); return; }
    this._retries++;
    this.onStatus('reconnecting');
    const delay = Math.min(1000 * 2 ** this._retries, 15000);
    setTimeout(() => {
      if (!this.peer || this.peer.destroyed) return;
      try {
        this._wire(this.peer.connect(this.code, { reliable: true }), null);
      } catch {
        this._tryReconnect();
      }
    }, delay);
  }

  sendAction(action) {
    if (this.conn && this.conn.open) {
      try { this.conn.send({ type: 'action', action }); return true; } catch { /* ignore */ }
    }
    this.onError('Not connected — hold on.');
    return false;
  }

  close() {
    this._retries = 999;
    if (this.conn) { try { this.conn.close(); } catch { /* ignore */ } this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } this.peer = null; }
  }
}

if (typeof window !== 'undefined') {
  window.ShitheadNet = { HostSession, ClientSession, redact, redactGame, makeCode, genId, storedPlayerId, reasonText };
}
