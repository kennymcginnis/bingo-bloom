import crypto from 'node:crypto'

export function normalizeWords(input: unknown): string[] {
	const values = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n|,/)
	const seen = new Set<string>()
	return values
		.map(word => String(word).trim().replace(/\s+/g, ' '))
		.filter(word => {
			const key = word.toLocaleLowerCase()
			if (!word || seen.has(key)) return false
			seen.add(key)
			return true
		})
}

export function findDuplicateWords(input: unknown): string[] {
	const values = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n|,/)
	const seen = new Map<string, string>()
	const duplicates = new Map<string, string>()
	for (const value of values) {
		const word = String(value).trim().replace(/\s+/g, ' ')
		if (!word) continue
		const key = word.toLocaleLowerCase()
		const original = seen.get(key)
		if (original) duplicates.set(key, original)
		else seen.set(key, word)
	}
	return [...duplicates.values()]
}

export function requiredWords(size: number): number {
	return size * size - (size % 2 === 1 ? 1 : 0)
}

export function makeCard(wordIds: number[], size: number): Array<number | null> {
	const pool = [...wordIds]
	for (let index = pool.length - 1; index > 0; index -= 1) {
		const swap = crypto.randomInt(index + 1)
		;[pool[index], pool[swap]] = [pool[swap], pool[index]]
	}
	const card: Array<number | null> = pool.slice(0, requiredWords(size))
	if (size % 2 === 1) card.splice(Math.floor((size * size) / 2), 0, null)
	return card
}

export function cardSignature(card: Array<number | null>): string {
	return card.map(id => id ?? 'FREE').join('-')
}

export function winningLines(size: number): number[][] {
	const lines: number[][] = []
	for (let row = 0; row < size; row += 1) {
		lines.push(Array.from({ length: size }, (_, column) => row * size + column))
	}
	for (let column = 0; column < size; column += 1) {
		lines.push(Array.from({ length: size }, (_, row) => row * size + column))
	}
	lines.push(Array.from({ length: size }, (_, index) => index * size + index))
	lines.push(Array.from({ length: size }, (_, index) => index * size + size - index - 1))
	return lines
}

export function bestLineProgress(input: { card: Array<number | null>; marks: number[]; size: number }): number {
	const marked = new Set(input.marks)
	return Math.max(
		0,
		...winningLines(input.size).map(
			line => line.filter(position => input.card[position] === null || marked.has(position)).length,
		),
	)
}

export function validateClaim(input: {
	card: Array<number | null>
	marks: number[]
	calledWordIds: number[]
	size: number
}) {
	const marked = new Set(input.marks)
	const called = new Set(input.calledWordIds)
	const wrong = [...marked].filter(position => {
		const wordId = input.card[position]
		return wordId !== null && !called.has(wordId)
	})
	const free = input.size % 2 === 1 ? Math.floor((input.size * input.size) / 2) : -1
	const line = winningLines(input.size).find(positions =>
		positions.every(position => position === free || marked.has(position)),
	)
	return { valid: wrong.length === 0 && Boolean(line), wrong, line: line ?? null }
}

export function makeCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
	return Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('')
}

export function makeToken(): string {
	return crypto.randomBytes(24).toString('base64url')
}
