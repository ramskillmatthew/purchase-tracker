do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'expense_date') then
    alter table public.expenses rename column expense_date to purchase_date;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'description') then
    alter table public.expenses rename column description to item_description;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'amount') then
    alter table public.expenses rename column amount to cost;
  end if;
end $$;

alter table public.expenses
  add column if not exists purchased_from text,
  add column if not exists arrived boolean;

-- Keep the old hidden category field compatible if it already exists.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'expenses' and column_name = 'category') then
    alter table public.expenses alter column category drop not null;
  end if;
end $$;
