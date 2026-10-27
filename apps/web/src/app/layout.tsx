import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'Antigravity', description: 'Chat-first enterprise project lifecycle platform' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
