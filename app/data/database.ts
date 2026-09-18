import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { publishGameEvent } from './game-events.ts'
import { bestLineProgress, cardSignature, makeCard, makeCode, makeToken, validateClaim } from './game-rules.ts'

mkdirSync(process.env.DATA_DIR ?? './db', { recursive: true })
const databasePath = join(process.env.DATA_DIR ?? './db', 'bingo.sqlite')
const sqlite = new DatabaseSync(databasePath)

sqlite.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY, 
		code        TEXT UNIQUE NOT NULL, 
		title       TEXT NOT NULL,
		size        INTEGER NOT NULL, 
		admin_token TEXT UNIQUE NOT NULL,
		joining_locked INTEGER NOT NULL DEFAULT 0,
		ended_at    TEXT,
		created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS words (
    id       INTEGER PRIMARY KEY, 
		game_id  INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		text     TEXT NOT NULL, 
		position INTEGER NOT NULL, 
		called   INTEGER NOT NULL DEFAULT 0, 
		UNIQUE(game_id, position)
  );
  CREATE TABLE IF NOT EXISTS players (
    id             INTEGER PRIMARY KEY, 
		game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		name           TEXT NOT NULL, 
		token          TEXT UNIQUE NOT NULL, 
		card_json      TEXT NOT NULL,
		card_signature TEXT NOT NULL, 
		rejoin_code    TEXT,
		claimed_at     TEXT, 
		verified       INTEGER,
		joined_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
		UNIQUE(game_id, card_signature)
  );
  CREATE TABLE IF NOT EXISTS marks (
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
		cell_position INTEGER NOT NULL, 
		PRIMARY KEY(player_id, cell_position)
  );
  CREATE TABLE IF NOT EXISTS chat_messages (
    id          INTEGER PRIMARY KEY, 
		game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
		player_id   INTEGER REFERENCES players(id) ON DELETE CASCADE,
		sender_role TEXT NOT NULL DEFAULT 'player' CHECK(sender_role IN ('player', 'host')),
		text        TEXT NOT NULL, 
		created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS chat_messages_game_id_id ON chat_messages(game_id, id);
`)

const gameColumns = sqlite.prepare('PRAGMA table_info(games)').all() as Array<{ name: string }>
if (!gameColumns.some((column) => column.name === 'joining_locked')) {
  sqlite.exec('ALTER TABLE games ADD COLUMN joining_locked INTEGER NOT NULL DEFAULT 0')
}
if (!gameColumns.some((column) => column.name === 'ended_at')) {
  sqlite.exec('ALTER TABLE games ADD COLUMN ended_at TEXT')
}

const playerColumns = sqlite.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>
if (!playerColumns.some((column) => column.name === 'rejoin_code')) {
  sqlite.exec('ALTER TABLE players ADD COLUMN rejoin_code TEXT')
}
sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS players_game_rejoin_code ON players(game_id, rejoin_code)')

export type GameRow = {
  id: number
  code: string
  title: string
  size: number
  admin_token: string
  joining_locked: number
  ended_at: string | null
}
export type PlayerRow = {
  id: number
  game_id: number
  name: string
  token: string
  card_json: string
  rejoin_code: string | null
  claimed_at: string | null
  verified: number | null
  joined_at: string
}

function makeRejoinCode(gameId: number): string {
  let code = makeCode()
  while (sqlite.prepare('SELECT 1 FROM players WHERE game_id = ? AND rejoin_code = ?').get(gameId, code)) {
    code = makeCode()
  }
  return code
}

const playersMissingRejoinCodes = sqlite
  .prepare('SELECT id, game_id FROM players WHERE rejoin_code IS NULL')
  .all() as Array<{ id: number; game_id: number }>
const updateRejoinCode = sqlite.prepare('UPDATE players SET rejoin_code = ? WHERE id = ?')
for (const player of playersMissingRejoinCodes) updateRejoinCode.run(makeRejoinCode(player.game_id), player.id)

export function findGame(code: string): GameRow | undefined {
  return sqlite.prepare('SELECT * FROM games WHERE code = ?').get(code.toUpperCase()) as GameRow | undefined
}

export function createGame(title: string, size: number, words: string[]) {
  let code = makeCode()
  while (findGame(code)) code = makeCode()
  const adminToken = makeToken()
  const addGame = sqlite.prepare(
    'INSERT INTO games (code, title, size, admin_token) VALUES (?, ?, ?, ?) RETURNING id',
  )
  const addWord = sqlite.prepare('INSERT INTO words (game_id, text, position) VALUES (?, ?, ?)')
  sqlite.exec('BEGIN IMMEDIATE')
  try {
    const game = addGame.get(code, title, size, adminToken) as { id: number }
    words.forEach((word, index) => addWord.run(game.id, word.slice(0, 120), index))
    sqlite.exec('COMMIT')
    return { code, adminToken }
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

export function joinGame(game: GameRow, name: string) {
  const wordIds = (sqlite.prepare('SELECT id FROM words WHERE game_id = ?').all(game.id) as Array<{ id: number }>).map(
    (row) => row.id,
  )
  let card: Array<number | null> = []
  for (let attempt = 0; attempt < 60; attempt += 1) {
    card = makeCard(wordIds, game.size)
    const exists = sqlite
      .prepare('SELECT 1 FROM players WHERE game_id = ? AND card_signature = ?')
      .get(game.id, cardSignature(card))
    if (!exists) break
  }
  const token = makeToken()
  const rejoinCode = makeRejoinCode(game.id)
  sqlite
    .prepare('INSERT INTO players (game_id, name, token, card_json, card_signature, rejoin_code) VALUES (?, ?, ?, ?, ?, ?)')
    .run(game.id, name, token, JSON.stringify(card), cardSignature(card), rejoinCode)
  publishGameEvent(game.id, { type: 'state' })
  return { playerToken: token, rejoinCode }
}

export function rejoinGame(game: GameRow, rejoinCode: string) {
  const player = sqlite
    .prepare('SELECT token, name FROM players WHERE game_id = ? AND rejoin_code = ?')
    .get(game.id, rejoinCode.toUpperCase()) as Pick<PlayerRow, 'token' | 'name'> | undefined
  return player ? { playerToken: player.token, name: player.name } : null
}

export function gameState(game: GameRow, token: string) {
  const isAdmin = token === game.admin_token
  const player = isAdmin
    ? undefined
    : (sqlite.prepare('SELECT * FROM players WHERE game_id = ? AND token = ?').get(game.id, token) as
        | PlayerRow
        | undefined)
  if (!isAdmin && !player) return null
  const words = sqlite
    .prepare('SELECT id, text, position, called FROM words WHERE game_id = ? ORDER BY position')
    .all(game.id) as Array<{ id: number; text: string; position: number; called: number }>
  const state: Record<string, unknown> = {
    code: game.code,
    title: game.title,
    size: game.size,
    joiningLocked: Boolean(game.joining_locked),
    endedAt: game.ended_at,
    role: isAdmin ? 'admin' : 'player',
    words: isAdmin ? words : [],
  }
  if (isAdmin) {
    const players = sqlite
      .prepare('SELECT id, name, card_json, joined_at, claimed_at, verified FROM players WHERE game_id = ? ORDER BY joined_at')
      .all(game.id) as Array<Pick<PlayerRow, 'id' | 'name' | 'card_json' | 'joined_at' | 'claimed_at' | 'verified'>>
    const markRows = sqlite
      .prepare('SELECT marks.player_id, marks.cell_position FROM marks JOIN players ON players.id = marks.player_id WHERE players.game_id = ?')
      .all(game.id) as Array<{ player_id: number; cell_position: number }>
    const marksByPlayer = new Map<number, number[]>()
    for (const mark of markRows) {
      const marks = marksByPlayer.get(mark.player_id) ?? []
      marks.push(mark.cell_position)
      marksByPlayer.set(mark.player_id, marks)
    }
    state.players = players.map(({ card_json, ...player }) => ({
      ...player,
      best_line_progress: bestLineProgress({
        card: JSON.parse(card_json) as Array<number | null>,
        marks: marksByPlayer.get(player.id) ?? [],
        size: game.size,
      }),
    }))
  } else if (player) {
    const cardIds = JSON.parse(player.card_json) as Array<number | null>
    const lookup = new Map(words.map((word) => [word.id, word.text]))
    state.player = {
      name: player.name,
      claimedAt: player.claimed_at,
      verified: player.verified,
      rejoinCode: player.rejoin_code,
    }
    state.card = cardIds.map((id) => (id === null ? { free: true, text: 'FREE' } : { id, text: lookup.get(id) }))
    state.marks = (
      sqlite.prepare('SELECT cell_position FROM marks WHERE player_id = ?').all(player.id) as Array<{
        cell_position: number
      }>
    ).map((row) => row.cell_position)
  }
  return state
}

export function playerBoardState(game: GameRow, playerId: number) {
  const player = sqlite
    .prepare('SELECT * FROM players WHERE id = ? AND game_id = ?')
    .get(playerId, game.id) as PlayerRow | undefined
  if (!player) return null

  const words = sqlite
    .prepare('SELECT id, text, called FROM words WHERE game_id = ?')
    .all(game.id) as Array<{ id: number; text: string; called: number }>
  const lookup = new Map(words.map((word) => [word.id, word]))
  const cardIds = JSON.parse(player.card_json) as Array<number | null>
  const marks = (
    sqlite.prepare('SELECT cell_position FROM marks WHERE player_id = ?').all(player.id) as Array<{
      cell_position: number
    }>
  ).map((row) => row.cell_position)

  return {
    player: {
      id: player.id,
      name: player.name,
      joined_at: player.joined_at,
      claimed_at: player.claimed_at,
      verified: player.verified,
    },
    card: cardIds.map((id) => {
      if (id === null) return { free: true, text: 'FREE' }
      const word = lookup.get(id)
      return { id, text: word?.text, called: Boolean(word?.called) }
    }),
    marks,
  }
}

export function authorizedPlayer(game: GameRow, token: string): PlayerRow | undefined {
  return sqlite.prepare('SELECT * FROM players WHERE game_id = ? AND token = ?').get(game.id, token) as
    | PlayerRow
    | undefined
}

export function chatMessages(game: GameRow, token: string) {
  const player = authorizedPlayer(game, token)
  const isHost = token === game.admin_token
  if (!isHost && !player) return null
  const messages = sqlite.prepare(`
    SELECT chat_messages.id, chat_messages.player_id, chat_messages.sender_role,
      chat_messages.text, chat_messages.created_at, players.name
    FROM chat_messages LEFT JOIN players ON players.id = chat_messages.player_id
    WHERE chat_messages.game_id = ? ORDER BY chat_messages.id DESC LIMIT 100
  `).all(game.id) as Array<{ id: number; player_id: number | null; sender_role: 'player' | 'host'; text: string; created_at: string; name: string | null }>
  return messages.reverse().map((message) => ({
    id: message.id,
    name: message.sender_role === 'host' ? 'Host' : message.name ?? 'Player',
    role: message.sender_role,
    text: message.text,
    created_at: message.created_at,
    own: message.sender_role === 'host' ? isHost : message.player_id === player?.id,
  }))
}

export function addChatMessage(game: GameRow, token: string, text: string) {
  const player = authorizedPlayer(game, token)
  const isHost = token === game.admin_token
  if (!isHost && !player) return null
  const role = isHost ? 'host' : 'player'
  const result = sqlite
    .prepare('INSERT INTO chat_messages (game_id, player_id, sender_role, text) VALUES (?, ?, ?, ?) RETURNING id, created_at')
    .get(game.id, player?.id ?? null, role, text) as { id: number; created_at: string }
  const message = { ...result, playerId: player?.id ?? null, name: isHost ? 'Host' : player?.name ?? 'Player', role, text }
  publishGameEvent(game.id, { type: 'chat', message })
  return { ...message, own: true }
}

export function setCalled(game: GameRow, wordId: number, called: boolean) {
  const word = sqlite.prepare('SELECT id FROM words WHERE id = ? AND game_id = ?').get(wordId, game.id)
  if (!word) return false
  sqlite.prepare('UPDATE words SET called = ? WHERE id = ?').run(called ? 1 : 0, wordId)
  publishGameEvent(game.id, { type: 'state' })
  return true
}

export function setMark(game: GameRow, token: string, position: number, marked: boolean) {
  const player = authorizedPlayer(game, token)
  if (!player) return { error: 'Player access required.', status: 401 }
  const card = JSON.parse(player.card_json) as Array<number | null>
  if (!Number.isInteger(position) || position < 0 || position >= card.length || card[position] === null) {
    return { error: 'That square cannot be changed.', status: 400 }
  }
  if (marked) sqlite.prepare('INSERT OR IGNORE INTO marks (player_id, cell_position) VALUES (?, ?)').run(player.id, position)
  else sqlite.prepare('DELETE FROM marks WHERE player_id = ? AND cell_position = ?').run(player.id, position)
  sqlite.prepare('UPDATE players SET claimed_at = NULL, verified = NULL WHERE id = ?').run(player.id)
  publishGameEvent(game.id, { type: 'state' })
  return { ok: true }
}

export function claim(game: GameRow, token: string) {
  const player = authorizedPlayer(game, token)
  if (!player) return { error: 'Player access required.', status: 401 }
  const card = JSON.parse(player.card_json) as Array<number | null>
  const marks = (
    sqlite.prepare('SELECT cell_position FROM marks WHERE player_id = ?').all(player.id) as Array<{
      cell_position: number
    }>
  ).map((row) => row.cell_position)
  const calledWordIds = (
    sqlite.prepare('SELECT id FROM words WHERE game_id = ? AND called = 1').all(game.id) as Array<{ id: number }>
  ).map((row) => row.id)
  const result = validateClaim({ card, marks, calledWordIds, size: game.size })
  sqlite
    .prepare('UPDATE players SET claimed_at = CURRENT_TIMESTAMP, verified = ? WHERE id = ?')
    .run(result.valid ? 1 : 0, player.id)
  publishGameEvent(game.id, { type: 'state' })
  return result.valid
    ? { valid: true }
    : {
        valid: false,
        status: 422,
        error: result.wrong.length
          ? `${result.wrong.length} marked square${result.wrong.length === 1 ? ' is' : 's are'} not on the called list.`
          : "You don't have a complete row, column, or diagonal yet.",
      }
}

export function hasGameAccess(game: GameRow, token: string) {
  return token === game.admin_token || Boolean(authorizedPlayer(game, token))
}

export function setJoiningLocked(game: GameRow, locked: boolean) {
  if (game.ended_at) return false
  sqlite.prepare('UPDATE games SET joining_locked = ? WHERE id = ?').run(locked ? 1 : 0, game.id)
  publishGameEvent(game.id, { type: 'state' })
  return true
}

export function endGame(game: GameRow) {
  sqlite.prepare('UPDATE games SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP), joining_locked = 1 WHERE id = ?').run(game.id)
  publishGameEvent(game.id, { type: 'state' })
}

export function cloneGame(game: GameRow) {
  const words = sqlite
    .prepare('SELECT text FROM words WHERE game_id = ? ORDER BY position')
    .all(game.id) as Array<{ text: string }>
  return createGame(game.title, game.size, words.map((word) => word.text))
}

export function databaseHealth() {
  const result = sqlite.prepare('SELECT 1 AS ok').get() as { ok: number }
  return result.ok === 1
}

export function closeDatabase() {
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  sqlite.close()
}
