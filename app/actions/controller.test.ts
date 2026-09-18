import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as assert from 'remix/assert'
import { it } from 'remix/test'

import { routes } from '../routes.ts'

function request(path: string, options?: RequestInit) {
  return new Request(new URL(path, 'http://bingo.test'), options)
}

async function body<T>(response: Response) {
  return await response.json() as T
}

it('runs a complete multiplayer game through the HTTP contract', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'bingo-flow-'))
  process.env.DATA_DIR = dataDir
  const { router } = await import('../router.ts')
  const { closeDatabase } = await import('../data/database.ts')

  try {
    const health = await router.fetch(request(routes.health.href()))
    assert.equal(health.status, 200)

    const create = await router.fetch(request(routes.createGame.href(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Integration game',
        size: 3,
        words: Array.from({ length: 12 }, (_, index) => `Phrase ${index + 1}`),
      }),
    }))
    assert.equal(create.status, 201)
    const created = await body<{ code: string; adminToken: string }>(create)

    const joinResponse = await router.fetch(request(routes.joinGame.href({ code: created.code }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jamie' }),
    }))
    assert.equal(joinResponse.status, 201)
    const joined = await body<{ playerToken: string; rejoinCode: string }>(joinResponse)
    assert.equal(joined.rejoinCode.length, 6)

    const eventAbort = new AbortController()
    const events = await router.fetch(request(routes.gameEvents.href({ code: created.code }), {
      headers: { Authorization: `Bearer ${joined.playerToken}` },
      signal: eventAbort.signal,
    }))
    assert.equal(events.status, 200)
    assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8')
    const eventReader = events.body!.getReader()
    const readyEvent = new TextDecoder().decode((await eventReader.read()).value)
    assert.match(readyEvent, /"type":"ready"/)

    const chat = await router.fetch(request(routes.sendChatMessage.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${joined.playerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello room' }),
    }))
    assert.equal(chat.status, 201)
    const chatEvent = new TextDecoder().decode((await eventReader.read()).value)
    assert.match(chatEvent, /"type":"chat"/)
    assert.match(chatEvent, /Hello room/)
    await eventReader.cancel()
    eventAbort.abort()

    const playerStateResponse = await router.fetch(request(routes.gameState.href({ code: created.code }), {
      headers: { Authorization: `Bearer ${joined.playerToken}` },
    }))
    const playerState = await body<{ card: Array<{ id?: number; free?: boolean }>; marks: number[] }>(playerStateResponse)
    const winningPositions = [0, 1, 2]
    const winningWordIds = winningPositions.map((position) => playerState.card[position]!.id!)

    for (const wordId of winningWordIds) {
      const called = await router.fetch(request(routes.callWord.href({ code: created.code }), {
        method: 'POST',
        headers: { Authorization: `Bearer ${created.adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ wordId, called: true }),
      }))
      assert.equal(called.status, 200)
    }

    for (const position of winningPositions) {
      const marked = await router.fetch(request(routes.markSquare.href({ code: created.code }), {
        method: 'POST',
        headers: { Authorization: `Bearer ${joined.playerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ position, marked: true }),
      }))
      assert.equal(marked.status, 200)
    }

    const claim = await router.fetch(request(routes.claimBingo.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${joined.playerToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }))
    assert.equal(claim.status, 200)
    assert.equal((await body<{ valid: boolean }>(claim)).valid, true)

    const lock = await router.fetch(request(routes.lockGame.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked: true }),
    }))
    assert.equal(lock.status, 200)

    const blockedJoin = await router.fetch(request(routes.joinGame.href({ code: created.code }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Late player' }),
    }))
    assert.equal(blockedJoin.status, 409)

    const rejoin = await router.fetch(request(routes.rejoinGame.href({ code: created.code }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rejoinCode: joined.rejoinCode }),
    }))
    assert.equal(rejoin.status, 200)
    assert.equal((await body<{ playerToken: string }>(rejoin)).playerToken, joined.playerToken)

    const clone = await router.fetch(request(routes.cloneGame.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.adminToken}` },
    }))
    assert.equal(clone.status, 201)
    assert.notEqual((await body<{ code: string }>(clone)).code, created.code)

    const end = await router.fetch(request(routes.endGame.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${created.adminToken}` },
    }))
    assert.equal(end.status, 200)

    const chatAfterEnd = await router.fetch(request(routes.sendChatMessage.href({ code: created.code }), {
      method: 'POST',
      headers: { Authorization: `Bearer ${joined.playerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Too late' }),
    }))
    assert.equal(chatAfterEnd.status, 409)
  } finally {
    closeDatabase()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
