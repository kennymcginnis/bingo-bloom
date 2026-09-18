import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import {
	bestLineProgress,
	findDuplicateWords,
	makeCard,
	normalizeWords,
	requiredWords,
	validateClaim,
	winningLines,
} from './game-rules.ts'

describe('bingo rules', () => {
	it('normalizes and deduplicates phrases', () => {
		assert.deepEqual(normalizeWords(' Alpha \nBeta\nalpha\n\nGamma '), ['Alpha', 'Beta', 'Gamma'])
	})

	it('finds case-insensitive duplicates after whitespace normalization', () => {
		assert.deepEqual(findDuplicateWords('Alpha\n Beta  test \nalpha\nbeta test\nALPHA'), ['Alpha', 'Beta test'])
	})

	it('reserves a free center on odd-sized cards', () => {
		assert.equal(requiredWords(3), 8)
		assert.equal(requiredWords(4), 16)
		assert.equal(requiredWords(5), 24)
		assert.equal(requiredWords(6), 36)
	})

	it('creates a 6×6 card without a free center', () => {
		const card = makeCard(
			Array.from({ length: 50 }, (_, index) => index + 1),
			6,
		)
		assert.equal(card.length, 36)
		assert.equal(card.includes(null), false)
		assert.equal(new Set(card).size, 36)
	})

	it('builds rows, columns, and diagonals', () => {
		assert.equal(winningLines(5).length, 12)
		assert.deepEqual(winningLines(3).at(-1), [2, 4, 6])
	})

	it('finds the fullest winning line even when its marked squares are separated', () => {
		const card = [1, 2, 3, 4, null, 5, 6, 7, 8]
		assert.equal(bestLineProgress({ card, marks: [0, 1, 5, 8], size: 3 }), 3)
		assert.equal(bestLineProgress({ card, marks: [0, 2, 7], size: 3 }), 2)
	})

	it('counts the screenshot pattern as four of five on its diagonal', () => {
		const card = Array.from({ length: 25 }, (_, index) => index + 1) as Array<number | null>
		card[12] = null
		assert.equal(bestLineProgress({ card, marks: [0, 1, 6, 9, 16, 19, 24], size: 5 }), 4)
	})

	it('reports no progress on an unmarked even-sized card', () => {
		const card = Array.from({ length: 16 }, (_, index) => index + 1)
		assert.equal(bestLineProgress({ card, marks: [], size: 4 }), 0)
	})

	it('accepts a complete line when every marked phrase was called', () => {
		const card = [1, 2, 3, 4, null, 5, 6, 7, 8]
		assert.equal(validateClaim({ card, marks: [0, 1, 2], calledWordIds: [1, 2, 3], size: 3 }).valid, true)
	})

	it('rejects an otherwise complete line containing an uncalled phrase', () => {
		const card = [1, 2, 3, 4, null, 5, 6, 7, 8]
		const result = validateClaim({ card, marks: [0, 1, 2], calledWordIds: [1, 3], size: 3 })
		assert.equal(result.valid, false)
		assert.deepEqual(result.wrong, [1])
	})
})
