create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  order_date date not null,
  purchased_from text not null,
  seller_name text,
  sku text not null,
  item_description text not null,
  item_size text not null,
  quantity integer not null default 1 check (quantity >= 1),
  item_condition text not null check (item_condition in (
    'Brand new',
    'Brand new without tags',
    'Labelled as very good condition',
    'Good condition from photos',
    'Decent condition from photos'
  )),
  price_purchased numeric(10,2) not null,
  arrived boolean,
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  purchase_date date not null,
  purchased_from text not null,
  arrived boolean,
  item_description text not null,
  cost numeric(10,2) not null,
  created_at timestamptz not null default now()
);

alter table public.purchases enable row level security;
alter table public.expenses enable row level security;
