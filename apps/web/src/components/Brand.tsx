import Link from 'next/link';

/** The MindMesh mark and name. On every page it links to Home (the notes view). */
export function Brand({ heading = false, className = '' }: { heading?: boolean; className?: string }) {
  const title = 'font-serif text-2xl font-semibold leading-none';
  return (
    <Link
      href="/notes"
      aria-label="MindMesh home"
      title="Go to your notes"
      className={`inline-flex items-center gap-2 rounded-md text-ink transition-opacity hover:opacity-80 ${className}`}
    >
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent text-white shadow-sm" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="6" cy="7" r="2.2" fill="currentColor" /><circle cx="18" cy="7" r="2.2" fill="currentColor" /><circle cx="12" cy="18" r="2.2" fill="currentColor" />
          <path d="M8.4 7h7.2M7.2 9l3.8 7M16.8 9l-3.8 7" />
        </svg>
      </span>
      {heading ? <h1 className={title}>MindMesh</h1> : <span className={title}>MindMesh</span>}
    </Link>
  );
}
