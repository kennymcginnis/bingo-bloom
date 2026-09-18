# Bingo Bloom

A multiplayer, phone-friendly bingo app built as a Remix 3 proof of concept. Organizers paste a phrase list and share a six-character code. Every player gets a unique card, and the server verifies claimed wins against the organizer's official called list.

## What it does

- Creates 3×3, 4×4, classic 5×5, or extended 6×6 games
- Recommends a phrase-pool size from the expected player-count range
- Sorts phrase lists A–Z and flags case-insensitive duplicates before creation
- Restores unfinished game setup and join details from local browser storage
- Generates and persists a different shuffled card for every player
- Keeps organizer and player access private with device-local capability tokens
- Gives players a private rejoin code and organizers a private recovery link
- Shows a scannable QR invite on the organizer dashboard
- Streams chat and room changes live without exposing called phrases to players
- Lets organizers lock joining, end a game, or start again with the same phrase list
- Rejects a claim if any marked square was not officially called
- Confirms complete rows, columns, and diagonals
- Works as one deployable Node service with SQLite persistence

## Run locally

Remix 3 RC requires Node 24.3 or newer.

```sh
nvm use
npm install
npm run dev
```

Open [http://localhost:44100](http://localhost:44100).

Useful checks:

```sh
npm run typecheck
npm test
```

## Deploy

The included `Dockerfile` runs the app on port `3000`. Mount a platform-managed persistent disk at `/data`; the container sets `DATA_DIR=/data` so games survive restarts. The Dockerfile intentionally does not declare `VOLUME`, because Railway requires volumes to be configured through its service settings.

For Render, Railway, Fly.io, or another container host:

1. Deploy this repository using the Dockerfile.
2. Attach a persistent volume mounted at `/data`.
3. Expose container port `3000` over HTTPS.
4. Configure the platform health check to request `/health`.

SQLite is a good fit for a small team and a single application instance. If the app grows to multiple instances, move the persistence functions in `app/data/database.ts` to shared Postgres storage.

Keep the service at one replica while it uses SQLite and the in-process live-event stream. The included `.dockerignore` prevents local databases and host `node_modules` from being copied into the production image.

## Recovery and game controls

- A player's six-character rejoin code restores the same card and marks in another browser.
- **Copy host recovery link** creates a private URL fragment containing organizer access. URL fragments are not sent in HTTP requests, but anyone holding the link can control the game.
- Locking a room blocks new players while still allowing existing players to rejoin.
- Ending a game makes calling, marking, claiming, and chatting read-only. Results remain visible.
- **New game, same phrases** creates a fresh room with clean cards and chat.

## Phrase-pool recommendations

The game setup updates its recommendation as the organizer changes the expected group size or card size:

| Players | Up to 5×5 | 6×6 |
| --- | --- | --- |
| 2–5 | 30–35 phrases | 45–50 phrases |
| 6–15 | 40–50 phrases | 55–65 phrases |
| 16+ | 60–75 phrases | 75–90 phrases |

These are recommendations rather than hard limits. A 6×6 game requires at least 36 unique phrases; even-sized cards do not include a free center.

## How verification works

Players may mark any square they believe occurred. The organizer separately marks phrases as officially called. When a player presses **BINGO**, the server reloads that player's saved card, saved marks, and the official called list directly from SQLite. A win is accepted only when:

1. The marked squares contain a full row, column, or diagonal.
2. Every marked non-free square appears on the official called list.

The verified result immediately appears in the organizer dashboard.
