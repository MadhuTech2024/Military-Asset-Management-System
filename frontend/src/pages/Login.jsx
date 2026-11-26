import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Shield } from "lucide-react";
import { useAuth } from "../context/AuthContext.jsx";
import { DemoAuthenticationError } from "../auth/demoAuth.js";
import { apiErrorMessage } from "../services/api.js";
import { Button, Field, inputClass, Notice } from "../components/ui.jsx";

export default function Login() {
  const { isAuthenticated, login, demoModeEnabled } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  async function submit(event) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      await login({ email, password });
      navigate(location.state?.from?.pathname ?? "/dashboard", { replace: true });
    } catch (requestError) {
      setError(
        requestError instanceof DemoAuthenticationError
          ? requestError.message
          : apiErrorMessage(requestError),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-military-950 px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-white p-7 shadow-2xl sm:p-9">
        <div className="mb-7 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-800 text-white">
            <Shield aria-hidden="true" className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm font-extrabold tracking-[0.12em] text-slate-950">
              KRISTALLBALL
            </p>
            <p className="text-xs text-slate-500">Asset operations workspace</p>
          </div>
        </div>
        <h1 className="text-2xl font-bold text-slate-950">Sign in</h1>
        {demoModeEnabled && (
          <span className="mt-2 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-amber-900">
            {/* Demo mode */}
          </span>
        )}
        <p className="mt-2 text-sm text-slate-600">
          Sign in with your authorized account to continue.
        </p>
        <form className="mt-7 space-y-4" onSubmit={submit}>
          <Notice>{error}</Notice>
          <Field label="Email address">
            <input
              className={inputClass}
              type="email"
              name="email"
              autoComplete="username"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Password">
            <input
              className={inputClass}
              type="password"
              name="password"
              autoComplete="current-password"
              required
              maxLength={72}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button className="w-full" type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-6 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500">
          Access tokens remain in memory and are cleared when you sign out or
          the session expires.
        </p>
      </section>
    </main>
  );
}
