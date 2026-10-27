import './globals.css';
import type { ReactNode } from 'react';
import { AuthProvider } from '../lib/auth';

export const metadata = { title: 'Design Max', description: 'Chat-first enterprise project lifecycle platform' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
