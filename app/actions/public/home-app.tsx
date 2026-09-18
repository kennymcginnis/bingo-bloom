import { clientEntry, on, ref, type Handle, type SerializableProps } from 'remix/ui'

type Panel = 'create' | 'join'
type JoinMode = 'new' | 'rejoin'
type PlayerRange = 'small' | 'medium' | 'large'
type UiState = {
	panel: Panel
	title: string
	size: number
	playerRange: PlayerRange
	words: string
	joinCode: string
	joinName: string
	joinMode: JoinMode
	rejoinCode: string
}

interface HomeAppProps extends SerializableProps {
	initialPanel?: Panel
	initialCode?: string
}

const UI_STATE_KEY = 'bingo:ui-state:v1'

const examples = [
	'Let’s circle back',
	'You’re on mute',
	'Quick question',
	'Low-hanging fruit',
	'Can everyone see my screen?',
	'Take this offline',
	'Bandwidth',
	'Hard stop',
	'Action item',
	'Move the needle',
	'Touch base',
	'Deep dive',
	'Parking lot',
	'Win-win',
	'At the end of the day',
	'Synergy',
	'Double-click on that',
	'Best practice',
	'Deliverable',
	'Heads-down',
	'Core competency',
	'Ping me',
	'Take a step back',
	'Who owns this?',
	'Next steps',
].join('\n')

export const HomeApp = clientEntry(import.meta.url, function HomeApp(handle: Handle<HomeAppProps>) {
	const initialCode = handle.props.initialCode?.trim().toUpperCase() ?? ''
	const isDirectJoin = handle.props.initialPanel === 'join' || Boolean(initialCode)
	let panel: Panel = isDirectJoin ? 'join' : 'create'
	let busy = false
	let error = ''
	let wordCount = 25
	let boardSize = 5
	let playerRange: PlayerRange = 'medium'
	let duplicateEntries: string[] = []
	let wordsElement: HTMLTextAreaElement | null = null
	let titleElement: HTMLInputElement | null = null
	let draftTitle = ''
	let draftWords = examples
	let joinCode = initialCode
	let joinName = ''
	let joinMode: JoinMode = 'new'
	let rejoinCode = ''

	const saveUiState = () => {
		const value: UiState = {
			panel,
			title: draftTitle,
			size: boardSize,
			playerRange,
			words: draftWords,
			joinCode,
			joinName,
			joinMode,
			rejoinCode,
		}
		localStorage.setItem(UI_STATE_KEY, JSON.stringify(value))
	}

	const changePanel = (nextPanel: Panel) => {
		panel = nextPanel
		error = ''
		saveUiState()
		handle.update()
	}

	handle.queueTask(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) ?? 'null') as Partial<UiState> | null
			if (!saved) return
			if (!isDirectJoin && (saved.panel === 'create' || saved.panel === 'join')) panel = saved.panel
			if ([3, 4, 5, 6].includes(Number(saved.size))) boardSize = Number(saved.size)
			if (saved.playerRange === 'small' || saved.playerRange === 'medium' || saved.playerRange === 'large')
				playerRange = saved.playerRange
			if (!initialCode && typeof saved.joinCode === 'string') joinCode = saved.joinCode
			if (typeof saved.joinName === 'string') joinName = saved.joinName
			if (!isDirectJoin && (saved.joinMode === 'new' || saved.joinMode === 'rejoin')) joinMode = saved.joinMode
			if (typeof saved.rejoinCode === 'string') rejoinCode = saved.rejoinCode
			if (typeof saved.title === 'string') {
				draftTitle = saved.title
				if (titleElement) titleElement.value = saved.title
			}
			if (typeof saved.words === 'string') {
				draftWords = saved.words
				if (wordsElement) wordsElement.value = saved.words
				wordCount = uniqueCount(draftWords)
				duplicateEntries = findDuplicateEntries(draftWords)
			}
			handle.update()
		} catch {
			localStorage.removeItem(UI_STATE_KEY)
		}
	})

	const submitCreate = async (form: HTMLFormElement, signal: AbortSignal) => {
		busy = true
		error = ''
		handle.update()
		const formData = new FormData(form)
		duplicateEntries = findDuplicateEntries(String(formData.get('words') ?? ''))
		if (duplicateEntries.length) {
			busy = false
			error = 'Remove duplicate phrases before creating the game.'
			handle.update()
			return
		}
		const response = await fetch('/api/games', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: formData.get('title'),
				size: Number(formData.get('size')),
				words: formData.get('words'),
			}),
			signal,
		})
		const result = (await response.json().catch(() => ({ error: 'The server returned an unexpected response.' }))) as {
			code?: string
			adminToken?: string
			error?: string
		}
		if (signal.aborted) return
		if (!response.ok || !result.code || !result.adminToken) {
			busy = false
			error = result.error ?? 'Could not create the game.'
			handle.update()
			return
		}
		localStorage.removeItem(UI_STATE_KEY)
		localStorage.setItem(`bingo:admin:${result.code}`, result.adminToken)
		window.location.assign(`/host/${result.code}`)
	}

	const submitJoin = async (form: HTMLFormElement, signal: AbortSignal) => {
		busy = true
		error = ''
		handle.update()
		const formData = new FormData(form)
		const code = String(formData.get('code') ?? '')
			.trim()
			.toUpperCase()
		const endpoint = joinMode === 'rejoin' ? 'rejoin' : 'join'
		const response = await fetch(`/api/games/${encodeURIComponent(code)}/${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(
				joinMode === 'rejoin' ? { rejoinCode: formData.get('rejoinCode') } : { name: formData.get('name') },
			),
			signal,
		})
		const result = (await response.json()) as { playerToken?: string; rejoinCode?: string; error?: string }
		if (signal.aborted) return
		if (!response.ok || !result.playerToken) {
			busy = false
			error = result.error ?? 'Could not join that game.'
			handle.update()
			return
		}
		joinCode = ''
		saveUiState()
		localStorage.setItem(`bingo:player:${code}`, result.playerToken)
		if (result.rejoinCode) localStorage.setItem(`bingo:rejoin:${code}`, result.rejoinCode)
		window.location.assign(`/game/${code}`)
	}

	return () => (
		<main className="home-shell">
			<header className="site-header">
				<a className="brand" href="/" aria-label="Bingo Bloom home">
					<span className="brand-mark" aria-hidden="true">
						B
					</span>
					<span>Bingo Bloom</span>
				</a>
				<button className="quiet-button" type="button" mix={on('click', () => changePanel('join'))}>
					Join a game <span aria-hidden="true">→</span>
				</button>
			</header>
			<section className="hero">
				<div className="hero-copy">
					<p className="eyebrow">
						<span /> Team bingo, minus the paper cuts
					</p>
					<h1>Turn any list into a little friendly chaos.</h1>
					<p className="hero-lede">
						Create unique cards, invite the whole team, and let the server settle every “Bingo!”—fair and square.
					</p>
					<div className="proof-row">
						<span>✓ No accounts</span>
						<span>✓ Phone ready</span>
						<span>✓ Verified wins</span>
					</div>
				</div>
				<div className="setup-card">
					<div className="tabs" role="tablist" aria-label="Get started">
						<button
							className={panel === 'create' ? 'active' : ''}
							role="tab"
							aria-selected={panel === 'create'}
							mix={on('click', () => changePanel('create'))}
						>
							Create
						</button>
						<button
							className={panel === 'join' ? 'active' : ''}
							role="tab"
							aria-selected={panel === 'join'}
							mix={on('click', () => changePanel('join'))}
						>
							Join
						</button>
					</div>
					{panel === 'create' ? (
						<form
							className="form-stack"
							mix={on('submit', (event, signal) => {
								event.preventDefault()
								void submitCreate(event.currentTarget, signal)
							})}
						>
							<div>
								<p className="step-label">01 / Name it</p>
								<label htmlFor="title">Game title</label>
								<input
									id="title"
									name="title"
									placeholder="Friday all-hands bingo"
									maxLength={80}
									value={draftTitle}
									required
									mix={[
										ref(element => {
											titleElement = element
										}),
										on('input', event => {
											draftTitle = event.currentTarget.value
											saveUiState()
											handle.update()
										}),
									]}
								/>
							</div>
							<div>
								<p className="step-label">02 / Plan it</p>
								<div className="planning-fields">
									<div>
										<label htmlFor="size">Card size</label>
										<select
											id="size"
											name="size"
											mix={on('change', event => {
												boardSize = Number(event.currentTarget.value)
												saveUiState()
												handle.update()
											})}
										>
											<option value="3" selected={boardSize === 3}>
												3 × 3 · quick
											</option>
											<option value="4" selected={boardSize === 4}>
												4 × 4 · medium
											</option>
											<option value="5" selected={boardSize === 5}>
												5 × 5 · classic
											</option>
											<option value="6" selected={boardSize === 6}>
												6 × 6 · long game
											</option>
										</select>
									</div>
									<div>
										<label htmlFor="playerRange">Player count</label>
										<select
											id="playerRange"
											name="playerRange"
											mix={on('change', event => {
												playerRange = event.currentTarget.value as PlayerRange
												saveUiState()
												handle.update()
											})}
										>
											<option value="small" selected={playerRange === 'small'}>
												2–5 players
											</option>
											<option value="medium" selected={playerRange === 'medium'}>
												6–15 players
											</option>
											<option value="large" selected={playerRange === 'large'}>
												16+ players
											</option>
										</select>
									</div>
								</div>
								<Recommendation wordCount={wordCount} size={boardSize} playerRange={playerRange} />
							</div>
							<div>
								<p className="step-label">03 / Fill it</p>
								<div className="phrase-label-row">
									<label htmlFor="words">One phrase per line</label>
									<div className="phrase-actions">
										<button
											className="sort-button"
											type="button"
											disabled={duplicateEntries.length === 0}
											mix={on('click', () => {
												if (!wordsElement) return
												draftWords = removeDuplicateEntries(wordsElement.value).join('\n')
												wordsElement.value = draftWords
												wordCount = uniqueCount(draftWords)
												duplicateEntries = []
												error = ''
												saveUiState()
												handle.update()
												wordsElement.focus()
											})}
										>
											<span aria-hidden="true">−</span> Remove dups
										</button>
										<button
											className="sort-button"
											type="button"
											mix={on('click', () => {
												if (!wordsElement) return
												draftWords = splitEntries(wordsElement.value)
													.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
													.join('\n')
												wordsElement.value = draftWords
												wordCount = uniqueCount(draftWords)
												duplicateEntries = findDuplicateEntries(draftWords)
												saveUiState()
												handle.update()
												wordsElement.focus()
											})}
										>
											<span aria-hidden="true">↕</span> Sort A–Z
										</button>
									</div>
								</div>
								<textarea
									id="words"
									name="words"
									rows={8}
									defaultValue={draftWords}
									required
									aria-invalid={duplicateEntries.length > 0}
									aria-describedby={duplicateEntries.length ? 'duplicate-warning' : undefined}
									mix={[
										ref(element => {
											wordsElement = element
										}),
										on('input', event => {
											draftWords = event.currentTarget.value
											wordCount = uniqueCount(draftWords)
											duplicateEntries = findDuplicateEntries(draftWords)
											error = ''
											saveUiState()
											handle.update()
										}),
									]}
								/>
								{duplicateEntries.length > 0 && (
									<p id="duplicate-warning" className="duplicate-warning" role="alert">
										<strong>Duplicate{duplicateEntries.length === 1 ? '' : 's'} found:</strong>{' '}
										{duplicateEntries.join(', ')}
									</p>
								)}
							</div>
							{error && (
								<p className="form-error" role="alert">
									{error}
								</p>
							)}
							<button className="primary-button" type="submit" disabled={busy}>
								{busy ? 'Planting your game…' : 'Create my game'} <span aria-hidden="true">↗</span>
							</button>
						</form>
					) : (
						<form
							className="form-stack join-form"
							mix={on('submit', (event, signal) => {
								event.preventDefault()
								void submitJoin(event.currentTarget, signal)
							})}
						>
							<div className="join-intro">
								<span className="big-dot">●</span>
								<h2>Ready to play?</h2>
								<p>Grab the six-character code from your host. Your card will be all yours.</p>
							</div>
							<div className="join-mode-tabs" role="group" aria-label="Join options">
								<button
									type="button"
									className={joinMode === 'new' ? 'active' : ''}
									aria-pressed={joinMode === 'new'}
									mix={on('click', () => {
										joinMode = 'new'
										error = ''
										saveUiState()
										handle.update()
									})}
								>
									New player
								</button>
								<button
									type="button"
									className={joinMode === 'rejoin' ? 'active' : ''}
									aria-pressed={joinMode === 'rejoin'}
									mix={on('click', () => {
										joinMode = 'rejoin'
										error = ''
										saveUiState()
										handle.update()
									})}
								>
									Rejoin my card
								</button>
							</div>
							<div>
								<label htmlFor="code">Game code</label>
								<input
									className="code-input"
									id="code"
									name="code"
									placeholder="ABC123"
									maxLength={6}
									autoCapitalize="characters"
									value={joinCode}
									required
									mix={on('input', event => {
										joinCode = event.currentTarget.value.toUpperCase()
										saveUiState()
										handle.update()
									})}
								/>
							</div>
							{joinMode === 'new' ? (
								<div>
									<label htmlFor="name">Your name</label>
									<input
										id="name"
										name="name"
										placeholder="Jamie"
										maxLength={40}
										autoComplete="name"
										value={joinName}
										required
										mix={on('input', event => {
											joinName = event.currentTarget.value
											saveUiState()
											handle.update()
										})}
									/>
								</div>
							) : (
								<div>
									<label htmlFor="rejoinCode">Your rejoin code</label>
									<input
										className="code-input"
										id="rejoinCode"
										name="rejoinCode"
										placeholder="R7K9QP"
										maxLength={6}
										autoCapitalize="characters"
										value={rejoinCode}
										required
										mix={on('input', event => {
											rejoinCode = event.currentTarget.value.toUpperCase()
											saveUiState()
											handle.update()
										})}
									/>
									<small className="field-help">This restores your original card and marks.</small>
								</div>
							)}
							{error && (
								<p className="form-error" role="alert">
									{error}
								</p>
							)}
							<button className="primary-button" type="submit" disabled={busy}>
								{busy ? 'Finding your card…' : joinMode === 'rejoin' ? 'Restore my card' : 'Join the game'}{' '}
								<span aria-hidden="true">→</span>
							</button>
						</form>
					)}
				</div>
			</section>
			<section className="how-it-works" aria-label="How it works">
				<p className="eyebrow">
					<span /> How it works
				</p>
				<div className="steps">
					<article>
						<b>1</b>
						<h3>Paste your list</h3>
						<p>Add phrases, moments, names—anything your team can spot or hear.</p>
					</article>
					<article>
						<b>2</b>
						<h3>Share one code</h3>
						<p>Every teammate gets a different, mobile-friendly card instantly.</p>
					</article>
					<article>
						<b>3</b>
						<h3>Call it fair</h3>
						<p>You mark official phrases. We check every claimed line against them.</p>
					</article>
				</div>
			</section>
		</main>
	)
})

function uniqueCount(value: string) {
	return new Set(splitEntries(value).map(word => word.toLowerCase())).size
}

function splitEntries(value: string) {
	return value
		.split(/\r?\n|,/)
		.map(word => word.trim().replace(/\s+/g, ' '))
		.filter(Boolean)
}

function findDuplicateEntries(value: string) {
	const seen = new Map<string, string>()
	const duplicates = new Map<string, string>()
	for (const entry of splitEntries(value)) {
		const key = entry.toLowerCase()
		const original = seen.get(key)
		if (original) duplicates.set(key, original)
		else seen.set(key, entry)
	}
	return [...duplicates.values()]
}

function removeDuplicateEntries(value: string) {
	const seen = new Set<string>()
	return splitEntries(value).filter(entry => {
		const key = entry.toLowerCase()
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function Recommendation(handle: Handle<{ wordCount: number; size: number; playerRange: PlayerRange }>) {
	return () => {
		const { wordCount, size, playerRange } = handle.props
		const [minimum, maximum] = recommendationFor(size, playerRange)
		const status =
			wordCount < minimum
				? `Add ${minimum - wordCount}–${maximum - wordCount} more`
				: wordCount > maximum
				? 'Plenty of variety'
				: 'Sweet spot reached'
		return (
			<div className={`recommendation-card ${wordCount >= minimum ? 'ready' : ''}`}>
				<div>
					<span>Your list</span>
					<strong>{wordCount}</strong>
					<small>unique phrases</small>
				</div>
				<span className="recommendation-arrow" aria-hidden="true">
					→
				</span>
				<div>
					<span>Recommended</span>
					<strong>
						{minimum}–{maximum}
					</strong>
					<small>for {playerRange === 'small' ? '2–5' : playerRange === 'medium' ? '6–15' : '16+'} players</small>
				</div>
				<b>{status}</b>
			</div>
		)
	}
}

function recommendationFor(size: number, playerRange: PlayerRange): [number, number] {
	if (size === 6) {
		if (playerRange === 'small') return [45, 50]
		if (playerRange === 'medium') return [55, 65]
		return [75, 90]
	}
	if (playerRange === 'small') return [30, 35]
	if (playerRange === 'medium') return [40, 50]
	return [60, 75]
}
