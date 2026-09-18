import { get, post, route } from 'remix/routes'

export const routes = route({
  assets: get('/assets/*path'),
  home: '/',
  join: get('/join/:code'),
  game: get('/game/:code'),
  host: get('/host/:code'),
  createGame: post('/api/games'),
  gameState: get('/api/games/:code'),
  playerBoard: get('/api/games/:code/players/:playerId'),
  chatMessages: get('/api/games/:code/chat'),
  joinGame: post('/api/games/:code/join'),
  sendChatMessage: post('/api/games/:code/chat'),
  callWord: post('/api/games/:code/call'),
  markSquare: post('/api/games/:code/mark'),
  claimBingo: post('/api/games/:code/claim'),
})
