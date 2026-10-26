import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#EEF1F6',
        ink: '#1A2233',
        muted: '#5B6578',
        line: '#D5DBE6',
        accent: '#0F6E7A',
        flag: '#F2B134',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
