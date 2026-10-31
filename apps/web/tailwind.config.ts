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
        // Selected / active states (toggles, tabs, chips, rows): a tint of the theme colour, so a
        // selection doesn't look like the solid primary buttons. selectInk on select is about 8:1.
        select: '#D7ECEF',
        selectInk: '#0A4A54',
        selectLine: '#7FBEC7',
        // The sidebar's soft background, like a workspace side panel.
        side: '#F7F8FA',
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
