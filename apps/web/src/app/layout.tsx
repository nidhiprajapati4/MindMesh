import type { Metadata } from 'next';
import { Instrument_Sans, Source_Serif_4 } from 'next/font/google';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans' });
const serif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif' });

export const metadata: Metadata = { title: 'MindMesh', description: 'Your notes, organized.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
