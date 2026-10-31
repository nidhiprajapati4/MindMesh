'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Brand } from '@/components/Brand';
import { api, errorMessage, initialsOf, type Profile } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

type Form = { displayName: string; phone: string; dob: string; birthLocation: string };
const toForm = (p: Profile): Form => ({ displayName: p.displayName, phone: p.phone, dob: p.dob ? p.dob.slice(0, 10) : '', birthLocation: p.birthLocation });

export default function ProfilePage() {
  const { user, loading, logout, resetPassword } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<Form>({ displayName: '', phone: '', dob: '', birthLocation: '' });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [resetStatus, setResetStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (!user) return;
    api<Profile>('/api/profile')
      .then((p) => {
        setProfile(p);
        setForm(toForm(p));
      })
      .catch((e) => setStatus({ kind: 'error', text: errorMessage(e, 'Could not load your profile') }));
  }, [user]);

  if (loading || !user) return null;

  // Google (and other social) accounts have no MindMesh password to reset.
  const hasPassword = user.providerData.some((p) => p.providerId === 'password');
  const email = profile?.email || user.email || '';
  const set = (patch: Partial<Form>) => {
    setStatus(null);
    setForm((f) => ({ ...f, ...patch }));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setStatus(null);
    try {
      // The email is never sent: it comes from the sign-in account and the server refuses to change it.
      const saved = await api<Profile>('/api/profile', { method: 'PATCH', body: JSON.stringify(form) });
      setProfile(saved);
      setForm(toForm(saved));
      window.dispatchEvent(new CustomEvent('mindmesh:profile-name', { detail: saved.displayName }));
      setStatus({ kind: 'ok', text: 'Profile saved.' });
    } catch (err) {
      setStatus({ kind: 'error', text: errorMessage(err, 'Could not save your profile') });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetStatus(null);
    try {
      await resetPassword(email);
      setResetStatus({ kind: 'ok', text: `We emailed a reset link to ${email}. Check your inbox (and spam folder).` });
    } catch (err) {
      setResetStatus({ kind: 'error', text: errorMessage(err, 'Could not send the reset email. Please try again.') });
    }
  };

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col gap-5 px-4 py-6">
      <Brand />
      <Link href="/notes" className="text-sm text-accent hover:underline">← Back to notes</Link>

      <div className="flex items-center gap-3">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-select text-lg font-semibold text-selectInk" aria-hidden>
          {initialsOf(form.displayName, email)}
        </span>
        <div className="min-w-0">
          <h1 className="font-serif text-2xl font-semibold">Your profile</h1>
          <p className="truncate text-sm text-muted">{email}</p>
        </div>
      </div>

      <form onSubmit={save} className="flex flex-col gap-4 rounded-xl border border-line bg-white p-4" aria-label="Profile details">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <input className="field bg-paper text-muted" value={email} readOnly aria-readonly="true" />
          <span className="text-xs text-muted">Your email comes from how you sign in, so it can’t be changed here.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name <span className="font-normal text-muted">(optional)</span></span>
          <input className="field" value={form.displayName} maxLength={100} autoComplete="name" onChange={(e) => set({ displayName: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Phone <span className="font-normal text-muted">(optional)</span></span>
          <input className="field" type="tel" value={form.phone} maxLength={30} autoComplete="tel" placeholder="+91 98765 43210" onChange={(e) => set({ phone: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Date of birth <span className="font-normal text-muted">(optional)</span></span>
          <input className="field" type="date" value={form.dob} min="1900-01-01" max={today} autoComplete="bday" onChange={(e) => set({ dob: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Birth location <span className="font-normal text-muted">(optional)</span></span>
          <input className="field" value={form.birthLocation} maxLength={100} placeholder="City, country" onChange={(e) => set({ birthLocation: e.target.value })} />
        </label>
        {status && (
          <p role={status.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${status.kind === 'error' ? 'text-red-700' : 'text-accent'}`}>{status.text}</p>
        )}
        <button className="btn-primary self-start" type="submit" disabled={saving || !profile}>{saving ? 'Saving…' : 'Save profile'}</button>
      </form>

      <section className="flex flex-col gap-2 rounded-xl border border-line bg-white p-4" aria-labelledby="password-heading">
        <h2 id="password-heading" className="font-medium">Password</h2>
        {hasPassword ? (
          <>
            <p className="text-sm text-muted">We’ll email a link to <span className="text-ink">{email}</span> where you can choose a new password.</p>
            <button className="btn-ghost self-start" type="button" onClick={reset}>Send reset link</button>
          </>
        ) : (
          <p className="text-sm text-muted">You sign in with Google, so there is no MindMesh password to reset. To change your password, update it in your Google account.</p>
        )}
        {resetStatus && (
          <p role={resetStatus.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${resetStatus.kind === 'error' ? 'text-red-700' : 'text-accent'}`}>{resetStatus.text}</p>
        )}
      </section>

      <button className="rounded-md border border-line bg-white py-2 text-sm font-medium text-muted transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700" onClick={() => logout().then(() => router.replace('/login'))}>
        Sign out
      </button>
    </div>
  );
}
