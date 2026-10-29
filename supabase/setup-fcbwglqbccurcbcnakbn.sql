-- Sticky Desk: full database set-up for a fresh Supabase project.
-- Ready to run in the SQL Editor of project fcbwglqbccurcbcnakbn.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------- boards, items, device tokens ----------
create table public.sd_boards (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  name text unique,
  pin_hash text,
  failed_tries integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create table public.sd_items (
  board_id uuid not null references public.sd_boards(id) on delete cascade,
  kind text not null check (kind in ('note', 'project', 'settings')),
  item_id text not null check (length(item_id) between 1 and 120),
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (board_id, kind, item_id)
);
create index sd_items_board_updated on public.sd_items (board_id, updated_at);
create table public.sd_tokens (
  token_hash text primary key,
  board_id uuid not null references public.sd_boards(id) on delete cascade,
  label text not null default 'device',
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index sd_tokens_board on public.sd_tokens (board_id);

-- ---------- notifications ----------
create table public.sd_push_subs (
  endpoint text primary key,
  board_id uuid not null references public.sd_boards(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{"due": true, "prayer": true, "hour": 9}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_ok timestamptz,
  fails int not null default 0
);
create index sd_push_subs_board on public.sd_push_subs (board_id) where active;
create table public.sd_push_log (
  board_id uuid not null references public.sd_boards(id) on delete cascade,
  tag text not null,
  sent_at timestamptz not null default now(),
  primary key (board_id, tag)
);
create table public.sd_push_queue (
  id bigint generated always as identity primary key,
  board_id uuid not null references public.sd_boards(id) on delete cascade,
  title text not null,
  body text not null,
  sent boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.sd_push_keys (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  tick_secret text not null default encode(extensions.gen_random_bytes(24), 'hex')
);

-- every table is private: the app only talks through the functions below
alter table public.sd_boards enable row level security;
alter table public.sd_items enable row level security;
alter table public.sd_tokens enable row level security;
alter table public.sd_push_subs enable row level security;
alter table public.sd_push_log enable row level security;
alter table public.sd_push_queue enable row level security;
alter table public.sd_push_keys enable row level security;
revoke all on public.sd_boards, public.sd_items, public.sd_tokens, public.sd_push_subs,
  public.sd_push_log, public.sd_push_queue, public.sd_push_keys from anon, authenticated;

-- ---------- helpers ----------
create or replace function public.sd_valid_name(p_name text) returns boolean
language sql immutable set search_path to '' as $$ select p_name ~ '^[a-z0-9][a-z0-9 _.-]{1,38}[a-z0-9]$' $$;
create or replace function public.sd_valid_pin(p_pin text) returns boolean
language sql immutable set search_path to '' as $$ select p_pin ~ '^[0-9]{4,8}$' $$;

create or replace function public.sd_board_for(p_key text) returns uuid
language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select t.board_id from public.sd_tokens t where not t.revoked and t.token_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex')),
    (select b.id from public.sd_boards b where length(coalesce(p_key, '')) >= 32 and b.key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex'))
  );
$$;

create or replace function public.sd_issue_token(p_board uuid, p_label text) returns text
language plpgsql security definer set search_path to '' as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.sd_tokens (token_hash, board_id, label)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), p_board, left(coalesce(p_label, 'device'), 40));
  return v_token;
end;
$$;

-- ---------- sign in ----------
create or replace function public.sd_register(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_name text := lower(trim(coalesce(p_name, '')));
  v_board uuid;
begin
  if not public.sd_valid_name(v_name) then return jsonb_build_object('ok', false, 'error', 'bad_name'); end if;
  if not public.sd_valid_pin(coalesce(p_pin, '')) then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  if exists (select 1 from public.sd_boards where name = v_name) then return jsonb_build_object('ok', false, 'error', 'name_taken'); end if;
  insert into public.sd_boards (key_hash, name, pin_hash)
  values (encode(extensions.gen_random_bytes(32), 'hex'), v_name, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  returning id into v_board;
  return jsonb_build_object('ok', true, 'name', v_name, 'token', public.sd_issue_token(v_board, 'device'));
end;
$$;

create or replace function public.sd_sign_in(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_name text := lower(trim(coalesce(p_name, '')));
  b public.sd_boards%rowtype;
  v_wait interval;
begin
  select * into b from public.sd_boards where name = v_name for update;
  if not found then
    perform extensions.crypt('0000', extensions.gen_salt('bf', 10));
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if b.locked_until is not null and b.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'wait_minutes', ceil(extract(epoch from b.locked_until - now()) / 60));
  end if;
  if b.pin_hash is not null and b.pin_hash = extensions.crypt(coalesce(p_pin, ''), b.pin_hash) then
    update public.sd_boards set failed_tries = 0, locked_until = null, last_seen_at = now() where id = b.id;
    return jsonb_build_object('ok', true, 'name', b.name, 'token', public.sd_issue_token(b.id, 'device'));
  end if;
  b.failed_tries := b.failed_tries + 1;
  if b.failed_tries >= 5 then
    v_wait := least(interval '15 minutes' * power(2, b.failed_tries - 5), interval '24 hours');
    update public.sd_boards set failed_tries = b.failed_tries, locked_until = now() + v_wait where id = b.id;
    return jsonb_build_object('ok', false, 'error', 'locked', 'wait_minutes', ceil(extract(epoch from v_wait) / 60));
  end if;
  update public.sd_boards set failed_tries = b.failed_tries where id = b.id;
  return jsonb_build_object('ok', false, 'error', 'wrong_pin', 'tries_left', 5 - b.failed_tries);
end;
$$;

create or replace function public.sd_change_pin(p_key text, p_old text, p_new text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_board uuid := public.sd_board_for(p_key);
  v_hash text;
begin
  if v_board is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if not public.sd_valid_pin(coalesce(p_new, '')) then return jsonb_build_object('ok', false, 'error', 'bad_pin'); end if;
  select pin_hash into v_hash from public.sd_boards where id = v_board;
  if v_hash <> extensions.crypt(coalesce(p_old, ''), v_hash) then return jsonb_build_object('ok', false, 'error', 'wrong_pin'); end if;
  update public.sd_boards set pin_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)) where id = v_board;
  return jsonb_build_object('ok', true);
end;
$$;

-- signing out revokes this device's key on the server too, so a copied key stops working
create or replace function public.sd_sign_out(p_key text) returns boolean
language plpgsql security definer set search_path to '' as $$
begin
  update public.sd_tokens set revoked = true where token_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex');
  return found;
end;
$$;

create or replace function public.sd_new_token(p_key text, p_label text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_board uuid := public.sd_board_for(p_key);
begin
  if v_board is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if (select count(*) from public.sd_tokens where board_id = v_board and not revoked) >= 30 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;
  return jsonb_build_object('ok', true, 'token', public.sd_issue_token(v_board, p_label));
end;
$$;

-- ---------- sync ----------
create or replace function public.sd_pull(p_key text, p_since timestamptz default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_board uuid := public.sd_board_for(p_key);
begin
  if v_board is null then raise exception 'unknown sync code' using errcode = 'P0002'; end if;
  update public.sd_boards set last_seen_at = now() where id = v_board;
  return jsonb_build_object(
    'now', clock_timestamp(),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('kind', i.kind, 'id', i.item_id, 'data', i.data, 'deleted', i.deleted, 'at', i.updated_at) order by i.updated_at)
      from public.sd_items i
      where i.board_id = v_board and (p_since is null or i.updated_at > p_since)
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.sd_push(p_key text, p_items jsonb) returns timestamptz
language plpgsql security definer set search_path to '' as $$
declare
  v_board uuid := public.sd_board_for(p_key);
  v_item jsonb;
begin
  if v_board is null then raise exception 'unknown sync code' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'send an array of at most 500 items';
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    if pg_column_size(v_item->'data') > 600000 then raise exception 'an item is too large'; end if;
    insert into public.sd_items (board_id, kind, item_id, data, deleted, updated_at)
    values (v_board, v_item->>'kind', v_item->>'id',
      case when coalesce((v_item->>'deleted')::boolean, false) then null else v_item->'data' end,
      coalesce((v_item->>'deleted')::boolean, false), clock_timestamp())
    on conflict (board_id, kind, item_id) do update
      set data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at;
  end loop;
  update public.sd_boards set last_seen_at = now() where id = v_board;
  return clock_timestamp();
end;
$$;

create or replace function public.sd_widget(p_key text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_board uuid := public.sd_board_for(p_key);
begin
  if v_board is null then raise exception 'unknown sync code' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'todo', (select count(*) from public.sd_items where board_id = v_board and kind = 'note' and not deleted and data->>'column' = 'todo'),
    'doing', (select count(*) from public.sd_items where board_id = v_board and kind = 'note' and not deleted and data->>'column' = 'doing'),
    'notes', coalesce((
      select jsonb_agg(s.x order by s.rank, s.ord)
      from (
        select jsonb_build_object(
                 'text', left(coalesce(nullif(i.data->>'text', ''), 'Photo note'), 80),
                 'col', i.data->>'column', 'due', i.data->>'due', 'priority', coalesce((i.data->>'priority')::int, 0),
                 'color', coalesce(p.data->>'color', 'pink')) as x,
               case when i.data->>'column' = 'doing' then 0 else 1 end as rank,
               coalesce((i.data->>'order')::float, 0) as ord
        from public.sd_items i
        left join public.sd_items p on p.board_id = i.board_id and p.kind = 'project' and p.item_id = i.data->>'projectId' and not p.deleted
        where i.board_id = v_board and i.kind = 'note' and not i.deleted and i.data->>'column' in ('todo', 'doing')
        order by rank, ord
        limit 6
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- "Hey Siri, add sticky note"
create or replace function public.sd_quick_add(p_key text, p_text text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_board uuid := public.sd_board_for(p_key);
  v_text text := btrim(coalesce(p_text, ''));
  v_id text := 'n' || to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint) || substr(md5(random()::text), 1, 5);
  v_project text;
  v_order float;
begin
  if v_board is null then raise exception 'unknown sync code' using errcode = 'P0002'; end if;
  if v_text = '' then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
  if (select count(*) from public.sd_items where board_id = v_board and kind = 'note' and data->>'source' = 'siri'
        and updated_at > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'slow_down');
  end if;
  select item_id into v_project from public.sd_items
   where board_id = v_board and kind = 'project' and not deleted
   order by coalesce((data->>'order')::float, 0) limit 1;
  select coalesce(min((data->>'order')::float), 1) - 1 into v_order from public.sd_items
   where board_id = v_board and kind = 'note' and not deleted and data->>'column' = 'todo';
  insert into public.sd_items (board_id, kind, item_id, data, deleted, updated_at)
  values (v_board, 'note', v_id, jsonb_build_object(
      'text', left(v_text, 160), 'column', 'todo', 'projectId', v_project, 'order', v_order,
      'createdAt', (extract(epoch from now()) * 1000)::bigint, 'touchedAt', (extract(epoch from now()) * 1000)::bigint,
      'priority', 0, 'flagged', false, 'due', '', 'repeat', '', 'details', '', 'checklist', '[]'::jsonb,
      'source', 'siri', 'parse', true),
    false, clock_timestamp());
  return jsonb_build_object('ok', true, 'text', left(v_text, 160));
end;
$$;

-- ---------- notifications ----------
create or replace function public.sd_push_public_key() returns text
language sql stable security definer set search_path to '' as $$
  select public_key from public.sd_push_keys where id = 1;
$$;

create or replace function public.sd_push_subscribe(p_key text, p_sub jsonb, p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_board uuid := public.sd_board_for(p_key);
  v_endpoint text := p_sub->>'endpoint';
begin
  if v_board is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if v_endpoint is null or v_endpoint !~ '^https://' or length(v_endpoint) > 1000
     or coalesce(p_sub#>>'{keys,p256dh}', '') = '' or coalesce(p_sub#>>'{keys,auth}', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_subscription');
  end if;
  if (select count(*) from public.sd_push_subs where board_id = v_board and active and endpoint <> v_endpoint) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;
  insert into public.sd_push_subs (endpoint, board_id, p256dh, auth, prefs, active)
  values (v_endpoint, v_board, p_sub#>>'{keys,p256dh}', p_sub#>>'{keys,auth}',
          jsonb_build_object('due', coalesce((p_prefs->>'due')::boolean, true),
                             'prayer', coalesce((p_prefs->>'prayer')::boolean, true),
                             'hour', least(23, greatest(0, coalesce((p_prefs->>'hour')::int, 9)))), true)
  on conflict (endpoint) do update
    set board_id = excluded.board_id, p256dh = excluded.p256dh, auth = excluded.auth,
        prefs = excluded.prefs, active = true, fails = 0;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.sd_push_unsubscribe(p_key text, p_endpoint text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_board uuid := public.sd_board_for(p_key);
begin
  if v_board is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  update public.sd_push_subs set active = false where endpoint = p_endpoint and board_id = v_board;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.sd_push_kick() returns void
language plpgsql security definer set search_path to '' as $$
declare v_secret text := (select tick_secret from public.sd_push_keys where id = 1);
begin
  perform net.http_post(
    url := 'https://fcbwglqbccurcbcnakbn.supabase.co/functions/v1/sd-push-tick',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-tick', coalesce(v_secret, 'setup')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
end;
$$;

create or replace function public.sd_push_test(p_key text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_board uuid := public.sd_board_for(p_key);
begin
  if v_board is null then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if not exists (select 1 from public.sd_push_subs where board_id = v_board and active) then
    return jsonb_build_object('ok', false, 'error', 'no_devices');
  end if;
  if (select count(*) from public.sd_push_queue where board_id = v_board and created_at > now() - interval '10 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'slow_down');
  end if;
  insert into public.sd_push_queue (board_id, title, body)
  values (v_board, 'Sticky Desk', 'Notifications are working. Due notes and prayer times will show up here.');
  perform public.sd_push_kick();
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- who may call what ----------
revoke all on function public.sd_board_for(text), public.sd_issue_token(uuid, text), public.sd_push_kick() from public, anon, authenticated;
grant execute on function
  public.sd_register(text, text), public.sd_sign_in(text, text), public.sd_change_pin(text, text, text),
  public.sd_sign_out(text), public.sd_new_token(text, text), public.sd_pull(text, timestamptz), public.sd_push(text, jsonb),
  public.sd_widget(text), public.sd_quick_add(text, text), public.sd_push_public_key(),
  public.sd_push_subscribe(text, jsonb, jsonb), public.sd_push_unsubscribe(text, text), public.sd_push_test(text)
to anon, authenticated;
