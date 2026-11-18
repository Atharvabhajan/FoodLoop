import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Bricolage_Grotesque, Plus_Jakarta_Sans } from 'next/font/google';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

// Self-hosted at build time by next/font: no request to Google from the browser.
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });
const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', display: 'swap' });

export const metadata: Metadata = {
  title: 'FoodLoop',
  description: 'Coordinating time-sensitive surplus food between providers, NGOs and volunteers.',
};

export const viewport: Viewport = { themeColor: '#0a1411' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${jakarta.variable} ${bricolage.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
