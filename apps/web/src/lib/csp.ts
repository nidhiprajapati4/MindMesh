/**
 * Content Security Policy for production builds: the page may only talk to this site, the
 * MindMesh API and Firebase Auth. Built from the same settings as the app, so each deployment
 * allows exactly its own API. Served as a <meta> tag because static hosting headers are fixed.
 */
export function contentSecurityPolicy() {
  const origin = (url?: string) => {
    try {
      return url ? new URL(url).origin : '';
    } catch {
      return '';
    }
  };
  const emulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ? `http://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST}` : '';
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ? `https://${process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}` : '';
  return [
    "default-src 'self'",
    // Next.js inlines its page data as scripts; Google sign-in loads a helper from apis.google.com.
    "script-src 'self' 'unsafe-inline' https://apis.google.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self'",
    `connect-src 'self' ${origin(process.env.NEXT_PUBLIC_API_URL)} https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${emulator}`,
    `frame-src ${authDomain} https://accounts.google.com ${emulator}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .join('; ');
}
