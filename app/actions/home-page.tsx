import { Document } from './document.tsx'
import { HomeApp } from './public/home-app.tsx'
import type { Handle } from 'remix/ui'

interface HomePageProps {
  initialPanel?: 'create' | 'join'
  initialCode?: string
}

export function HomePage(handle: Handle<HomePageProps>) {
  return () => (
    <Document title="Bingo Bloom — make a game in seconds">
      <HomeApp initialPanel={handle.props.initialPanel} initialCode={handle.props.initialCode} />
    </Document>
  )
}
