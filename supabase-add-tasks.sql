create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,

  title text not null
    check (char_length(trim(title)) > 0),

  notes text,

  category text not null default 'General'
    check (
      category in (
        'General',
        'Stock',
        'Orders',
        'Listings',
        'Returns',
        'Finance',
        'Admin'
      )
    ),

  priority text not null default 'Medium'
    check (
      priority in (
        'Low',
        'Medium',
        'High'
      )
    ),

  due_date date,

  completed boolean not null default false,

  completed_at timestamptz,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now(),

  constraint tasks_completion_state_check
    check (
      (
        completed = false
        and completed_at is null
      )
      or
      (
        completed = true
        and completed_at is not null
      )
    )
);

create index if not exists tasks_owner_active_idx
on public.tasks (
    owner_id,
    completed,
    due_date
);

create index if not exists tasks_owner_completed_idx
on public.tasks (
    owner_id,
    completed_at desc
);

alter table public.tasks
enable row level security;

revoke all
on public.tasks
from anon,
authenticated;
