# Claude & Co. — Studio HQ

A small, friendly CRM for Claude and Co.: every client, every task, every shoot,
in one place, in brand colors. Built as a plain static site (no build step, no
dependencies) so it deploys straight to Vercel.

## How it works

- **Everyone** enters the studio password (set in the app's Settings, seeded in
  `assets/data.js` → `settings.accessCode`) and picks their name. They see the
  Today board, clients, their own tasks, and scheduled shoots — read-only.
- **Only Alise** can edit. She taps **Owner login** and enters her PIN
  (`settings.ownerPin`). Owner mode unlocks: status changes (to do → in
  progress → done), adding/editing tasks, shoots, clients, employees, and
  links, plus Settings. One exception: any employee can submit a **time-off
  request** — it opens an email to Alise and notes the request on their device;
  Alise approves it in Owner mode (approved time off shows on the Schedule).
- **Pay and client rates are deliberately absent from the entire app** — not
  stored, not displayed, not even in owner mode (v2 removed the field
  completely; the v2 version bump wipes any v1 local copies that had it).
- Progress bars (per person, per client, whole team) count done vs. total
  tasks — delete old done tasks now and then to keep the bars meaningful.
- v2 look: blush pink + pine green (replaces the v1 charcoal/gold).

## Cloud sync (v3)

When `assets/config.js` holds real Supabase values, the app is cloud-synced:
data lives in Supabase (`app_state` JSON row + `timeoff` table), owner edits
save live for everyone (screens refresh on focus + every 30s), employees'
time-off requests insert directly, and owner login is real Supabase auth
(email + password, enforced server-side by RLS). The Publish-to-team flow
disappears entirely in cloud mode. Without config values the app falls back
to the local/publish model described below.

## Where the data lives (local fallback mode)

- `assets/data.js` is the **shared baseline** — what every device sees.
- Alise's edits save in **her browser** (localStorage) on her device.
- To make her edits live for the whole team: Owner mode → **Publish to team**.
  That downloads `cco-hq-data.js` to her Downloads folder. Then she tells
  Claude *"Publish my Studio HQ updates"* — Claude replaces `assets/data.js`
  with that file's content, commits, and she pushes in GitHub Desktop.
- The published file carries a `publishedAt` timestamp; devices automatically
  drop older local copies when a newer publish arrives.

## What's sample data

Clients and team are real (from the May 2026 Client Bible + July meeting
notes). **Task due dates, shoot dates/times/locations are placeholders** —
seeded relative to "today" so the board looks alive. Alise should edit or
delete them in Owner mode on first use.

## Honest security note

This is a static site: the password gate and owner PIN are convenience locks,
not real security. Anyone with the URL *and* enough technical skill to read
the page source could see the data (client names, contacts, rates). The URL is
unlisted and the page is marked no-index, which is reasonable for this level
of sensitivity — but don't put anything in here you'd be upset to see leak
(no SSNs, no passwords, no pay rates).

## Files

- `index.html` — shell + access gate + modal
- `assets/style.css` — Claude & Co. brand styling
- `assets/data.js` — the shared data (clients, team, tasks, links, settings)
- `assets/app.js` — all app logic (vanilla JS)
