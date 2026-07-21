-- Allow optional bulk-entry values while preserving the existing purchases table.
alter table public.purchases alter column order_date drop not null;
alter table public.purchases alter column purchased_from drop not null;
alter table public.purchases alter column item_size drop not null;
alter table public.purchases alter column item_condition drop not null;

alter table public.purchases drop constraint if exists purchases_item_condition_check;
