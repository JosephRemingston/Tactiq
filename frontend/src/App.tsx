import { Show, SignIn, UserButton, useAuth, useSession, useUser } from '@clerk/react';
import { useEffect, useState } from 'react';
import { API_BASE, type ApiResult, call } from './api';
import { decodeJwt, tamper } from './jwt';

type Check = { id: string; label: string; expect: number; run: (token: string) => Promise<ApiResult> };

/** Each check states the status the backend must return; the page marks pass or fail. */
export const CHECKS: Check[] = [
  { id: 'me', label: 'GET /v1/me with session token', expect: 200, run: (t) => call('/v1/me', { token: t }) },
  { id: 'entitlements', label: 'GET /v1/entitlements', expect: 200, run: (t) => call('/v1/entitlements', { token: t }) },
  { id: 'feed', label: 'GET /v1/me/feed', expect: 200, run: (t) => call('/v1/me/feed', { token: t }) },
  { id: 'sessions', label: 'GET /v1/me/sessions (needs CLERK_SECRET_KEY on the API)', expect: 200, run: (t) => call('/v1/me/sessions', { token: t }) },
  { id: 'anon', label: 'GET /v1/me without a token', expect: 401, run: () => call('/v1/me') },
  { id: 'tampered', label: 'GET /v1/me with a tampered token', expect: 401, run: (t) => call('/v1/me', { token: tamper(t) }) },
];

export function MissingKey() {
  return (
    <main className="page">
      <Header />
      <section className="card warn">
        <h2>Clerk is not configured</h2>
        <p>
          Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> to the publishable key of the Clerk instance your API verifies against, then rebuild. Locally put it in{' '}
          <code>frontend/.env.local</code>; on Netlify add it under Site configuration, Environment variables.
        </p>
      </section>
    </main>
  );
}

function Header({ right }: { right?: React.ReactNode }) {
  const [health, setHealth] = useState<ApiResult | null>(null);
  useEffect(() => {
    void call('/readyz').then(setHealth);
  }, []);
  const ok = health?.status === 200;
  return (
    <header className="header">
      <div>
        <h1>Touchline</h1>
        <p className="muted">Clerk authentication tester</p>
      </div>
      <div className="row">
        <span className={`badge ${health === null ? '' : ok ? 'ok' : 'bad'}`} title={health ? JSON.stringify(health.body) : 'checking'}>
          API {health === null ? 'checking' : ok ? 'ready' : `unavailable (${health.status || 'no response'})`}
        </span>
        {right}
      </div>
    </header>
  );
}

export function App() {
  return (
    <main className="page">
      <Show when="signed-out">
        <Header />
        <section className="grid two">
          <div className="card">
            <h2>Sign in</h2>
            <p className="muted">The methods shown come from your Clerk instance settings (for example Google or an email verification code).</p>
            <SignIn routing="hash" />
          </div>
          <div className="card">
            <h2>What this page tests</h2>
            <ol className="steps">
              <li>Clerk issues a session after sign-in (and after the verification code on sign-up).</li>
              <li>The page sends the session token to the API as a Bearer token.</li>
              <li>The API verifies it, creates the local user on first sight and returns the profile and plan.</li>
              <li>Requests without a token, or with a tampered one, must be rejected with 401.</li>
            </ol>
          </div>
        </section>
      </Show>
      <Show when="signed-in">
        <Header right={<UserButton />} />
        <SignedInPanel />
      </Show>
      <footer className="muted small">API base: {API_BASE || 'same origin'}</footer>
    </main>
  );
}

function SignedInPanel() {
  const { getToken } = useAuth();
  const { user } = useUser();
  const { session } = useSession();
  const [token, setToken] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ApiResult>>({});
  const [running, setRunning] = useState(false);
  const [depth, setDepth] = useState<'quick' | 'explore' | 'advanced'>('quick');
  const [patch, setPatch] = useState<ApiResult | null>(null);

  const refreshToken = async () => setToken(await getToken());
  useEffect(() => {
    void refreshToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAll = async () => {
    setRunning(true);
    const fresh = (await getToken()) ?? '';
    setToken(fresh);
    const next: Record<string, ApiResult> = {};
    for (const c of CHECKS) {
      next[c.id] = await c.run(fresh);
      setResults({ ...next });
    }
    setRunning(false);
  };

  const savePreference = async () => setPatch(await call('/v1/me', { method: 'PATCH', token: await getToken(), body: { depthPreference: depth } }));

  const decoded = token ? decodeJwt(token) : null;
  const exp = typeof decoded?.claims.exp === 'number' ? new Date(decoded.claims.exp * 1000) : null;
  const passed = CHECKS.filter((c) => results[c.id]?.status === c.expect).length;

  return (
    <>
      <section className="grid two">
        <div className="card">
          <h2>Clerk session</h2>
          <dl>
            <dt>User</dt>
            <dd>{user?.fullName || user?.username || '(no name)'}</dd>
            <dt>Email</dt>
            <dd>
              {user?.primaryEmailAddress?.emailAddress ?? '(none)'} {user?.primaryEmailAddress?.verification?.status === 'verified' ? <span className="badge ok">verified</span> : <span className="badge bad">unverified</span>}
            </dd>
            <dt>Clerk user id</dt>
            <dd>
              <code>{user?.id}</code>
            </dd>
            <dt>Session</dt>
            <dd>
              <code>{session?.id}</code> <span className="badge">{session?.status}</span>
            </dd>
            <dt>Sign-in methods</dt>
            <dd>{user?.externalAccounts.map((a) => a.provider).join(', ') || 'email'}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="row between">
            <h2>Session token</h2>
            <button className="ghost" onClick={() => void refreshToken()}>
              Refresh
            </button>
          </div>
          {decoded ? (
            <dl>
              {(['sub', 'sid', 'sts', 'azp', 'iss'] as const).map((k) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd>
                    <code>{String(decoded.claims[k] ?? '(absent)')}</code>
                  </dd>
                </div>
              ))}
              <dt>alg / kid</dt>
              <dd>
                <code>
                  {String(decoded.header.alg)} / {String(decoded.header.kid)}
                </code>
              </dd>
              <dt>expires</dt>
              <dd>{exp ? `${exp.toLocaleTimeString()} (short-lived; Clerk refreshes it)` : 'n/a'}</dd>
            </dl>
          ) : (
            <p className="muted">No token yet.</p>
          )}
          {token && (
            <button className="ghost small" onClick={() => void navigator.clipboard.writeText(token)}>
              Copy token
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <div className="row between">
          <h2>Backend checks</h2>
          <div className="row">
            {Object.keys(results).length > 0 && (
              <span className={`badge ${passed === CHECKS.length ? 'ok' : 'bad'}`}>
                {passed}/{CHECKS.length} passed
              </span>
            )}
            <button onClick={() => void runAll()} disabled={running}>
              {running ? 'Running...' : 'Run all checks'}
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Check</th>
              <th>Expected</th>
              <th>Got</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {CHECKS.map((c) => {
              const r = results[c.id];
              const ok = r?.status === c.expect;
              return (
                <tr key={c.id} className={r ? (ok ? 'pass' : 'fail') : ''}>
                  <td>
                    {c.label}
                    {r && (
                      <details>
                        <summary>response{r.requestId ? ` (request ${r.requestId.slice(0, 8)})` : ''}</summary>
                        <pre>{JSON.stringify(r.body, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                  <td>{c.expect}</td>
                  <td>{r ? `${r.status || 'network error'} ${ok ? 'PASS' : 'FAIL'}` : '-'}</td>
                  <td>{r ? `${r.ms} ms` : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Write test: PATCH /v1/me</h2>
        <div className="row">
          <label>
            Explanation depth{' '}
            <select value={depth} onChange={(e) => setDepth(e.target.value as typeof depth)}>
              <option value="quick">quick</option>
              <option value="explore">explore</option>
              <option value="advanced">advanced</option>
            </select>
          </label>
          <button onClick={() => void savePreference()}>Save</button>
          {patch && <span className={`badge ${patch.status === 200 ? 'ok' : 'bad'}`}>{patch.status}</span>}
        </div>
        {patch && <pre>{JSON.stringify(patch.body, null, 2)}</pre>}
      </section>
    </>
  );
}
