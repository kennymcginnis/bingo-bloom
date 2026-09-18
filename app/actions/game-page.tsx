import { Document } from './document.tsx'
import { GameApp } from './public/game-app.tsx'
import type { Handle } from 'remix/ui'

export function GamePage(handle: Handle<{ role: 'admin' | 'player'; code: string }>) {
  return () => (
    <Document title={`${handle.props.role === 'admin' ? 'Host' : 'Play'} ${handle.props.code} — Bingo Bloom`}>
      <GameApp role={handle.props.role} code={handle.props.code.toUpperCase()} />
    </Document>
  )
}
