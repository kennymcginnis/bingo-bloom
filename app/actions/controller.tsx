import { createController } from 'remix/router'

import { assets } from '../assets.ts'
import { addChatMessage, chatMessages, claim, createGame, findGame, gameState, joinGame, playerBoardState, setCalled, setMark } from '../data/database.ts'
import { findDuplicateWords, normalizeWords, requiredWords } from '../data/game-rules.ts'
import { routes } from '../routes.ts'
import { GamePage } from './game-page.tsx'
import { HomePage } from './home-page.tsx'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json()
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function bearer(request: Request) {
  return request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
}

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },
    home(context) {
      return context.render(<HomePage />)
    },
    join(context) {
      return context.render(<HomePage initialPanel="join" initialCode={context.params.code.toUpperCase()} />)
    },
    game(context) {
      return context.render(<GamePage role="player" code={context.params.code} />)
    },
    host(context) {
      return context.render(<GamePage role="admin" code={context.params.code} />)
    },
    async createGame({ request }) {
      const body = await readJson(request)
      const title = String(body.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 80)
      const size = Number(body.size)
      const duplicates = findDuplicateWords(body.words)
      const words = normalizeWords(body.words)
      if (!title) return json({ error: 'Give your game a title.' }, 400)
      if (![3, 4, 5, 6].includes(size)) return json({ error: 'Choose a card size from 3×3 through 6×6.' }, 400)
      if (duplicates.length) {
        const shown = duplicates.slice(0, 5).join(', ')
        const remaining = duplicates.length > 5 ? `, and ${duplicates.length - 5} more` : ''
        return json({ error: `Remove duplicate phrase${duplicates.length === 1 ? '' : 's'}: ${shown}${remaining}.` }, 400)
      }
      if (words.length < requiredWords(size)) return json({ error: `${size}×${size} cards need at least ${requiredWords(size)} unique phrases.` }, 400)
      if (words.length > 250) return json({ error: 'Keep the list to 250 phrases or fewer.' }, 400)
      try {
        return json(createGame(title, size, words), 201)
      } catch (error) {
        console.error('Could not persist game', error)
        return json({ error: 'The game could not be saved. No partial game was created; please try again.' }, 500)
      }
    },
    gameState({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: "That game code doesn't exist." }, 404)
      const state = gameState(game, bearer(request))
      return state ? json(state) : json({ error: 'Join this game first.' }, 401)
    },
    playerBoard({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (bearer(request) !== game.admin_token) return json({ error: 'Organizer access required.' }, 403)
      const playerId = Number(params.playerId)
      if (!Number.isInteger(playerId) || playerId < 1) return json({ error: 'Player not found.' }, 404)
      const board = playerBoardState(game, playerId)
      return board ? json(board) : json({ error: 'Player not found.' }, 404)
    },
    chatMessages({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      const messages = chatMessages(game, bearer(request))
      return messages ? json({ messages }) : json({ error: 'Game access required.' }, 401)
    },
    async joinGame({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: "That game code doesn't exist." }, 404)
      const body = await readJson(request)
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      if (!name) return json({ error: 'Enter your name to join.' }, 400)
      try {
        return json(joinGame(game, name), 201)
      } catch {
        return json({ error: "Couldn't create another unique card. Add more phrases and try again." }, 409)
      }
    },
    async sendChatMessage({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      const body = await readJson(request)
      const text = String(body.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 280)
      if (!text) return json({ error: 'Write a message first.' }, 400)
      const message = addChatMessage(game, bearer(request), text)
      return message ? json({ message }, 201) : json({ error: 'Game access required.' }, 401)
    },
    async callWord({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (bearer(request) !== game.admin_token) return json({ error: 'Organizer access required.' }, 403)
      const body = await readJson(request)
      return setCalled(game, Number(body.wordId), Boolean(body.called)) ? json({ ok: true }) : json({ error: 'Phrase not found.' }, 404)
    },
    async markSquare({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      const body = await readJson(request)
      const result = setMark(game, bearer(request), Number(body.position), Boolean(body.marked))
      return 'error' in result ? json({ error: result.error }, result.status) : json(result)
    },
    claimBingo({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      const result = claim(game, bearer(request))
      return 'error' in result ? json({ valid: false, error: result.error }, result.status) : json(result)
    },
  },
})
