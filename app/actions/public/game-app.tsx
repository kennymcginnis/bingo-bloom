import { clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/ui'

type Word = { id: number; text: string; position?: number; called?: number }
type Player = { id: number; name: string; joined_at: string; claimed_at: string | null; verified: number | null; best_line_progress?: number }
type CardCell = { id?: number; text: string; free?: boolean; called?: boolean }
type GameState = {
  code: string; title: string; size: number; role: 'admin' | 'player'; words: Word[]
  players?: Player[]; player?: { name: string; claimedAt: string | null; verified: number | null }
  card?: CardCell[]; marks?: number[]
}
type PlayerBoardState = { player: Player; card: CardCell[]; marks: number[] }
type ChatMessage = { id: number; name: string; role: 'player' | 'host'; text: string; created_at: string; own: boolean }

interface GameAppProps extends SerializableProps { role: 'admin' | 'player'; code: string }

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
  const tokenKey = () => `bingo:${handle.props.role}:${handle.props.code}`
  const token = () => localStorage.getItem(tokenKey()) ?? ''
  const auth = () => ({ Authorization: `Bearer ${token()}` })

  const loadPlayerBoard = async (playerId: number, showLoading = true) => {
    if (showLoading) {
      loadingPlayerBoard = true
      playerBoardError = ''
      handle.update()
    }
    try {
      const response = await fetch(`/api/games/${handle.props.code}/players/${playerId}`, {
        headers: auth(), cache: 'no-store', signal: handle.signal,
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
      error = handle.props.role === 'admin' ? 'This organizer view belongs on the device that created the game.' : 'Join this game to receive your card.'
      handle.update(); return
    }
    try {
      const response = await fetch(`/api/games/${handle.props.code}`, { headers: auth(), cache: 'no-store', signal: handle.signal })
      const result = (await response.json()) as GameState & { error?: string }
      if (!response.ok) throw new Error(result.error ?? 'Could not load the game.')
      state = result; error = ''; handle.update()
      if (handle.props.role === 'admin' && selectedPlayerId !== null) void loadPlayerBoard(selectedPlayerId, false)
    } catch (caught) {
      if (!handle.signal.aborted) { error = caught instanceof Error ? caught.message : 'Could not load the game.'; handle.update() }
    }
  }

  const refreshChat = async () => {
    if (!token()) return
    try {
      const response = await fetch(`/api/games/${handle.props.code}/chat`, {
        headers: auth(), cache: 'no-store', signal: handle.signal,
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
        method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      })
      const result = (await response.json()) as { message?: ChatMessage; error?: string }
      if (!response.ok || !result.message) throw new Error(result.error ?? 'Could not send that message.')
      messages = [...messages, result.message]
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

  handle.queueTask(() => {
    void refresh()
    void refreshChat()
    const interval = setInterval(() => {
      if (handle.props.role === 'admin') void refresh()
      void refreshChat()
    }, 2500)
    handle.signal.addEventListener('abort', () => clearInterval(interval), { once: true })
  })

  const post = async (path: string, body?: unknown) => {
    const response = await fetch(`/api/games/${handle.props.code}/${path}`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
    const result = (await response.json()) as { error?: string; valid?: boolean }
    if (!response.ok) throw new Error(result.error ?? 'That did not work.')
    return result
  }

  return () => {
    if (!state) return <LoadingPage role={handle.props.role} code={handle.props.code} error={error} />
    return state.role === 'admin' ? (
      <HostDashboard state={state} notice={notice} busy={busy} messages={messages} chatError={chatError} chatBusy={chatBusy} onSendMessage={sendChatMessage} selectedPlayerBoard={selectedPlayerBoard} selectedPlayerId={selectedPlayerId} playerBoardError={playerBoardError} loadingPlayerBoard={loadingPlayerBoard} onSelectPlayer={(player) => {
        selectedPlayerId = player.id
        selectedPlayerBoard = null
        playerBoardError = ''
        void loadPlayerBoard(player.id)
      }} onClosePlayer={() => {
        selectedPlayerId = null
        selectedPlayerBoard = null
        playerBoardError = ''
        loadingPlayerBoard = false
        handle.update()
      }} onCall={async (word) => {
        busy = true; handle.update()
        try { await post('call', { wordId: word.id, called: !word.called }); notice = word.called ? `Removed “${word.text}” from the called list.` : `Called “${word.text}”.`; await refresh() }
        catch (caught) { error = caught instanceof Error ? caught.message : 'Could not update that phrase.' }
        busy = false; handle.update()
      }} onCopy={async () => {
        const inviteUrl = new URL(`/join/${encodeURIComponent(handle.props.code)}`, window.location.origin).toString()
        await navigator.clipboard.writeText(inviteUrl)
        notice = 'Invite link copied!'
        handle.update()
      }} />
    ) : (
      <PlayerBoard state={state} notice={notice} busy={busy} messages={messages} chatError={chatError} chatBusy={chatBusy} onSendMessage={sendChatMessage} onMark={async (position) => {
        if (!state) return
        const marks = new Set(state.marks ?? []); const marked = !marks.has(position)
        marked ? marks.add(position) : marks.delete(position)
        state.marks = [...marks]; notice = ''; handle.update()
        try { await post('mark', { position, marked }) } catch (caught) { notice = caught instanceof Error ? caught.message : 'Could not save that mark.'; await refresh() }
      }} onClaim={async () => {
        busy = true; notice = ''; handle.update()
        try { await post('claim'); notice = 'BINGO VERIFIED! Your host can see the win.'; await refresh() }
        catch (caught) { notice = caught instanceof Error ? caught.message : 'Not quite yet.' }
        busy = false; handle.update()
      }} />
    )
  }
})

function LoadingPage(handle: Handle<{ role: 'admin' | 'player'; code: string; error: string }>) {
  return () => <main className="game-shell"><header className="game-header"><a className="brand" href="/"><span className="brand-mark">B</span><span>Bingo Bloom</span></a><span className="code-pill">Game {handle.props.code}</span></header><section className="loading-card"><span className="loader" /><h1>{handle.props.error ? 'One tiny snag' : handle.props.role === 'admin' ? 'Opening the host desk…' : 'Finding your card…'}</h1><p>{handle.props.error || 'Shuffling the good stuff.'}</p>{handle.props.error && <a className="primary-button inline-button" href="/">Back to home</a>}</section></main>
}

function HostDashboard(handle: Handle<{
  state: GameState
  notice: string
  busy: boolean
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
}>) {
  return () => {
    const { state, notice, busy, messages, chatError, chatBusy, onSendMessage, selectedPlayerBoard, selectedPlayerId, playerBoardError, loadingPlayerBoard, onSelectPlayer, onClosePlayer, onCall, onCopy } = handle.props
    const called = state.words.filter((word) => word.called).length
    const winners = (state.players ?? []).filter((player) => player.verified === 1)
    return <main className="game-shell host-shell">
      <header className="game-header"><a className="brand" href="/"><span className="brand-mark">B</span><span>Bingo Bloom</span></a><div className="header-actions"><span className="live-pill"><i /> LIVE</span><button className="outline-button" type="button" mix={on('click', () => void onCopy())}>Copy invite</button></div></header>
      <section className="host-hero"><div><p className="eyebrow"><span /> Organizer desk</p><h1>{state.title}</h1><p>Tap a phrase when it officially happens. Players listen and mark their own cards.</p></div><div className="game-code"><span>GAME CODE</span><strong>{state.code}</strong><small>Share this with your team</small></div></section>
      {notice && <p className="notice">{notice}</p>}
      {winners.length > 0 && <div className="winner-banner"><span>★</span><div><b>Verified bingo!</b><p>{winners.map((winner) => winner.name).join(', ')}</p></div></div>}
      <div className="host-grid">
        <section className="panel call-panel"><div className="panel-heading"><div><p className="step-label">Caller board</p><h2>What’s been said?</h2></div><span>{called} / {state.words.length} called</span></div><div className="word-list">{state.words.map((word) => <button key={word.id} className={word.called ? 'called' : ''} disabled={busy} mix={on('click', () => onCall(word))}><span>{word.called ? '✓' : String((word.position ?? 0) + 1).padStart(2, '0')}</span>{word.text}</button>)}</div></section>
        <div className="host-sidebar"><aside className="panel players-panel"><div className="panel-heading"><div><p className="step-label">Room</p><h2>{state.players?.length ?? 0} players</h2></div></div>{!state.players?.length ? <div className="empty-state"><span>⌁</span><p>Waiting for teammates to join…</p></div> : <ul className="player-list">{state.players.map((player) => {
          const bestLineProgress = player.best_line_progress ?? 0
          return <li key={player.id}><button type="button" mix={on('click', () => onSelectPlayer(player))}><span className="avatar">{player.name.slice(0, 1).toUpperCase()}</span><span className="player-progress"><span className="player-progress-label"><strong>{player.name}</strong><small>{bestLineProgress} / {state.size}</small></span><span className="player-progress-track" role="progressbar" aria-label={`${player.name}'s best line progress`} aria-valuemin={0} aria-valuemax={state.size} aria-valuenow={bestLineProgress}><span style={{ width: `${(bestLineProgress / state.size) * 100}%` }} /></span></span>{player.verified === 1 ? <b className="verified">WIN ✓</b> : player.verified === 0 ? <b className="rejected">CHECKED</b> : <i aria-hidden="true">view →</i>}</button></li>
        })}</ul>}</aside><ChatBox messages={messages} error={chatError} busy={chatBusy} onSend={onSendMessage} /></div>
      </div>
      {selectedPlayerId !== null && <HostPlayerBoard board={selectedPlayerBoard} size={state.size} error={playerBoardError} loading={loadingPlayerBoard} onClose={onClosePlayer} />}
    </main>
  }
}

function HostPlayerBoard(handle: Handle<{ board: PlayerBoardState | null; size: number; error: string; loading: boolean; onClose: () => void }>) {
  handle.queueTask(() => {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      handle.props.onClose()
    }, { signal: handle.signal })
  })

  return () => {
    const { board, size, error, loading, onClose } = handle.props
    const marks = new Set(board?.marks ?? [])
    return <div className="board-modal-backdrop" role="presentation">
      <section className="board-modal" role="dialog" aria-modal="true" aria-labelledby="player-board-title">
        <div className="board-modal-heading"><div><p className="step-label">Live player view</p><h2 id="player-board-title">{board?.player.name ?? 'Player board'}</h2>{board && <p>{marks.size} square{marks.size === 1 ? '' : 's'} marked</p>}</div><button type="button" aria-label="Close player board" mix={on('click', onClose)}>×</button></div>
        {error ? <p className="form-error" role="alert">{error}</p> : !board || loading ? <div className="board-modal-loading"><span className="loader" /><p>Loading their latest board…</p></div> : <div className="board-preview-wrap"><div className="bingo-letters" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>{'BINGO!'.slice(0, size).split('').map((letter, index) => <span key={index}>{letter}</span>)}</div><div className="board-preview" style={{ gridTemplateColumns: `repeat(${size}, 1fr)` }}>{board.card.map((cell, position) => {
          const isMarked = cell.free || marks.has(position)
          return <div key={position} className={`${cell.free ? 'free' : ''} ${isMarked ? 'marked' : ''} ${isMarked && !cell.free && !cell.called ? 'not-called' : ''}`}><span>{cell.text}</span>{cell.called && <i>called</i>}{isMarked && <b>✓</b>}</div>
        })}</div></div>}
      </section>
    </div>
  }
}

function PlayerBoard(handle: Handle<{ state: GameState; notice: string; busy: boolean; messages: ChatMessage[]; chatError: string; chatBusy: boolean; onSendMessage: (text: string) => Promise<boolean>; onMark: (position: number) => void; onClaim: () => void }>) {
  return () => {
    const { state, notice, busy, messages, chatError, chatBusy, onSendMessage, onMark, onClaim } = handle.props
    const marks = new Set(state.marks ?? [])
    return <main className="game-shell player-shell">
      <header className="game-header"><a className="brand" href="/"><span className="brand-mark">B</span><span>Bingo Bloom</span></a><span className="code-pill">Game {state.code}</span></header>
      <section className="player-intro"><div><p className="eyebrow"><span /> {state.player?.name}'s card</p><h1>{state.title}</h1></div></section>
      <section className={`card-wrap size-${state.size}`}><div className="bingo-letters" style={{ gridTemplateColumns: `repeat(${state.size}, 1fr)` }}>{'BINGO!'.slice(0, state.size).split('').map((letter, index) => <span key={index}>{letter}</span>)}</div><div className="bingo-card" style={{ gridTemplateColumns: `repeat(${state.size}, 1fr)` }}>{state.card?.map((cell, position) => {
        const isMarked = cell.free || marks.has(position)
        return <button key={position} className={`${isMarked ? 'marked' : ''} ${cell.free ? 'free' : ''}`} disabled={cell.free} aria-pressed={isMarked} mix={cell.free ? undefined : on('click', () => onMark(position))}><span>{cell.text}</span>{isMarked && <b>✓</b>}</button>
      })}</div></section>
      <div className="player-footer"><p className="listen-note">Listen closely and tap each phrase when you hear it.</p>{notice && <p className={notice.startsWith('BINGO') ? 'success-notice' : 'notice'} role="status">{notice}</p>}<button className="bingo-button" type="button" disabled={busy} mix={on('click', () => void onClaim())}>{busy ? 'Checking your card…' : 'BINGO!'}</button><p>We’ll verify every marked square before calling the win.</p></div>
      <ChatBox messages={messages} error={chatError} busy={chatBusy} onSend={onSendMessage} />
    </main>
  }
}

function ChatBox(handle: Handle<{ messages: ChatMessage[]; error: string; busy: boolean; onSend: (text: string) => Promise<boolean> }>) {
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

    return <section className="chat-box" aria-labelledby="chat-title">
      <div className="chat-heading"><div><p className="step-label">Game Chat</p><h2 id="chat-title">Talk to the room</h2></div><span>{handle.props.messages.length} message{handle.props.messages.length === 1 ? '' : 's'}</span></div>
      <div className="chat-messages" aria-live="polite" mix={ref((element) => { messageList = element })}>
        {handle.props.messages.length === 0 ? <div className="chat-empty"><span>✦</span><p>No messages yet. Break the ice!</p></div> : handle.props.messages.map((message) => <article key={message.id} className={`${message.own ? 'own' : ''} ${message.role === 'host' ? 'host-message' : ''}`}><div><strong>{message.own ? 'You' : message.name}</strong><time dateTime={message.created_at}>{formatChatTime(message.created_at)}</time></div><p>{message.text}</p></article>)}
      </div>
      {handle.props.error && <p className="chat-error" role="alert">{handle.props.error}</p>}
      <form className="chat-compose" mix={on('submit', async (event) => {
        event.preventDefault()
        const form = event.currentTarget
        const text = String(new FormData(form).get('message') ?? '').trim()
        if (!text || handle.props.busy) return
        if (await handle.props.onSend(text)) form.reset()
      })}>
        <label className="sr-only" htmlFor="chat-message">Message</label>
        <input id="chat-message" name="message" maxLength={280} placeholder="Say something…" autoComplete="off" required />
        <button type="submit" disabled={handle.props.busy} aria-label="Send message">{handle.props.busy ? '…' : '↑'}</button>
      </form>
    </section>
  }
}

function formatChatTime(value: string) {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
