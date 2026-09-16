# Shithead

The shedding card game (Shithead / Palace), built for iPhone. A static site — no
build step, no bundler, no backend. Live at
<https://cohenom.github.io/shithead/>.

Two ways to play:

- **Play vs Bots** — one to three bots, entirely offline.
- **Play Online** — a party of two to four real people, each on their own phone.

## Files

| file | what it is |
| --- | --- |
| `game.js` | the rules engine. Pure, DOM-free, seedable. |
| `ai.js` | bot decision-making. Pure functions over engine state. |
| `ui.js` | everything that touches the DOM: rendering, FLIP animation, drag. |
| `network.js` | online party mode — PeerJS sessions and state redaction. |
| `app.js` | wiring: the game loop, selection state, and the menu flows. |
| `test-engine.mjs` | 600 simulated games plus rule unit tests. |
| `test-net.mjs` | the redaction contract — what may and may not leave the host. |

```
npm test          # both suites
npm run serve     # http://localhost:8000
```

## How online mode works

Browser-to-browser WebRTC, brokered by [PeerJS](https://peerjs.com)'s free
public cloud. There is no server of ours anywhere in this.

- The **room code is the host's PeerJS id** — four uppercase characters, drawn
  from an alphabet with no `I`, `O`, `0` or `1` in it, because people read these
  out loud and type them on a phone keyboard.
- **The host's tab is the table.** It runs the real `game.js` engine and holds
  the one true state. Every other player is a thin client: it renders whatever
  the host pushes and sends back action *requests* (`play`, `blind`, `pickup`,
  `swap`), which the host validates through the engine's ordinary legality
  checks before applying. A client cannot make an illegal move, because a client
  cannot make a move at all — it can only ask.
- **Nothing private leaves the host.** `redact(state, forPlayerId)` in
  `network.js` sends each player their own hand and blind cards in full, and
  everyone else's hidden cards as value-free placeholders — a count, and nothing
  to read. The undealt stock goes the same way. Public information (the discard
  pile, the burn pile, face-up rows once play has begun, every count) goes
  through verbatim. `test-net.mjs` asserts all of it, including a search of the
  serialised wire payload for card ids that shouldn't be in it.
- **Reconnects** keep your seat. Your player id is stored in `localStorage` keyed
  by room code, so a refresh puts you back where you were; a dropped player is
  marked disconnected in the state rather than removed, and the client retries
  with exponential backoff.
- **The face-up swap** happens simultaneously, so the host holds everyone at a
  "2/3 ready" gate until all have chosen — with a 60-second fallback that picks
  for anyone who has wandered off, so one AFK player can't stall the table. Until
  play begins, the rows people have already chosen stay hidden from each other.

The limitation that comes with having no backend: **if the host closes their tab,
the party is over.** Same deal as the sibling
[Poker Party](https://github.com/cohenom/poker) project this borrows its shape
from.

## Testing WebRTC

`test-net.mjs` covers redaction and the host's action validation in Node. The
peer handshake itself needs two real browsers and real internet, so that part is
tested by opening the site on two phones.
