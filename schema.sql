-- Shop Inventory: database schema for Supabase
-- Paste this whole file into Supabase > SQL Editor and run it once.
-- Then add yourself as the first admin (see the bottom of this file).

-------------------------------------------------------------------------------
-- Tables
-------------------------------------------------------------------------------

-- Who may use the app. Anyone can request a sign-in code, but only emails
-- listed here can see or change anything.
create table public.members (
  email     text primary key check (email = lower(email)),
  role      text not null default 'editor' check (role in ('admin', 'editor')),
  added_at  timestamptz not null default now()
);

-- One row per kind of part. Quantity is the total across all its bins.
create table public.parts (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) > 0),
  sku          text,
  category     text,
  unit         text not null default 'pcs',
  quantity     integer not null default 0 check (quantity >= 0),
  reorder_at   integer not null default 0 check (reorder_at >= 0),
  supplier     text,
  reorder_url  text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index parts_name_idx     on public.parts (lower(name));
create index parts_category_idx on public.parts (category);

-- One row per physical bin. The NFC tag on the bin holds the bin ID, so a
-- bin can be re-pointed at a different part without rewriting its tag.
create table public.bins (
  id          text primary key check (id ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  location    text,
  part_id     uuid references public.parts (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index bins_part_idx on public.bins (part_id);

-- Every change to a count, who made it, and when.
create table public.stock_log (
  id              bigint generated always as identity primary key,
  part_id         uuid not null references public.parts (id) on delete cascade,
  bin_id          text references public.bins (id) on delete set null,
  delta           integer not null,
  quantity_after  integer not null,
  reason          text,
  user_email      text,
  created_at      timestamptz not null default now()
);
create index stock_log_part_idx on public.stock_log (part_id, created_at desc);
create index stock_log_time_idx on public.stock_log (created_at desc);

create function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger parts_touch_updated_at
  before update on public.parts
  for each row execute function public.touch_updated_at();

-------------------------------------------------------------------------------
-- Who is asking?
-------------------------------------------------------------------------------

create function public.current_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where email = public.current_email());
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.members
    where email = public.current_email() and role = 'admin'
  );
$$;

-------------------------------------------------------------------------------
-- Row-level security
-------------------------------------------------------------------------------

alter table public.members   enable row level security;
alter table public.parts     enable row level security;
alter table public.bins      enable row level security;
alter table public.stock_log enable row level security;

-- Members: everyone on the list can see the list; only admins change it.
create policy "members can read members" on public.members
  for select to authenticated
  using (public.is_member() or email = public.current_email());
create policy "admins add members" on public.members
  for insert to authenticated with check (public.is_admin());
create policy "admins change members" on public.members
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins remove members" on public.members
  for delete to authenticated using (public.is_admin());

-- Parts and bins: members read, add and edit; only admins delete.
create policy "members read parts" on public.parts
  for select to authenticated using (public.is_member());
create policy "members add parts" on public.parts
  for insert to authenticated with check (public.is_member());
create policy "members edit parts" on public.parts
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "admins delete parts" on public.parts
  for delete to authenticated using (public.is_admin());

create policy "members read bins" on public.bins
  for select to authenticated using (public.is_member());
create policy "members add bins" on public.bins
  for insert to authenticated with check (public.is_member());
create policy "members edit bins" on public.bins
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy "admins delete bins" on public.bins
  for delete to authenticated using (public.is_admin());

-- Stock log: read-only for members. Rows are written by the functions below.
create policy "members read stock log" on public.stock_log
  for select to authenticated using (public.is_member());

-- Table access for signed-in users. The policies above decide which rows.
-- (Granted explicitly because newer Supabase projects may not grant by default.)
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on public.members, public.bins to authenticated;
grant select, delete on public.parts to authenticated;
grant select on public.stock_log to authenticated;
grant all on public.members, public.parts, public.bins, public.stock_log to service_role;

-- Logged-out visitors get nothing.
revoke all on public.members, public.parts, public.bins, public.stock_log from anon;

-- Quantity can only change through adjust_stock / set_stock, so every change
-- is logged. Members can edit every other part field directly.
revoke insert, update on public.parts from authenticated;
grant insert (name, sku, category, unit, reorder_at, supplier, reorder_url, notes)
  on public.parts to authenticated;
grant update (name, sku, category, unit, reorder_at, supplier, reorder_url, notes)
  on public.parts to authenticated;
revoke insert, update, delete on public.stock_log from authenticated;

-------------------------------------------------------------------------------
-- Changing counts
-------------------------------------------------------------------------------

-- Add (positive delta) or take (negative delta). Safe when two people tap at
-- the same moment: the update is a single atomic statement.
create function public.adjust_stock(
  p_part_id uuid,
  p_delta   integer,
  p_bin_id  text default null,
  p_reason  text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_qty integer;
begin
  if not public.is_member() then
    raise exception 'This email is not on the member list' using errcode = '42501';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'Enter an amount greater than zero';
  end if;

  update public.parts
     set quantity = quantity + p_delta
   where id = p_part_id and quantity + p_delta >= 0
  returning quantity into v_qty;

  if v_qty is null then
    select quantity into v_qty from public.parts where id = p_part_id;
    if v_qty is null then
      raise exception 'Part not found';
    end if;
    raise exception 'Only % in stock. If the bin holds more, use Set count to correct it.', v_qty;
  end if;

  insert into public.stock_log (part_id, bin_id, delta, quantity_after, reason, user_email)
  values (p_part_id, nullif(upper(trim(p_bin_id)), ''), p_delta, v_qty,
          nullif(trim(p_reason), ''), public.current_email());

  return v_qty;
end;
$$;

-- Set an exact count, for example after counting a bin by hand.
create function public.set_stock(
  p_part_id  uuid,
  p_quantity integer,
  p_bin_id   text default null,
  p_reason   text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_old integer;
begin
  if not public.is_member() then
    raise exception 'This email is not on the member list' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'Count must be zero or more';
  end if;

  select quantity into v_old from public.parts where id = p_part_id for update;
  if not found then
    raise exception 'Part not found';
  end if;
  if v_old = p_quantity then
    return v_old;
  end if;

  update public.parts set quantity = p_quantity where id = p_part_id;

  insert into public.stock_log (part_id, bin_id, delta, quantity_after, reason, user_email)
  values (p_part_id, nullif(upper(trim(p_bin_id)), ''), p_quantity - v_old, p_quantity,
          coalesce(nullif(trim(p_reason), ''), 'Counted'), public.current_email());

  return p_quantity;
end;
$$;

revoke execute on function public.adjust_stock(uuid, integer, text, text) from public, anon;
revoke execute on function public.set_stock(uuid, integer, text, text)    from public, anon;
grant  execute on function public.adjust_stock(uuid, integer, text, text) to authenticated;
grant  execute on function public.set_stock(uuid, integer, text, text)    to authenticated;

-------------------------------------------------------------------------------
-- Views used by the app and the low-stock alert
-------------------------------------------------------------------------------

create view public.part_status with (security_invoker = true) as
select
  p.*,
  case when p.quantity = 0 then 'out'
       when p.quantity <= p.reorder_at then 'low'
       else 'ok' end as status,
  case when p.quantity = 0 then 0
       when p.quantity <= p.reorder_at then 1
       else 2 end as status_rank,
  (select string_agg(b.id, ', ' order by b.id)
     from public.bins b where b.part_id = p.id) as bin_ids
from public.parts p;

create view public.part_categories with (security_invoker = true) as
select distinct category
from public.parts
where category is not null and category <> ''
order by category;

revoke all on public.part_status, public.part_categories from anon;
grant select on public.part_status, public.part_categories to authenticated, service_role;

-------------------------------------------------------------------------------
-- First admin: change the email to yours, then run just this line.
-------------------------------------------------------------------------------
-- insert into public.members (email, role) values ('you@example.com', 'admin');
