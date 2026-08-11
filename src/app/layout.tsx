import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Nightscript',
  description: 'A quiet, personal affirmation track to fall asleep to.',
};

export const viewport: Viewport = {
  themeColor: '#050506',
  // Prevents the layout shifting under a half-asleep thumb.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-950 text-ink-200 antialiased">{children}</body>
    </html>
  );
}
