-- Minimal Supabase schema (run in SQL editor). RLS assumes auth.uid() and org on profiles.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  organization_id uuid,
  updated_at timestamptz default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid (),
  user_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in ('benchmark_pdf', 'tax_pdf', 'excel', 'other')),
  filename text not null,
  storage_path text,
  parse_result jsonb,
  created_at timestamptz default now()
);

create index if not exists documents_user_idx on public.documents (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.documents enable row level security;

create policy "profiles self" on public.profiles for all using (auth.uid () = id);

create policy "documents owner" on public.documents for all using (
  auth.uid () = user_id
);
