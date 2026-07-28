/* Claude & Co. Studio HQ — cloud connection.
   These values come from Supabase → Project Settings → API Keys.
   The publishable key is designed to be public (safety comes from
   row-level security rules on the server), so it's fine that it
   lives here. */

window.CCO_CONFIG = {
  SUPABASE_URL: "https://agwjsxfczbcuewnxehrr.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_XTVmHr1mg6ScxTR3rkQuTQ_XrhInQMa",
  /* The email of the Supabase auth user Alise signs in with (this is
     separate from settings.ownerEmail, where time-off notifications go). */
  OWNER_LOGIN_EMAIL: "alisemccreary@gmail.com"
};
