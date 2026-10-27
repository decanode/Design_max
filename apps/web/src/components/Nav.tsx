import Link from 'next/link';

export function Nav({ current }: { current: 'board' | 'chat' }) {
  return (
    <header className="top">
      <h1>Antigravity</h1>
      <nav aria-label="Primary">
        <Link href="/" aria-current={current === 'board' ? 'page' : undefined}>Board</Link>
        <Link href="/chat" aria-current={current === 'chat' ? 'page' : undefined}>Chat</Link>
      </nav>
    </header>
  );
}
