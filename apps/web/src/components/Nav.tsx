import Link from 'next/link';

export function Nav({ current }: { current: 'board' | 'chat' | 'mailbox' | 'none' }) {
  return (
    <header className="top">
      <h1>Design Max</h1>
      <nav aria-label="Primary">
        <Link href="/" aria-current={current === 'board' ? 'page' : undefined}>Board</Link>
        <Link href="/chat" aria-current={current === 'chat' ? 'page' : undefined}>Chat</Link>
        <Link href="/mailbox" aria-current={current === 'mailbox' ? 'page' : undefined}>Mailbox</Link>
      </nav>
    </header>
  );
}
