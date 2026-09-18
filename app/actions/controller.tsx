import { createController } from 'remix/router'

import { assets } from '../assets.ts'
import {
  addChatMessage,
  chatMessages,
  claim,
  cloneGame,
  createGame,
  databaseHealth,
  endGame,
  findGame,
  gameState,
  hasGameAccess,
  joinGame,
  playerBoardState,
  rejoinGame,
  setCalled,
  setJoiningLocked,
  setMark,
  type GameRow,
} from '../data/database.ts'
import { subscribeToGame } from '../data/game-events.ts'
import { findDuplicateWords, normalizeWords, requiredWords } from '../data/game-rules.ts'
import { routes } from '../routes.ts'
import { checkRateLimit, requestAddress } from '../utils/rate-limit.ts'
import { GamePage } from './game-page.tsx'
import { HomePage } from './home-page.tsx'

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
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

function adminGame(request: Request, code: string): { game: GameRow } | { response: Response } {
  const game = findGame(code)
  if (!game) return { response: json({ error: 'Game not found.' }, 404) }
  if (bearer(request) !== game.admin_token) return { response: json({ error: 'Organizer access required.' }, 403) }
  return { game }
}

function endedResponse() {
  return json({ error: 'This game has ended.' }, 409)
}

export default createController(routes, {
  actions: {
    async assets(context) {
      return (await assets.fetch(context.request)) ?? new Response('Not Found', { status: 404 })
    },
    health() {
      try {
        return databaseHealth()
          ? json({ status: 'ok' })
          : json({ status: 'unhealthy' }, 503)
      } catch {
        return json({ status: 'unhealthy' }, 503)
      }
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
    gameEvents({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      const token = bearer(request)
      if (!hasGameAccess(game, token)) return json({ error: 'Game access required.' }, 401)

      const encoder = new TextEncoder()
      let cleanup = () => {}
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false
          const send = (event: unknown) => {
            if (!closed) controller.enqueue(encoder.encode(`event: game\ndata: ${JSON.stringify(event)}\n\n`))
          }
          send({ type: 'ready' })
          const unsubscribe = subscribeToGame(game.id, send)
          const heartbeat = setInterval(() => {
            if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'))
          }, 15_000)
          cleanup = () => {
            if (closed) return
            closed = true
            clearInterval(heartbeat)
            unsubscribe()
            try { controller.close() } catch {}
          }
          request.signal.addEventListener('abort', cleanup, { once: true })
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
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
      if (game.ended_at) return endedResponse()
      if (game.joining_locked) return json({ error: 'The organizer has locked this game.' }, 409)
      const rate = checkRateLimit(`join:${requestAddress(request)}:${game.id}`, 10, 60_000)
      if (!rate.allowed) return json({ error: 'Too many join attempts. Try again shortly.' }, 429, { 'Retry-After': String(rate.retryAfter) })
      const body = await readJson(request)
      const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
      if (!name) return json({ error: 'Enter your name to join.' }, 400)
      try {
        return json(joinGame(game, name), 201)
      } catch {
        return json({ error: "Couldn't create another unique card. Add more phrases and try again." }, 409)
      }
    },
    async rejoinGame({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: "That game code doesn't exist." }, 404)
      const rate = checkRateLimit(`rejoin:${requestAddress(request)}:${game.id}`, 10, 60_000)
      if (!rate.allowed) return json({ error: 'Too many rejoin attempts. Try again shortly.' }, 429, { 'Retry-After': String(rate.retryAfter) })
      const body = await readJson(request)
      const rejoinCode = String(body.rejoinCode ?? '').trim().toUpperCase()
      if (!/^[A-HJ-NP-Z2-9]{6}$/.test(rejoinCode)) return json({ error: 'Enter your six-character rejoin code.' }, 400)
      const result = rejoinGame(game, rejoinCode)
      return result ? json(result) : json({ error: 'That rejoin code was not found.' }, 404)
    },
    async sendChatMessage({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (game.ended_at) return endedResponse()
      const token = bearer(request)
      const rate = checkRateLimit(`chat:${token || requestAddress(request)}:${game.id}`, 30, 60_000)
      if (!rate.allowed) return json({ error: 'Chat is moving too quickly. Try again shortly.' }, 429, { 'Retry-After': String(rate.retryAfter) })
      const body = await readJson(request)
      const text = String(body.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 280)
      if (!text) return json({ error: 'Write a message first.' }, 400)
      const message = addChatMessage(game, token, text)
      return message ? json({ message }, 201) : json({ error: 'Game access required.' }, 401)
    },
    async callWord({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (bearer(request) !== game.admin_token) return json({ error: 'Organizer access required.' }, 403)
      if (game.ended_at) return endedResponse()
      const body = await readJson(request)
      return setCalled(game, Number(body.wordId), Boolean(body.called)) ? json({ ok: true }) : json({ error: 'Phrase not found.' }, 404)
    },
    async markSquare({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (game.ended_at) return endedResponse()
      const body = await readJson(request)
      const result = setMark(game, bearer(request), Number(body.position), Boolean(body.marked))
      return 'error' in result ? json({ error: result.error }, result.status) : json(result)
    },
    claimBingo({ request, params }) {
      const game = findGame(params.code)
      if (!game) return json({ error: 'Game not found.' }, 404)
      if (game.ended_at) return endedResponse()
      const result = claim(game, bearer(request))
      return 'error' in result ? json({ valid: false, error: result.error }, result.status) : json(result)
    },
    async lockGame({ request, params }) {
      const authorized = adminGame(request, params.code)
      if ('response' in authorized) return authorized.response
      const body = await readJson(request)
      if (authorized.game.ended_at) return endedResponse()
      return setJoiningLocked(authorized.game, Boolean(body.locked))
        ? json({ ok: true })
        : endedResponse()
    },
    endGame({ request, params }) {
      const authorized = adminGame(request, params.code)
      if ('response' in authorized) return authorized.response
      endGame(authorized.game)
      return json({ ok: true })
    },
    cloneGame({ request, params }) {
      const authorized = adminGame(request, params.code)
      if ('response' in authorized) return authorized.response
      try {
        return json(cloneGame(authorized.game), 201)
      } catch (error) {
        console.error('Could not clone game', error)
        return json({ error: 'The new game could not be created.' }, 500)
      }
    },
  },
})
