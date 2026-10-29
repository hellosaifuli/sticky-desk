# Moving Sticky Desk to its own Supabase project

The board has lived inside the shared `taarun-mart-ledger` project (ref `gxeatllskccthzunvzbp`).
It moves to a new, Sticky-Desk-only project on a separate Supabase account.

## Steps (for the session doing the move)

1. Create a project named **Sticky Desk** in `ap-southeast-1` (Singapore) on the new account.
2. Run `supabase/schema.sql` as one migration, after replacing `__PROJECT_REF__` with the new ref.
   Keep migrations free of `DELETE` statements: those wait for an approval prompt that has not
   been reaching the owner. Use flags (`active`, `revoked`, `deleted`) instead.
3. Deploy `supabase/functions/sd-push-tick/index.ts` as edge function `sd-push-tick` with JWT
   verification **off** (it checks its own secret from `sd_push_keys`).
4. Run `select public.sd_push_kick();` once so the sender creates its keys, then again to check
   it answers `{"boards":0}`.
5. Schedule it: `select cron.schedule('sd-push-tick', '* * * * *', 'select public.sd_push_kick()');`
6. In `index.html` (source of truth: the page source in the repo root, inside the wrapper),
   change `SB_URL` and `SB_KEY` to the new project's URL and publishable key. Also change the
   Supabase host in `extension/manifest.json` (`host_permissions`) and in `extension/board.html`
   / `extension/app.js`, then bump the extension version and rebuild `sticky-desk-chrome.zip`.
7. Bump `CACHE` in `sw.js` so phones pick up the new page.
8. Deploy to Vercel (project `prj_E8kFPHLTljPJcAfBxEVXs3z3PzDA`, team `team_yo68ADPY9FrufbxcMDhToMLb`).

## Data

Nothing needs copying. Each device keeps a full copy of the board. On the new project the owner
creates the board again as **saiful** with the same PIN on the device that has the latest notes;
the app's sign-in uploads everything the server doesn't have. Then sign in on the other devices.
Notifications and the Siri key are set up again from Settings.

## Afterwards

The old `sd_*` tables, functions and the `sd-push-tick` cron job in the ledger project can be
switched off (`select cron.unschedule('sd-push-tick');`) and later removed, with the owner's OK.

## Editing the app

Edit `src/page.html` (the page without its wrapper), then run `sh tools/build.sh` from the repo
root to rebuild `index.html`, the `extension/` folder and `sticky-desk-chrome.zip`.
