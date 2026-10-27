import Link from 'next/link';

export function Nav({ current }: { current: 'board' | 'chat' | 'mailbox' | 'none' }) {
  const link = (href: string, key: typeof current, label: string) => (
    <Link href={href} aria-current={current === key ? 'page' : undefined}>{label}</Link>
  );
  return (
    <header className="top">
      <Link href="/" className="brand" aria-label="Design Max home">
        <span className="brand-mark" aria-hidden>DM</span><span className="word">Design Max</span>
      </Link>
      <nav aria-label="Primary">
        {link('/', 'board', 'Board')}
        {link('/chat', 'chat', 'Chat')}
        {link('/mailbox', 'mailbox', 'Mailbox')}
      </nav>
    </header>
  );
}
