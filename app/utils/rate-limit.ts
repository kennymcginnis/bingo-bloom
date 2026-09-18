type Entry = { count: number; resetAt: number }

const entries = new Map<string, Entry>()

export function checkRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now()
  const existing = entries.get(key)
  const entry = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing
  entry.count += 1
  entries.set(key, entry)

  if (entries.size > 5_000) {
    for (const [entryKey, value] of entries) {
      if (value.resetAt <= now) entries.delete(entryKey)
    }
  }

  return {
    allowed: entry.count <= limit,
    retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
  }
}

export function requestAddress(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('cf-connecting-ip')
    || 'unknown'
}
