import { get, post, route } from 'remix/routes'

export const routes = route({
	assets: get('/assets/*path'),
	health: get('/health'),
	home: '/',
	join: get('/join/:code'),
	game: get('/game/:code'),
	host: get('/host/:code'),
	createGame: post('/api/games'),
	gameState: get('/api/games/:code'),
	gameEvents: get('/api/games/:code/events'),
	playerBoard: get('/api/games/:code/players/:playerId'),
	chatMessages: get('/api/games/:code/chat'),
	joinGame: post('/api/games/:code/join'),
	rejoinGame: post('/api/games/:code/rejoin'),
	sendChatMessage: post('/api/games/:code/chat'),
	callWord: post('/api/games/:code/call'),
	markSquare: post('/api/games/:code/mark'),
	claimBingo: post('/api/games/:code/claim'),
	lockGame: post('/api/games/:code/lock'),
	endGame: post('/api/games/:code/end'),
	cloneGame: post('/api/games/:code/clone'),
})
