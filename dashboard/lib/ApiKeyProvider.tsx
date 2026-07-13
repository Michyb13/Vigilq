"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { verifyApiKey } from "./api";

const STORAGE_KEY = "vigilq_api_key";

const ApiKeyContext = createContext<string | null>(null);

export function useApiKey(): string {
  const key = useContext(ApiKeyContext);
  if (!key) {
    throw new Error("useApiKey() called outside ApiKeyProvider — this should never happen for pages under the gate");
  }
  return key;
}

/**
 * There's no server-side session here — this is a static export with no
 * backend of its own, so the queue API key the user pastes in just lives in
 * the browser's localStorage. Every page under this provider can assume a
 * verified key is present via useApiKey(); until then, this renders a
 * simple login form instead of the app.
 */
export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      setChecking(false);
      return;
    }
    verifyApiKey(stored).then((valid) => {
      if (valid) {
        setApiKey(stored);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
      setChecking(false);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const valid = await verifyApiKey(input.trim());
    if (!valid) {
      setError("That key was rejected by the engine — check it's copied correctly (see data/api_key.txt).");
      return;
    }
    localStorage.setItem(STORAGE_KEY, input.trim());
    setApiKey(input.trim());
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-sm text-text-faint">Loading…</div>
    );
  }

  if (!apiKey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 shadow-lg"
        >
          <div className="mb-5 flex items-center gap-2 font-mono text-sm font-medium text-text">
            <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-dim)]" />
            VigilQ
          </div>
          <p className="mb-5 text-sm text-text-dim">Enter your queue API key to continue.</p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="qk_live_..."
            className="mb-3 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
            autoFocus
          />
          {error && <p className="mb-3 text-sm text-status-dead-fg">{error}</p>}
          <button
            type="submit"
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            Continue
          </button>
        </form>
      </div>
    );
  }

  return <ApiKeyContext.Provider value={apiKey}>{children}</ApiKeyContext.Provider>;
}
