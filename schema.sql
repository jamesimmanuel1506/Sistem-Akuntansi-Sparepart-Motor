-- Jalankan seluruh file ini pada SQL Editor project Supabase.
create extension if not exists pgcrypto;

create table if not exists public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 120),
  party_type text not null check (party_type in ('customer', 'supplier', 'both')),
  phone text check (phone is null or char_length(phone) <= 30),
  created_at timestamptz not null default now()
);

create table if not exists public.spare_parts (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (char_length(trim(sku)) between 1 and 40),
  name text not null check (char_length(trim(name)) between 1 and 120),
  category text check (category is null or char_length(category) <= 80),
  stock integer not null default 0 check (stock >= 0),
  cost_price numeric(14, 2) not null default 0 check (cost_price >= 0),
  selling_price numeric(14, 2) not null check (selling_price >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.spare_parts
  add column if not exists opening_stock integer not null default 0 check (opening_stock >= 0),
  add column if not exists opening_cost numeric(14, 2) not null default 0 check (opening_cost >= 0),
  add column if not exists opening_balance_initialized boolean not null default false;

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_type text not null check (transaction_type in ('purchase', 'sale')),
  transaction_date date not null default current_date,
  party_id uuid not null references public.parties(id),
  total_amount numeric(14, 2) not null default 0 check (total_amount >= 0),
  notes text check (notes is null or char_length(notes) <= 500),
  created_at timestamptz not null default now()
);

create table if not exists public.transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  spare_part_id uuid not null references public.spare_parts(id),
  line_number integer not null default 0 check (line_number >= 0),
  quantity integer not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  unit_cost numeric(14, 2) not null check (unit_cost >= 0),
  line_total numeric(16, 2) generated always as (quantity * unit_price) stored
);

alter table public.transaction_items
  add column if not exists line_number integer not null default 0 check (line_number >= 0);

update public.transaction_items ti
set line_number = numbered.line_number
from (
  select id, row_number() over (
    partition by transaction_id order by spare_part_id, id
  ) as line_number
  from public.transaction_items
  where line_number = 0
) as numbered
where ti.id = numbered.id;

do $migration$
declare
  part record;
  movement record;
  inferred_stock bigint;
  inferred_value numeric;
begin
  for part in
    select id, name, stock, cost_price
    from public.spare_parts
    where not opening_balance_initialized
    order by id
    for update
  loop
    inferred_stock := part.stock;
    inferred_value := part.stock * part.cost_price;

    for movement in
      select ti.quantity, ti.unit_price, ti.unit_cost, t.transaction_type
      from public.transaction_items ti
      join public.transactions t on t.id = ti.transaction_id
      where ti.spare_part_id = part.id
      order by t.created_at desc, t.id desc, ti.line_number desc, ti.id desc
    loop
      if movement.transaction_type = 'sale' then
        inferred_stock := inferred_stock + movement.quantity;
        inferred_value := inferred_value + (movement.quantity * movement.unit_cost);
      else
        inferred_stock := inferred_stock - movement.quantity;
        inferred_value := inferred_value - (movement.quantity * movement.unit_price);
      end if;
      if inferred_stock < 0 or inferred_value < -0.01 then
        raise exception 'Saldo awal % tidak dapat dihitung dari riwayat transaksi. Periksa stok dan harga pokok sebelum migrasi.', part.name;
      end if;
    end loop;

    if inferred_stock > 2147483647 then
      raise exception 'Saldo awal % melebihi batas stok maksimum.', part.name;
    end if;
    update public.spare_parts
    set opening_stock = inferred_stock::integer,
        opening_cost = case
          when inferred_stock > 0 then greatest(round(inferred_value / inferred_stock, 2), 0)
          else 0
        end,
        opening_balance_initialized = true
    where id = part.id;
  end loop;
end;
$migration$;

create index if not exists transactions_date_idx on public.transactions (transaction_date desc);
create index if not exists transactions_party_idx on public.transactions (party_id);
create index if not exists transaction_items_transaction_idx on public.transaction_items (transaction_id);
create index if not exists transaction_items_spare_part_idx on public.transaction_items (spare_part_id);

alter table public.parties enable row level security;
alter table public.spare_parts enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_items enable row level security;

create or replace function public.create_transaction(
  p_transaction_type text,
  p_party_id uuid,
  p_transaction_date date,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_transaction_id uuid;
  item jsonb;
  part public.spare_parts%rowtype;
  item_quantity integer;
  item_price numeric(14, 2);
  item_cost numeric(14, 2);
  item_number bigint := 0;
  calculated_total numeric(14, 2) := 0;
  party_role text;
begin
  perform pg_advisory_xact_lock(hashtext('rodakas-inventory-ledger'));
  if p_transaction_type not in ('purchase', 'sale') then
    raise exception 'Jenis transaksi tidak valid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Transaksi harus memiliki minimal satu barang';
  end if;

  select party_type into party_role from public.parties where id = p_party_id;
  if party_role is null then
    raise exception 'Pelanggan atau pemasok tidak ditemukan';
  end if;
  if p_transaction_type = 'sale' and party_role not in ('customer', 'both') then
    raise exception 'Kontak yang dipilih bukan pelanggan';
  end if;
  if p_transaction_type = 'purchase' and party_role not in ('supplier', 'both') then
    raise exception 'Kontak yang dipilih bukan pemasok';
  end if;
  if p_notes is not null and char_length(p_notes) > 500 then
    raise exception 'Catatan maksimal 500 karakter';
  end if;

  insert into public.transactions (transaction_type, transaction_date, party_id, notes)
  values (p_transaction_type, coalesce(p_transaction_date, current_date), p_party_id, nullif(trim(p_notes), ''))
  returning id into new_transaction_id;

  for item in select value from jsonb_array_elements(p_items)
  loop
    item_number := item_number + 1;
    if nullif(item->>'spare_part_id', '') is null
       or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]*$'
       or coalesce(item->>'unit_price', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Rincian barang atau harga tidak valid';
    end if;
    item_quantity := (item->>'quantity')::integer;
    item_price := (item->>'unit_price')::numeric(14, 2);
    if item_price > 999999999999.99 then
      raise exception 'Harga barang melebihi batas';
    end if;

    select * into part from public.spare_parts
    where id = (item->>'spare_part_id')::uuid and is_active
    for update;
    if not found then
      raise exception 'Sparepart tidak ditemukan atau sudah tidak aktif';
    end if;

    if p_transaction_type = 'sale' then
      if part.stock < item_quantity then
        raise exception 'Stok % tidak mencukupi (tersedia %)', part.name, part.stock;
      end if;
      item_cost := part.cost_price;
      update public.spare_parts set stock = stock - item_quantity where id = part.id;
    else
      item_cost := item_price;
      update public.spare_parts
      set stock = stock + item_quantity,
          cost_price = case
            when stock + item_quantity = 0 then item_price
            else round(((stock * cost_price) + (item_quantity * item_price)) / (stock + item_quantity), 2)
          end
      where id = part.id;
    end if;

    insert into public.transaction_items (transaction_id, spare_part_id, line_number, quantity, unit_price, unit_cost)
    values (new_transaction_id, part.id, item_number, item_quantity, item_price, item_cost);
    calculated_total := calculated_total + (item_quantity * item_price);
  end loop;

  update public.transactions set total_amount = calculated_total where id = new_transaction_id;
  return new_transaction_id;
end;
$$;

create or replace function public.rebuild_inventory()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  part record;
  movement record;
  current_stock bigint;
  current_cost numeric(14, 2);
begin
  for part in select * from public.spare_parts order by id for update
  loop
    current_stock := part.opening_stock;
    current_cost := part.opening_cost;

    for movement in
      select ti.id, ti.quantity, ti.unit_price, t.transaction_type
      from public.transaction_items ti
      join public.transactions t on t.id = ti.transaction_id
      where ti.spare_part_id = part.id
      order by t.created_at, t.id, ti.line_number, ti.id
    loop
      if movement.transaction_type = 'purchase' then
        current_cost := case
          when current_stock + movement.quantity = 0 then movement.unit_price
          else round(
            ((current_stock * current_cost) + (movement.quantity * movement.unit_price))
            / (current_stock + movement.quantity), 2
          )
        end;
        current_stock := current_stock + movement.quantity;
        update public.transaction_items set unit_cost = movement.unit_price where id = movement.id;
      else
        if current_stock < movement.quantity then
          raise exception 'Perubahan transaksi membuat stok % tidak mencukupi pada riwayat transaksi', part.name
            using errcode = '23514';
        end if;
        update public.transaction_items set unit_cost = current_cost where id = movement.id;
        current_stock := current_stock - movement.quantity;
      end if;
      if current_stock > 2147483647 then
        raise exception 'Stok % melebihi batas maksimum', part.name using errcode = '22003';
      end if;
    end loop;

    update public.spare_parts
    set stock = current_stock::integer, cost_price = current_cost
    where id = part.id;
  end loop;
end;
$$;

create or replace function public.update_transaction(
  p_transaction_id uuid,
  p_transaction_type text,
  p_party_id uuid,
  p_transaction_date date,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  item_number bigint;
  item_quantity integer;
  item_price numeric(14, 2);
  party_role text;
begin
  perform pg_advisory_xact_lock(hashtext('rodakas-inventory-ledger'));
  perform 1 from public.transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaksi tidak ditemukan';
  end if;
  if p_transaction_type not in ('purchase', 'sale') then
    raise exception 'Jenis transaksi tidak valid';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Transaksi harus memiliki minimal satu barang';
  end if;

  select party_type into party_role from public.parties where id = p_party_id;
  if party_role is null then
    raise exception 'Pelanggan atau pemasok tidak ditemukan';
  end if;
  if p_transaction_type = 'sale' and party_role not in ('customer', 'both') then
    raise exception 'Kontak yang dipilih bukan pelanggan';
  end if;
  if p_transaction_type = 'purchase' and party_role not in ('supplier', 'both') then
    raise exception 'Kontak yang dipilih bukan pemasok';
  end if;
  if p_notes is not null and char_length(p_notes) > 500 then
    raise exception 'Catatan maksimal 500 karakter';
  end if;

  update public.transactions
  set transaction_type = p_transaction_type,
      transaction_date = coalesce(p_transaction_date, current_date),
      party_id = p_party_id,
      notes = nullif(trim(p_notes), '')
  where id = p_transaction_id;
  delete from public.transaction_items where transaction_id = p_transaction_id;

  for item, item_number in
    select value, ordinality from jsonb_array_elements(p_items) with ordinality
  loop
    if nullif(item->>'spare_part_id', '') is null
       or coalesce(item->>'quantity', '') !~ '^[1-9][0-9]*$'
       or coalesce(item->>'unit_price', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' then
      raise exception 'Rincian barang atau harga tidak valid';
    end if;
    if (item->>'spare_part_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Sparepart tidak valid';
    end if;
    item_quantity := (item->>'quantity')::integer;
    item_price := (item->>'unit_price')::numeric(14, 2);
    if item_price > 999999999999.99 then
      raise exception 'Harga barang melebihi batas';
    end if;
    if not exists (
      select 1 from public.spare_parts
      where id = (item->>'spare_part_id')::uuid and is_active
    ) then
      raise exception 'Sparepart tidak ditemukan atau sudah tidak aktif';
    end if;
    insert into public.transaction_items (transaction_id, spare_part_id, line_number, quantity, unit_price, unit_cost)
    values (p_transaction_id, (item->>'spare_part_id')::uuid, item_number, item_quantity, item_price, item_price);
  end loop;

  update public.transactions
  set total_amount = (
    select coalesce(sum(line_total), 0)
    from public.transaction_items
    where transaction_id = p_transaction_id
  )
  where id = p_transaction_id;
  perform public.rebuild_inventory();
  return p_transaction_id;
end;
$$;

create or replace function public.delete_transaction(p_transaction_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('rodakas-inventory-ledger'));
  perform 1 from public.transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaksi tidak ditemukan';
  end if;
  delete from public.transactions where id = p_transaction_id;
  perform public.rebuild_inventory();
  return p_transaction_id;
end;
$$;

revoke all on function public.create_transaction(text, uuid, date, text, jsonb) from public, anon, authenticated;
revoke all on function public.rebuild_inventory() from public, anon, authenticated;
revoke all on function public.update_transaction(uuid, text, uuid, date, text, jsonb) from public, anon, authenticated;
revoke all on function public.delete_transaction(uuid) from public, anon, authenticated;
grant execute on function public.create_transaction(text, uuid, date, text, jsonb) to service_role;
grant execute on function public.update_transaction(uuid, text, uuid, date, text, jsonb) to service_role;
grant execute on function public.delete_transaction(uuid) to service_role;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.parties, public.spare_parts to service_role;
grant select, insert, update, delete on public.transactions, public.transaction_items to service_role;

revoke all on public.parties, public.spare_parts, public.transactions, public.transaction_items
  from anon, authenticated;
grant usage on schema public to anon;
grant select on public.parties, public.spare_parts, public.transactions, public.transaction_items to anon;
grant insert (name, party_type, phone), update (name, party_type, phone), delete
  on public.parties to anon;
grant insert (sku, name, category, selling_price),
      update (sku, name, category, selling_price), delete
  on public.spare_parts to anon;

drop policy if exists rodakas_public_read_parties on public.parties;
create policy rodakas_public_read_parties on public.parties for select to anon using (true);
drop policy if exists rodakas_public_write_parties on public.parties;
create policy rodakas_public_write_parties on public.parties for all to anon using (true) with check (true);

drop policy if exists rodakas_public_read_spare_parts on public.spare_parts;
create policy rodakas_public_read_spare_parts on public.spare_parts for select to anon using (true);
drop policy if exists rodakas_public_write_spare_parts on public.spare_parts;
create policy rodakas_public_write_spare_parts on public.spare_parts for all to anon using (true) with check (true);

drop policy if exists rodakas_public_read_transactions on public.transactions;
create policy rodakas_public_read_transactions on public.transactions for select to anon using (true);
drop policy if exists rodakas_public_read_transaction_items on public.transaction_items;
create policy rodakas_public_read_transaction_items on public.transaction_items for select to anon using (true);

grant execute on function public.create_transaction(text, uuid, date, text, jsonb) to anon;
grant execute on function public.update_transaction(uuid, text, uuid, date, text, jsonb) to anon;
grant execute on function public.delete_transaction(uuid) to anon;
