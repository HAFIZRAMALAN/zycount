/* Zycount — breached-password check (free alternative to Supabase's paid
 * leaked-password protection).
 *
 * zyPwned(password) → Promise<number>: how many times the password appears in
 * known data breaches (HaveIBeenPwned Pwned Passwords). k-anonymity: only the
 * first 5 characters of the password's SHA-1 hash leave the browser; the
 * password itself is never sent anywhere. Returns -1 if the check can't run
 * (offline, service down), so callers never block a user on our outage.
 *
 * The sign-up edge function runs the same check on the server.
 */
(function () {
  "use strict";
  async function zyPwned(password) {
    try {
      if (!window.crypto || !crypto.subtle || !window.fetch) return -1;
      const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(String(password)));
      const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 3000) : null;
      const res = await fetch("https://api.pwnedpasswords.com/range/" + hex.slice(0, 5), {
        headers: { "Add-Padding": "true" }, signal: ctl ? ctl.signal : undefined, cache: "no-store",
      });
      if (timer) clearTimeout(timer);
      if (!res.ok) return -1;
      const suffix = hex.slice(5);
      for (const line of (await res.text()).split("\n")) {
        const parts = line.trim().split(":");
        if (parts[0] === suffix) return Number(parts[1]) || 0;   // padding rows have count 0
      }
      return 0;
    } catch (e) {
      return -1;
    }
  }
  window.zyPwned = zyPwned;
  window.ZY_PWNED_MSG = "This password has appeared in a data breach elsewhere, so it isn't safe. Choose a different one.";
})();
