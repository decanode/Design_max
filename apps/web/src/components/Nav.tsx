'use client';
import Link from 'next/link';
import { useAuth } from '../lib/auth';

type Key = 'board' | 'chat' | 'mailbox' | 'admin' | 'none';

export function Nav({ current }: { current: Key }) {
  const { me, can, canAny, logout } = useAuth();
  const link = (href: string, key: Key, label: string, show: boolean) =>
    show ? <Link href={href} aria-current={current === key ? 'page' : undefined}>{label}</Link> : null;
  return (
    <header className="top">
      <Link href="/" className="brand" aria-label="Design Max home">
        <span className="brand-mark" aria-hidden>DM</span><span className="word">Design Max</span>
      </Link>
      <nav aria-label="Primary">
        {link('/', 'board', 'Board', can('board.view'))}
        {link('/chat', 'chat', 'Chat', canAny('chat.as_customer', 'chat.as_consultant', 'chat.view_all'))}
        {link('/mailbox', 'mailbox', 'Mailbox', can('mailbox.view'))}
        {link('/admin', 'admin', 'Admin', canAny('admin.roles', 'admin.users'))}
      </nav>
      {me && (
        <div className="who">
          <span className="who-name">{me.user.name}</span>
          <span className="role-badge" data-role={me.user.role}>{me.user.role}</span>
          <button className="btn ghost sm" onClick={logout}>Sign out</button>
        </div>
      )}
    </header>
  );
}
