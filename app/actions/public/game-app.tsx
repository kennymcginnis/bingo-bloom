import { clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/ui'
import { renderSVG } from 'uqr'

type Word = { id: number; text: string; position?: number; called?: number }
type Player = {
	id: number
	name: string
	joined_at: string
	claimed_at: string | null
	verified: number | null
	best_line_progress?: number
}
type CardCell = { id?: number; text: string; free?: boolean; called?: boolean }
type GameState = {
	code: string
	title: string
	size: number
	role: 'admin' | 'player'
	words: Word[]
	joiningLocked: boolean
	endedAt: string | null
	players?: Player[]
	player?: { name: string; claimedAt: string | null; verified: number | null; rejoinCode: string | null }
	card?: CardCell[]
	marks?: number[]
}
type PlayerBoardState = { player: Player; card: CardCell[]; marks: number[] }
type ChatMessage = { id: number; name: string; role: 'player' | 'host'; text: string; created_at: string; own: boolean }

interface GameAppProps extends SerializableProps {
	role: 'admin' | 'player'
	code: string
}

export const GameApp = clientEntry(import.meta.url, function GameApp(handle: Handle<GameAppProps>) {
	let state: GameState | null = null
	let error = ''
	let notice = ''
	let busy = false
	let selectedPlayerId: number | null = null
	let selectedPlayerBoard: PlayerBoardState | null = null
	let playerBoardError = ''
	let loadingPlayerBoard = false
	let messages: ChatMessage[] = []
	let chatError = ''
	let chatBusy = false
	let inviteQr = ''
	const tokenKey = () => `bingo:${handle.props.role}:${handle.props.code}`
	const token = () => localStorage.getItem(tokenKey()) ?? ''
	const auth = () => ({ Authorization: `Bearer ${token()}` })

	const mergeMessage = (message: ChatMessage) => {
		messages = [...messages.filter(existing => existing.id !== message.id), message]
			.sort((left, right) => left.id - right.id)
			.slice(-100)
	}

	const loadPlayerBoard = async (playerId: number, showLoading = true) => {
		if (showLoading) {
			loadingPlayerBoard = true
			playerBoardError = ''
			handle.update()
		}
		try {
			const response = await fetch(`/api/games/${handle.props.code}/players/${playerId}`, {
				headers: auth(),
				cache: 'no-store',
				signal: handle.signal,
			})
			const result = (await response.json()) as PlayerBoardState & { error?: string }
			if (!response.ok) throw new Error(result.error ?? 'Could not load that board.')
			if (selectedPlayerId !== playerId) return
			selectedPlayerBoard = result
			playerBoardError = ''
		} catch (caught) {
			if (!handle.signal.aborted && selectedPlayerId === playerId) {
				playerBoardError = caught instanceof Error ? caught.message : 'Could not load that board.'
			}
		} finally {
			if (selectedPlayerId === playerId) {
				loadingPlayerBoard = false
				handle.update()
			}
		}
	}

	const refresh = async () => {
		if (!token()) {
			error =
				handle.props.role === 'admin'
					? 'This organizer view belongs on the device that created the game.'
					: 'Join this game to receive your card.'
			handle.update()
			return
		}
		try {
			const response = await fetch(`/api/games/${handle.props.code}`, {
				headers: auth(),
				cache: 'no-store',
				signal: handle.signal,
			})
			const result = (await response.json()) as GameState & { error?: string }
			if (!response.ok) throw new Error(result.error ?? 'Could not load the game.')
			state = result
			error = ''
			handle.update()
			if (handle.props.role === 'admin' && selectedPlayerId !== null) void loadPlayerBoard(selectedPlayerId, false)
		} catch (caught) {
			if (!handle.signal.aborted) {
				error = caught instanceof Error ? caught.message : 'Could not load the game.'
				handle.update()
			}
		}
	}

	const refreshChat = async () => {
		if (!token()) return
		try {
			const response = await fetch(`/api/games/${handle.props.code}/chat`, {
				headers: auth(),
				cache: 'no-store',
				signal: handle.signal,
			})
			const result = (await response.json()) as { messages?: ChatMessage[]; error?: string }
			if (!response.ok || !result.messages) throw new Error(result.error ?? 'Could not load chat.')
			messages = result.messages
			chatError = ''
			handle.update()
		} catch (caught) {
			if (!handle.signal.aborted) {
				chatError = caught instanceof Error ? caught.message : 'Could not load chat.'
				handle.update()
			}
		}
	}

	const sendChatMessage = async (text: string) => {
		chatBusy = true
		chatError = ''
		handle.update()
		try {
			const response = await fetch(`/api/games/${handle.props.code}/chat`, {
				method: 'POST',
				headers: { ...auth(), 'Content-Type': 'application/json' },
				body: JSON.stringify({ text }),
			})
			const result = (await response.json()) as { message?: ChatMessage; error?: string }
			if (!response.ok || !result.message) throw new Error(result.error ?? 'Could not send that message.')
			mergeMessage(result.message)
			chatBusy = false
			handle.update()
			return true
		} catch (caught) {
			chatError = caught instanceof Error ? caught.message : 'Could not send that message.'
			chatBusy = false
			handle.update()
			return false
		}
	}

	const waitToReconnect = () =>
		new Promise<void>(resolve => {
			const timeout = setTimeout(resolve, 1_500)
			handle.signal.addEventListener(
				'abort',
				() => {
					clearTimeout(timeout)
					resolve()
				},
				{ once: true },
			)
		})

	const connectEvents = async () => {
		while (!handle.signal.aborted && token()) {
			try {
				const response = await fetch(`/api/games/${handle.props.code}/events`, {
					headers: auth(),
					cache: 'no-store',
					signal: handle.signal,
				})
				if (!response.ok || !response.body) throw new Error('Live updates disconnected.')
				const reader = response.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				while (!handle.signal.aborted) {
					const { value, done } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					const chunks = buffer.split('\n\n')
					buffer = chunks.pop() ?? ''
					for (const chunk of chunks) {
						const data = chunk
							.split('\n')
							.find(line => line.startsWith('data: '))
							?.slice(6)
						if (!data) continue
						const event = JSON.parse(data) as { type?: string }
						if (event.type === 'chat') void refreshChat()
						if (event.type === 'state') void refresh()
					}
				}
			} catch {
				if (handle.signal.aborted) return
			}
			await waitToReconnect()
		}
	}

	handle.queueTask(async () => {
		const fragment = new URLSearchParams(window.location.hash.slice(1))
		const recoveredToken = fragment.get('access')
		if (recoveredToken) {
			localStorage.setItem(tokenKey(), recoveredToken)
			history.replaceState(null, '', window.location.pathname + window.location.search)
		}
		if (handle.props.role === 'admin') {
			const inviteUrl = new URL(`/join/${encodeURIComponent(handle.props.code)}`, window.location.origin).toString()
			try {
				const svg = renderSVG(inviteUrl, { border: 1, pixelSize: 5, blackColor: '#19332f', whiteColor: '#fffaf1' })
				inviteQr = `data:image/svg+xml,${encodeURIComponent(svg)}`
			} catch {}
		}
		void refresh()
		void refreshChat()
		void connectEvents()
		handle.update()
	})

	const post = async (path: string, body?: unknown) => {
		const response = await fetch(`/api/games/${handle.props.code}/${path}`, {
			method: 'POST',
			headers: { ...auth(), 'Content-Type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		})
		const result = (await response.json()) as { error?: string; valid?: boolean }
		if (!response.ok) throw new Error(result.error ?? 'That did not work.')
		return result
	}

	return () => {
		if (!state) return <LoadingPage role={handle.props.role} code={handle.props.code} error={error} />
		return state.role === 'admin' ? (
			<HostDashboard
				state={state}
				notice={notice}
				busy={busy}
				inviteQr={inviteQr}
				messages={messages}
				chatError={chatError}
				chatBusy={chatBusy}
				onSendMessage={sendChatMessage}
				selectedPlayerBoard={selectedPlayerBoard}
				selectedPlayerId={selectedPlayerId}
				playerBoardError={playerBoardError}
				loadingPlayerBoard={loadingPlayerBoard}
				onSelectPlayer={player => {
					selectedPlayerId = player.id
					selectedPlayerBoard = null
					playerBoardError = ''
					void loadPlayerBoard(player.id)
				}}
				onClosePlayer={() => {
					selectedPlayerId = null
					selectedPlayerBoard = null
					playerBoardError = ''
					loadingPlayerBoard = false
					handle.update()
				}}
				onCall={async word => {
					busy = true
					handle.update()
					try {
						await post('call', { wordId: word.id, called: !word.called })
						notice = word.called ? `Removed “${word.text}” from the called list.` : `Called “${word.text}”.`
						await refresh()
					} catch (caught) {
						error = caught instanceof Error ? caught.message : 'Could not update that phrase.'
					}
					busy = false
					handle.update()
				}}
				onCopy={async () => {
					const inviteUrl = new URL(`/join/${encodeURIComponent(handle.props.code)}`, window.location.origin).toString()
					await navigator.clipboard.writeText(inviteUrl)
					notice = 'Invite link copied!'
					handle.update()
				}}
				onCopyRecovery={async () => {
					const recoveryUrl = new URL(`/host/${encodeURIComponent(handle.props.code)}`, window.location.origin)
					recoveryUrl.hash = new URLSearchParams({ access: token() }).toString()
					await navigator.clipboard.writeText(recoveryUrl.toString())
					notice = 'Private host recovery link copied. Keep it secret.'
					handle.update()
				}}
				onToggleLock={async () => {
					busy = true
					handle.update()
					try {
						await post('lock', { locked: !state?.joiningLocked })
						notice = state?.joiningLocked ? 'Players can join again.' : 'New players are now blocked.'
						await refresh()
					} catch (caught) {
						notice = caught instanceof Error ? caught.message : 'Could not update joining.'
					}
					busy = false
					handle.update()
				}}
				onEnd={async () => {
					if (!window.confirm('End this game? Players will no longer be able to mark, chat, or claim Bingo.')) return
					busy = true
					handle.update()
					try {
						await post('end')
						notice = 'Game ended. Results remain available.'
						await refresh()
					} catch (caught) {
						notice = caught instanceof Error ? caught.message : 'Could not end the game.'
					}
					busy = false
					handle.update()
				}}
				onClone={async () => {
					busy = true
					handle.update()
					try {
						const result = (await post('clone')) as { code?: string; adminToken?: string }
						if (!result.code || !result.adminToken) throw new Error('The new game could not be opened.')
						localStorage.setItem(`bingo:admin:${result.code}`, result.adminToken)
						window.location.assign(`/host/${result.code}`)
					} catch (caught) {
						notice = caught instanceof Error ? caught.message : 'Could not create the new game.'
						busy = false
						handle.update()
					}
				}}
			/>
		) : (
			<PlayerBoard
				state={state}
				notice={notice}
				busy={busy}
				messages={messages}
				chatError={chatError}
				chatBusy={chatBusy}
				onSendMessage={sendChatMessage}
				onCopyRejoin={async () => {
					const code = state?.player?.rejoinCode
					if (!code) return
					await navigator.clipboard.writeText(code)
					notice = 'Rejoin code copied! Store it somewhere private.'
					handle.update()
				}}
				onMark={async position => {
					if (!state) return
					const marks = new Set(state.marks ?? [])
					const marked = !marks.has(position)
					marked ? marks.add(position) : marks.delete(position)
					state.marks = [...marks]
					notice = ''
					handle.update()
					try {
						await post('mark', { position, marked })
					} catch (caught) {
						notice = caught instanceof Error ? caught.message : 'Could not save that mark.'
						await refresh()
					}
				}}
				onClaim={async () => {
					busy = true
					notice = ''
					handle.update()
					try {
						await post('claim')
						notice = 'BINGO VERIFIED! Your host can see the win.'
						await refresh()
					} catch (caught) {
						notice = caught instanceof Error ? caught.message : 'Not quite yet.'
					}
					busy = false
					handle.update()
				}}
			/>
		)
	}
})

function LoadingPage(handle: Handle<{ role: 'admin' | 'player'; code: string; error: string }>) {
	return () => (
		<main className="game-shell">
			<header className="game-header">
				<a className="brand" href="/">
					<span className="brand-mark">B</span>
					<span>Bingo Bloom</span>
				</a>
				<span className="code-pill">Game {handle.props.code}</span>
			</header>
			<section className="loading-card">
				<span className="loader" />
				<h1>
					{handle.props.error
						? 'One tiny snag'
						: handle.props.role === 'admin'
						? 'Opening the host desk…'
						: 'Finding your card…'}
				</h1>
				<p>{handle.props.error || 'Shuffling the good stuff.'}</p>
				{handle.props.error && (
					<a className="primary-button inline-button" href="/">
						Back to home
					</a>
				)}
			</section>
		</main>
	)
}

function HostDashboard(
	handle: Handle<{
		state: GameState
		notice: string
		busy: boolean
		inviteQr: string
		messages: ChatMessage[]
		chatError: string
		chatBusy: boolean
		onSendMessage: (text: string) => Promise<boolean>
		selectedPlayerBoard: PlayerBoardState | null
		selectedPlayerId: number | null
		playerBoardError: string
		loadingPlayerBoard: boolean
		onSelectPlayer: (player: Player) => void
		onClosePlayer: () => void
		onCall: (word: Word) => void
		onCopy: () => void
		onCopyRecovery: () => void
		onToggleLock: () => void
		onEnd: () => void
		onClone: () => void
	}>,
) {
	let wordFilter = ''

	return () => {
		const {
			state,
			notice,
			busy,
			inviteQr,
			messages,
			chatError,
			chatBusy,
			onSendMessage,
			selectedPlayerBoard,
			selectedPlayerId,
			playerBoardError,
			loadingPlayerBoard,
			onSelectPlayer,
			onClosePlayer,
			onCall,
			onCopy,
			onCopyRecovery,
			onToggleLock,
			onEnd,
			onClone,
		} = handle.props
		const called = state.words.filter(word => word.called).length
		const normalizedFilter = wordFilter.trim().toLocaleLowerCase()
		const filteredWords = normalizedFilter
			? state.words.filter(word => word.text.toLocaleLowerCase().includes(normalizedFilter))
			: state.words
		const winners = (state.players ?? []).filter(player => player.verified === 1)
		return (
			<main className="game-shell host-shell">
				<header className="game-header">
					<a className="brand" href="/">
						<span className="brand-mark">B</span>
						<span>Bingo Bloom</span>
					</a>
					<div className="header-actions">
						<span className="live-pill">
							<i /> LIVE
						</span>
						<button className="outline-button" type="button" mix={on('click', () => void onCopy())}>
							Copy invite
						</button>
					</div>
				</header>
				<section className="host-hero">
					<div>
						<p className="eyebrow">
							<span /> Organizer desk
						</p>
						<h1>{state.title}</h1>
						<p>Tap a phrase when it officially happens. Players listen and mark their own cards.</p>
					</div>
					<div className="invite-card">
						<div className="game-code">
							<span>GAME CODE</span>
							<strong>{state.code}</strong>
							<small>{state.joiningLocked ? 'Joining is locked' : 'Share this with your team'}</small>
						</div>
						{inviteQr && <img src={inviteQr} alt={`QR code to join game ${state.code}`} />}
					</div>
				</section>
				{notice && <p className="notice">{notice}</p>}
				{state.endedAt && (
					<div className="ended-banner">
						<strong>Game ended</strong>
						<span>Results and boards remain available. Start another game to play again.</span>
					</div>
				)}
				{winners.length > 0 && (
					<div className="winner-banner">
						<span>★</span>
						<div>
							<b>Verified bingo!</b>
							<p>{winners.map(winner => winner.name).join(', ')}</p>
						</div>
					</div>
				)}
				<div className="host-grid">
					<section className="panel call-panel">
						<div className="panel-heading">
							<div>
								<p className="step-label">Caller board</p>
								<h2>What’s been said?</h2>
							</div>
							<span>
								{called} / {state.words.length} called
							</span>
						</div>
						<div className="caller-filter">
							<label className="sr-only" htmlFor={`${handle.id}-word-filter`}>
								Filter caller-board phrases
							</label>
							<div>
								<span aria-hidden="true">⌕</span>
								<input
									id={`${handle.id}-word-filter`}
									type="search"
									value={wordFilter}
									placeholder="Filter phrases…"
									autoComplete="off"
									mix={on('input', event => {
										wordFilter = event.currentTarget.value
										handle.update()
									})}
								/>
								{wordFilter && (
									<button
										type="button"
										aria-label="Clear phrase filter"
										mix={on('click', () => {
											wordFilter = ''
											handle.update()
										})}
									>
										×
									</button>
								)}
							</div>
							<small>
								{normalizedFilter
									? `${filteredWords.length} of ${state.words.length} phrases`
									: `${state.words.length} phrases`}
							</small>
						</div>
						<div className="word-list">
							{filteredWords.length ? (
								filteredWords.map(word => (
									<button
										key={word.id}
										className={word.called ? 'called' : ''}
										disabled={busy || Boolean(state.endedAt)}
										mix={on('click', () => onCall(word))}
									>
										<span>{word.called ? '✓' : String((word.position ?? 0) + 1).padStart(2, '0')}</span>
										{word.text}
									</button>
								))
							) : (
								<div className="filter-empty">
									<span>⌕</span>
									<p>No phrases match “{wordFilter.trim()}”.</p>
									<button
										type="button"
										mix={on('click', () => {
											wordFilter = ''
											handle.update()
										})}
									>
										Clear filter
									</button>
								</div>
							)}
						</div>
					</section>
					<div className="host-sidebar">
						<section className="panel game-controls">
							<div className="panel-heading">
								<div>
									<p className="step-label">Game controls</p>
									<h2>{state.endedAt ? 'Finished' : state.joiningLocked ? 'Room locked' : 'Room open'}</h2>
								</div>
							</div>
							<div>
								<button type="button" disabled={busy || Boolean(state.endedAt)} mix={on('click', onToggleLock)}>
									{state.joiningLocked ? 'Unlock joining' : 'Lock joining'}
								</button>
								<button type="button" mix={on('click', onCopyRecovery)}>
									Copy host recovery link
								</button>
								<button type="button" disabled={busy} mix={on('click', onClone)}>
									New game, same phrases
								</button>
								{!state.endedAt && (
									<button className="danger-control" type="button" disabled={busy} mix={on('click', onEnd)}>
										End game
									</button>
								)}
							</div>
						</section>
						<aside className="panel players-panel">
							<div className="panel-heading">
								<div>
									<p className="step-label">Room</p>
									<h2>{state.players?.length ?? 0} players</h2>
								</div>
							</div>
							{!state.players?.length ? (
								<div className="empty-state">
									<span>⌁</span>
									<p>Waiting for teammates to join…</p>
								</div>
							) : (
								<ul className="player-list">
									{state.players.map(player => {
										const bestLineProgress = player.best_line_progress ?? 0
										return (
											<li key={player.id}>
												<button type="button" mix={on('click', () => onSelectPlayer(player))}>
													<span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span>
													<span className="player-progress">
														<span className="player-progress-label">
															<strong>{player.name}</strong>
															<small>
																{bestLineProgress} / {state.size}
															</small>
														</span>
														<span
															className="player-progress-track"
															role="progressbar"
															aria-label={`${player.name}'s best line progress`}
															aria-valuemin={0}
															aria-valuemax={state.size}
															aria-valuenow={bestLineProgress}
														>
															<span style={{ width: `${(bestLineProgress / state.size) * 100}%` }} />
														</span>
													</span>
													{player.verified === 1 ? (
														<b className="verified">WIN ✓</b>
													) : player.verified === 0 ? (
														<b className="rejected">CHECKED</b>
													) : (
														<i aria-hidden="true">view →</i>
													)}
												</button>
											</li>
										)
									})}
								</ul>
							)}
						</aside>
						<ChatBox
							messages={messages}
							error={chatError}
							busy={chatBusy}
							closed={Boolean(state.endedAt)}
							onSend={onSendMessage}
						/>
					</div>
				</div>
				{selectedPlayerId !== null && (
					<HostPlayerBoard
						board={selectedPlayerBoard}
						size={state.size}
						error={playerBoardError}
						loading={loadingPlayerBoard}
						onClose={onClosePlayer}
					/>
				)}
			</main>
		)
	}
}

function HostPlayerBoard(
	handle: Handle<{
		board: PlayerBoardState | null
		size: number
		error: string
		loading: boolean
		onClose: () => void
	}>,
) {
	handle.queueTask(() => {
		document.addEventListener(
			'keydown',
			event => {
				if (event.key !== 'Escape') return
				event.preventDefault()
				handle.props.onClose()
			},
			{ signal: handle.signal },
		)
	})

	return () => {
		const { board, size, error, loading, onClose } = handle.props
		const marks = new Set(board?.marks ?? [])
		return (
			<div className="board-modal-backdrop" role="presentation">
				<section className="board-modal" role="dialog" aria-modal="true" aria-labelledby="player-board-title">
					<div className="board-modal-heading">
						<div>
							<p className="step-label">Live player view</p>
							<h2 id="player-board-title">{board?.player.name ?? 'Player board'}</h2>
							{board && (
								<p>
									{marks.size} square{marks.size === 1 ? '' : 's'} marked
								</p>
							)}
						</div>
						<button type="button" aria-label="Close player board" mix={on('click', onClose)}>
							×
						</button>
					</div>
					{error ? (
						<p className="form-error" role="alert">
							{error}
						</p>
					) : !board || loading ? (
						<div className="board-modal-loading">
							<span className="loader" />
							<p>Loading their latest board…</p>
						</div>
					) : (
						<div className="board-preview-wrap">
							<div className="bingo-letters" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
								{'BINGO!'
									.slice(0, size)
									.split('')
									.map((letter, index) => (
										<span key={index}>{letter}</span>
									))}
							</div>
							<div className="board-preview" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>
								{board.card.map((cell, position) => {
									const isMarked = cell.free || marks.has(position)
									return (
										<div
											key={position}
											className={`${cell.free ? 'free' : ''} ${isMarked ? 'marked' : ''} ${
												isMarked && !cell.free && !cell.called ? 'not-called' : ''
											}`}
										>
											<span>{cell.text}</span>
											{cell.called && <i>called</i>}
											{isMarked && <b>✓</b>}
										</div>
									)
								})}
							</div>
						</div>
					)}
				</section>
			</div>
		)
	}
}

function PlayerBoard(
	handle: Handle<{
		state: GameState
		notice: string
		busy: boolean
		messages: ChatMessage[]
		chatError: string
		chatBusy: boolean
		onSendMessage: (text: string) => Promise<boolean>
		onCopyRejoin: () => void
		onMark: (position: number) => void
		onClaim: () => void
	}>,
) {
	return () => {
		const { state, notice, busy, messages, chatError, chatBusy, onSendMessage, onCopyRejoin, onMark, onClaim } =
			handle.props
		const marks = new Set(state.marks ?? [])
		return (
			<main className="game-shell player-shell">
				<header className="game-header">
					<a className="brand" href="/">
						<span className="brand-mark">B</span>
						<span>Bingo Bloom</span>
					</a>
					<span className="code-pill">Game {state.code}</span>
				</header>
				<section className="player-intro">
					<div>
						<p className="eyebrow">
							<span /> {state.player?.name}'s card
						</p>
						<h1>{state.title}</h1>
					</div>
				</section>
				{state.endedAt && (
					<div className="ended-banner player-ended">
						<strong>Game ended</strong>
						<span>Your card and the final chat are still available.</span>
					</div>
				)}
				<section className={`card-wrap size-${state.size}`}>
					<div className="bingo-letters" style={{ gridTemplateColumns: `repeat(${state.size}, 1fr)` }}>
						{'BINGO!'
							.slice(0, state.size)
							.split('')
							.map((letter, index) => (
								<span key={index}>{letter}</span>
							))}
					</div>
					<div className="bingo-card" style={{ gridTemplateColumns: `repeat(${state.size}, 1fr)` }}>
						{state.card?.map((cell, position) => {
							const isMarked = cell.free || marks.has(position)
							return (
								<button
									key={position}
									className={`${isMarked ? 'marked' : ''} ${cell.free ? 'free' : ''}`}
									disabled={cell.free || Boolean(state.endedAt)}
									aria-pressed={isMarked}
									mix={cell.free || state.endedAt ? undefined : on('click', () => onMark(position))}
								>
									<span>{cell.text}</span>
									{isMarked && <b>✓</b>}
								</button>
							)
						})}
					</div>
				</section>
				<div className="player-footer">
					<p className="listen-note">
						{state.endedAt ? 'This is your final board.' : 'Listen closely and tap each phrase when you hear it.'}
					</p>
					{notice && (
						<p className={notice.startsWith('BINGO') ? 'success-notice' : 'notice'} role="status">
							{notice}
						</p>
					)}
					{!state.endedAt && (
						<>
							<button className="bingo-button" type="button" disabled={busy} mix={on('click', () => void onClaim())}>
								{busy ? 'Checking your card…' : 'BINGO!'}
							</button>
							<p>We’ll verify every marked square before calling the win.</p>
						</>
					)}{' '}
					{state.player?.rejoinCode && (
						<div className="rejoin-card">
							<span>Keep your card safe</span>
							<strong>{state.player.rejoinCode}</strong>
							<button type="button" mix={on('click', onCopyRejoin)}>
								Copy rejoin code
							</button>
						</div>
					)}
				</div>
				<ChatBox
					messages={messages}
					error={chatError}
					busy={chatBusy}
					closed={Boolean(state.endedAt)}
					onSend={onSendMessage}
				/>
			</main>
		)
	}
}

function ChatBox(
	handle: Handle<{
		messages: ChatMessage[]
		error: string
		busy: boolean
		closed: boolean
		onSend: (text: string) => Promise<boolean>
	}>,
) {
	let messageList: HTMLDivElement | null = null
	let latestMessageId = 0

	return () => {
		const latest = handle.props.messages.at(-1)?.id ?? 0
		if (latest !== latestMessageId) {
			latestMessageId = latest
			handle.queueTask(() => {
				if (messageList) messageList.scrollTop = messageList.scrollHeight
			})
		}

		return (
			<section className="chat-box" aria-labelledby="chat-title">
				<div className="chat-heading">
					<div>
						<p className="step-label">Game Chat</p>
						<h2 id="chat-title">Talk to the room</h2>
					</div>
					<span>
						{handle.props.messages.length} message{handle.props.messages.length === 1 ? '' : 's'}
					</span>
				</div>
				<div
					className="chat-messages"
					aria-live="polite"
					mix={ref(element => {
						messageList = element
					})}
				>
					{handle.props.messages.length === 0 ? (
						<div className="chat-empty">
							<span>✦</span>
							<p>No messages yet. Break the ice!</p>
						</div>
					) : (
						handle.props.messages.map(message => (
							<article
								key={message.id}
								className={`${message.own ? 'own' : ''} ${message.role === 'host' ? 'host-message' : ''}`}
							>
								<div>
									<strong>{message.own ? 'You' : message.name}</strong>
									<time dateTime={message.created_at}>{formatChatTime(message.created_at)}</time>
								</div>
								<p>{message.text}</p>
							</article>
						))
					)}
				</div>
				{handle.props.error && (
					<p className="chat-error" role="alert">
						{handle.props.error}
					</p>
				)}
				{handle.props.closed ? (
					<p className="chat-closed">Chat closed when the game ended.</p>
				) : (
					<form
						className="chat-compose"
						mix={on('submit', async event => {
							event.preventDefault()
							const form = event.currentTarget
							const text = String(new FormData(form).get('message') ?? '').trim()
							if (!text || handle.props.busy) return
							if (await handle.props.onSend(text)) form.reset()
						})}
					>
						<label className="sr-only" htmlFor="chat-message">
							Message
						</label>
						<input
							id="chat-message"
							name="message"
							maxLength={280}
							placeholder="Say something…"
							autoComplete="off"
							required
						/>
						<button type="submit" disabled={handle.props.busy} aria-label="Send message">
							{handle.props.busy ? '…' : '↑'}
						</button>
					</form>
				)}
			</section>
		)
	}
}

function formatChatTime(value: string) {
	const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
