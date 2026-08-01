# Claude & Co. — Studio HQ

Small-scale CRM for the Claude & Co. team. Live at
https://claude-and-co-hq.vercel.app

## How it works

Static site (no build step) + Supabase for data and auth.

- `index.html` — app shell
- `assets/style.css` — design system (blush pink + pine green)
- `assets/app.js` — all app logic
- `assets/config.js` — Supabase project URL + publishable key
- `assets/data.js` — offline fallback copy, used only if the cloud is unreachable

## Data model (Supabase, `public` schema)

`members`, `clients`, `tasks`, `links`, `timeoff`, `comments`, `activity`,
`settings`, `app_users`. Every entity is its own table, so one edit writes one
row and every screen updates through a realtime subscription.

**There are no pay or rate fields anywhere.** Deliberate — employees use this.

## Permissions (enforced by Postgres RLS, not by hiding buttons)

- Anyone with the studio password: read everything, submit a time-off request,
  post a comment.
- Alise (signed in, `app_users.role = 'owner'`): everything.
- Employees (signed in, role `employee`): may tick off *their own* tasks, and
  only when Settings → "Let employees tick off their own tasks" is on. The
  server checks this, so it can't be bypassed from the browser.

## Adding an employee login

1. Supabase → Authentication → Users → Add user (email + password, auto-confirm).
2. SQL editor:
   `insert into app_users(user_id, member_id, role)
    select id, '<member id from members table>', 'employee'
    from auth.users where email = '<their email>';`

## Updating the site

Claude edits files → commits → Alise clicks **Push origin** in GitHub Desktop.
Content changes (clients, tasks, people) do NOT need a deploy — they save live.

## Install on a phone

Open the URL → Share → Add to Home Screen. Runs full screen with its own icon.
