'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { user, loading, signIn, signUp, signInWithGoogle } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && user) router.replace('/notes');
  }, [user, loading, router]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(() => (mode === 'in' ? signIn(email, password) : signUp(email, password)));
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="font-serif text-4xl font-semibold">MindMesh</h1>
        <p className="mt-1 text-muted">Capture notes now. Find them later.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input className="field" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="field" type="password" placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary" type="submit">{mode === 'in' ? 'Sign in' : 'Create account'}</button>
        <button className="btn-ghost" type="button" onClick={() => run(signInWithGoogle)}>Continue with Google</button>
      </form>
      <button className="text-left text-sm text-accent underline" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
        {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
      </button>
    </main>
  );
}
