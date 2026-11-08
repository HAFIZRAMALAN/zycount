// Points the app at the local Supabase. window.ZY_ENV is honoured by
// zy-live.js and login.html only when the page is served from localhost.
const SUPA_URL = process.env.SUPA_URL || "http://127.0.0.1:54321";
const SUPA_ANON = process.env.SUPA_ANON;
if (!SUPA_ANON) throw new Error("Set SUPA_ANON (the local anon key from `supabase status -o env`).");

// Each test signs up its own company; the sign-up throttle (5 an hour per address) would
// otherwise trip on the shared CI address. Only the throwaway CI database is touched.
function resetSignupThrottle() {
  if (!process.env.E2E_DB_URL) return;
  require("child_process").execSync(`psql "${process.env.E2E_DB_URL}" -q -c "delete from public.signup_attempts"`, { stdio: "ignore" });
}

async function useLocalSupabase(page) {
  resetSignupThrottle();
  await page.addInitScript(({ url, key }) => { window.ZY_ENV = { url, key }; }, { url: SUPA_URL, key: SUPA_ANON });
  // Fail the test on any uncaught error in the app.
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

const unique = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// Random, so it is never in a breach list (the sign-up checks HaveIBeenPwned).
const strongPassword = () => `Zy${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}9q`;

module.exports = { SUPA_URL, SUPA_ANON, useLocalSupabase, unique, strongPassword };
