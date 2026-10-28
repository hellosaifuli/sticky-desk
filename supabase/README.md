# Sticky Desk database (Supabase)

Lives in the **taarun-mart-ledger** project, kept apart from the ledger app:

- Tables `sd_boards`, `sd_tokens` and `sd_items` have row level security on and **no policies**, and `anon`/`authenticated` have no table rights. Nothing can read them directly.
- The app only calls these functions (all `security definer`, `search_path = ''`):

| Function | Who can call | What it does |
|---|---|---|
| `sd_register(name, pin)` | anyone | Creates a board. PIN stored as a bcrypt hash. Returns a device token. |
| `sd_sign_in(name, pin)` | anyone | Returns a new device token. 5 wrong PINs lock the board for 15 min, doubling to 24 h. |
| `sd_pull(token, since)` | holders of a token | Everything changed since `since`, including deletions. |
| `sd_push(token, items)` | holders of a token | Saves up to 500 `{kind, id, data, deleted}` items. |
| `sd_widget(token)` | holders of a token | Counts and the top six open notes for the widget. |
| `sd_new_token(token, label)` | holders of a token | An extra token, e.g. for the widget. |
| `sd_change_pin(token, old, new)` | holders of a token | Changes the PIN. |
| `sd_sign_out(token)` | holders of a token | Placeholder for now: the app forgets its token. Removing the token server-side is a follow-up. |

Internal helpers (`sd_board_for`, `sd_issue_token`, `sd_valid_name`, `sd_valid_pin`) are not callable from the API. Tokens are stored as SHA-256 hashes.

## Follow-ups

- Make `sd_sign_out` delete the token row.
- Remove the test board left from setup (`qa-sticky`, plus one unnamed test board).
