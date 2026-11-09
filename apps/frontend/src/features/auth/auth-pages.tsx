import { passwordSchema } from '@lumio/validation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Field, Input } from '@/components/app/primitives';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/auth-context';
import { apiSend } from '@/lib/api-client';

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-md border bg-card p-6">
        <p className="mb-1 text-lg font-semibold">Lumio</p>
        <h1 className="mb-4 text-sm text-muted-foreground">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function useSubmit() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The request failed.');
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

const ErrorText = ({ text }: { text: string }) =>
  text ? (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  ) : null;

export function LoginPage() {
  const { user, login, completeMfa } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState<string | undefined>();
  const { error, busy, run } = useSubmit();

  if (user) return <Navigate to="/" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mfaToken) await completeMfa(mfaToken, code);
      else setMfaToken((await login(email, password)).mfaToken);
    });
  };

  return (
    <Shell title={mfaToken ? 'Enter your verification code' : 'Sign in to your account'}>
      <form className="space-y-3" onSubmit={submit}>
        {mfaToken ? (
          <Field label="Verification or recovery code">
            <Input
              autoFocus
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field label="Email">
              <Input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </>
        )}
        <ErrorText text={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {mfaToken ? 'Verify' : 'Sign in'}
        </Button>
        {!mfaToken && (
          <Link
            to="/forgot-password"
            className="block text-center text-xs text-muted-foreground underline"
          >
            Forgot your password?
          </Link>
        )}
      </form>
    </Shell>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { error, busy, run } = useSubmit();
  return (
    <Shell title="Reset your password">
      {sent ? (
        <p className="text-sm">If that account exists, a reset link is on its way.</p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await apiSend('post', '/auth/forgot-password', { email });
              setSent(true);
            });
          }}
        >
          <Field label="Email">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorText text={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            Send reset link
          </Button>
        </form>
      )}
    </Shell>
  );
}

/** Serves both new-user invitations and password resets. */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const { error, busy, run } = useSubmit();
  return (
    <Shell title="Choose a password">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const valid = passwordSchema.safeParse(password);
            if (!valid.success) throw new Error(valid.error.issues[0]?.message);
            await apiSend('post', '/auth/reset-password', { token: params.get('token'), password });
            void navigate('/login');
          });
        }}
      >
        <Field label="New password">
          <Input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText text={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          Save password
        </Button>
      </form>
    </Shell>
  );
}
