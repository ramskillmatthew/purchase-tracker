alter table public.purchases
add column if not exists arrived boolean;

alter table public.purchases
alter column arrived drop not null,
alter column arrived drop default;
