import type { Metadata } from 'next';
import { Instrument_Sans, Source_Serif_4 } from 'next/font/google';
import { ServerStatus } from '@/components/ServerStatus';
import { AuthProvider } from '@/lib/auth-context';
import { contentSecurityPolicy } from '@/lib/csp';
import './globals.css';

const sans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans' });
const serif = Source_Serif_4({ subsets: ['latin'], variable: '--font-serif' });

export const metadata: Metadata = { title: 'MindMesh', description: 'Your notes, organized.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      {/* The dev server needs eval for hot reloading, so the policy applies to production builds. */}
      {process.env.NODE_ENV === 'production' && (
        <head>
          <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy()} />
        </head>
      )}
      <body>
        <AuthProvider>{children}</AuthProvider>
        <ServerStatus />
      </body>
    </html>
  );
}
