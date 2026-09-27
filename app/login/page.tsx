"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./login.module.css";

/**
 * Form login for the omp-web password lock. Replaces the browser's native Basic
 * dialog: proxy.ts redirects unauthenticated navigations here, this posts the
 * password to /api/web-access/login (which sets the httpOnly session cookie),
 * then we return to wherever the user was headed.
 */
function safeNext(raw: string | null): string {
  // Only allow same-origin absolute paths, never a full URL (open-redirect guard).
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/web-access/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error ?? `Sign-in failed (HTTP ${response.status})`);
      }
      // Full navigation so the new cookie is sent with the next request.
      window.location.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, password, next]);

  return (
    <form className={styles.card} onSubmit={submit}>
      <div className={styles.eyebrow}>omp jrfork</div>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.lead}>omp-web is locked. Enter your password to continue.</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {/* Hidden username so password managers and a11y tooling have a complete form. */}
      <input
        type="text"
        name="username"
        value="omp"
        autoComplete="username"
        readOnly
        aria-hidden="true"
        tabIndex={-1}
        style={{ display: "none" }}
      />
      <label className={styles.field}>
        <span>Password</span>
        <input
          ref={inputRef}
          className={styles.input}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <button className={styles.primary} type="submit" disabled={busy || password.length === 0}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <Link className={styles.secondary} href="/recover">Forgot password?</Link>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
