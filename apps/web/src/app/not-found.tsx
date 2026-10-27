import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="font-serif text-2xl font-semibold">Page not found</h1>
      <p className="text-muted">There's nothing at this address. It may have moved, or the link may be mistyped.</p>
      <Link href="/notes" className="btn-primary self-start">Go to your notes</Link>
    </main>
  );
}
