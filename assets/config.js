/* Claude & Co. Studio HQ — cloud connection.
   These two values come from Supabase → Project Settings → API.
   The anon key is designed to be public (safety comes from row-level
   security rules on the server), so it's fine that it lives here.
   Until real values are pasted in, the app runs in local-only mode. */

window.CCO_CONFIG = {
  SUPABASE_URL: "PASTE_PROJECT_URL_HERE",
  SUPABASE_ANON_KEY: "PASTE_ANON_KEY_HERE"
};
