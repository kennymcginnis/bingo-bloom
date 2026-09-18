export type GameEvent =
  | { type: 'chat'; message: Record<string, unknown> }
  | { type: 'state' }

type Listener = (event: GameEvent) => void

const listeners = new Map<number, Set<Listener>>()

export function publishGameEvent(gameId: number, event: GameEvent) {
  for (const listener of listeners.get(gameId) ?? []) listener(event)
}

export function subscribeToGame(gameId: number, listener: Listener) {
  const gameListeners = listeners.get(gameId) ?? new Set<Listener>()
  gameListeners.add(listener)
  listeners.set(gameId, gameListeners)
  return () => {
    gameListeners.delete(listener)
    if (gameListeners.size === 0) listeners.delete(gameId)
  }
}
