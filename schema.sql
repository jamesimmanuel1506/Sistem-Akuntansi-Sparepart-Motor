create extension if not exists pgcrypto;

create table if not exists public.spareparts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  stock integer not null default 0 check (stock >= 0),
  purchase_price numeric(14, 2) not null check (purchase_price >= 0),
  selling_price numeric(14, 2) not null check (selling_price >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_date timestamptz not null default now(),
  type text not null check (type in ('purchase', 'sale')),
  note text not null default '',
  total numeric(14, 2) not null default 0 check (total >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  sparepart_id uuid not null references public.spareparts(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  subtotal numeric(14, 2) generated always as (quantity * unit_price) stored
);

create index if not exists transaction_items_transaction_id_idx on public.transaction_items(transaction_id);
create index if not exists transaction_items_sparepart_id_idx on public.transaction_items(sparepart_id);
create index if not exists transactions_date_idx on public.transactions(transaction_date desc);

alter table public.spareparts enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_items enable row level security;

create or replace function public.apply_transaction_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  transaction_type text;
  selected_price numeric(14, 2);
  current_stock integer;
begin
  select type into transaction_type
  from public.transactions
  where id = new.transaction_id;

  if transaction_type is null then
    raise exception 'Transaksi tidak ditemukan.' using errcode = '23503';
  end if;

  select case when transaction_type = 'sale' then selling_price else purchase_price end, stock
  into selected_price, current_stock
  from public.spareparts
  where id = new.sparepart_id
  for update;

  if not found then
    raise exception 'Sparepart tidak ditemukan.' using errcode = '23503';
  end if;

  if transaction_type = 'sale' and current_stock < new.quantity then
    raise exception 'Stok tidak cukup untuk sparepart ini.' using errcode = '23514';
  end if;

  new.unit_price := selected_price;
  update public.spareparts
  set stock = stock + case when transaction_type = 'purchase' then new.quantity else -new.quantity end
  where id = new.sparepart_id;

  return new;
end;
$$;

create or replace function public.reverse_transaction_item_stock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  transaction_type text;
begin
  select type into transaction_type
  from public.transactions
  where id = old.transaction_id;

  update public.spareparts
  set stock = stock + case when transaction_type = 'purchase' then -old.quantity else old.quantity end
  where id = old.sparepart_id;

  return old;
end;
$$;

create or replace function public.refresh_transaction_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_transaction uuid;
begin
  target_transaction := case when tg_op = 'DELETE' then old.transaction_id else new.transaction_id end;
  update public.transactions
  set total = coalesce((
    select sum(subtotal)
    from public.transaction_items
    where transaction_id = target_transaction
  ), 0)
  where id = target_transaction;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists transaction_item_apply_stock on public.transaction_items;
create trigger transaction_item_apply_stock
before insert on public.transaction_items
for each row execute function public.apply_transaction_item();

drop trigger if exists transaction_item_reverse_stock on public.transaction_items;
create trigger transaction_item_reverse_stock
after delete on public.transaction_items
for each row execute function public.reverse_transaction_item_stock();

drop trigger if exists transaction_item_refresh_total on public.transaction_items;
create trigger transaction_item_refresh_total
after insert or delete on public.transaction_items
for each row execute function public.refresh_transaction_total();

create or replace function public.create_transaction(p_type text, p_note text, p_items jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_transaction_id uuid;
  item jsonb;
  item_quantity integer;
  item_sparepart_id uuid;
begin
  if p_type not in ('purchase', 'sale') then
    raise exception 'Jenis transaksi tidak valid.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Transaksi harus memiliki item.' using errcode = '22023';
  end if;

  insert into public.transactions(type, note)
  values (p_type, coalesce(p_note, ''))
  returning id into new_transaction_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_sparepart_id := (item ->> 'sparepart_id')::uuid;
    item_quantity := (item ->> 'quantity')::integer;
    if item_quantity < 1 then
      raise exception 'Jumlah item harus lebih dari 0.' using errcode = '22023';
    end if;
    insert into public.transaction_items(transaction_id, sparepart_id, quantity, unit_price)
    values (new_transaction_id, item_sparepart_id, item_quantity, 0);
  end loop;

  return new_transaction_id;
end;
$$;

revoke all on function public.apply_transaction_item() from public, anon, authenticated;
revoke all on function public.reverse_transaction_item_stock() from public, anon, authenticated;
revoke all on function public.refresh_transaction_total() from public, anon, authenticated;
revoke all on function public.create_transaction(text, text, jsonb) from public, anon, authenticated;
revoke all on public.spareparts, public.transactions, public.transaction_items from anon, authenticated;
revoke update (code, name, category, purchase_price, selling_price) on public.spareparts from authenticated;
grant usage on schema public to anon;
grant select, insert, delete on public.spareparts to anon;
grant update (code, name, category, purchase_price, selling_price) on public.spareparts to anon;
grant select on public.transactions, public.transaction_items to anon;
grant execute on function public.create_transaction(text, text, jsonb) to anon;

drop policy if exists spareparts_public_read on public.spareparts;
create policy spareparts_public_read on public.spareparts for select to anon using (true);
drop policy if exists spareparts_public_insert on public.spareparts;
create policy spareparts_public_insert on public.spareparts for insert to anon with check (true);
drop policy if exists spareparts_public_update on public.spareparts;
create policy spareparts_public_update on public.spareparts for update to anon using (true) with check (true);
drop policy if exists spareparts_public_delete on public.spareparts;
create policy spareparts_public_delete on public.spareparts for delete to anon using (true);

drop policy if exists transactions_public_read on public.transactions;
create policy transactions_public_read on public.transactions for select to anon using (true);
drop policy if exists transaction_items_public_read on public.transaction_items;
create policy transaction_items_public_read on public.transaction_items for select to anon using (true);

drop policy if exists spareparts_admin_read on public.spareparts;
drop policy if exists spareparts_admin_insert on public.spareparts;
drop policy if exists spareparts_admin_update on public.spareparts;
drop policy if exists spareparts_admin_delete on public.spareparts;
drop policy if exists transactions_admin_read on public.transactions;
drop policy if exists transaction_items_admin_read on public.transaction_items;
drop function if exists public.is_admin();
