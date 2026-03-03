-- Workflow DOC-Einstein: aluno + administração + timeline + storage
-- Execute este script no SQL Editor do projeto Supabase correto.

create extension if not exists pgcrypto;

create table if not exists public.lp_document_requests (
  id uuid primary key default gen_random_uuid(),
  protocol text not null unique,
  requester_identifier text not null,
  requester_name text not null,
  requester_email text not null,
  form_type text not null,
  document_type text,
  document_other text,
  cpf text,
  rg text,
  whatsapp text,
  matricula text,
  id_document_path text,
  id_document_mime text,
  id_document_size bigint,
  status text not null default 'requerimento_em_analise',
  signed_by_admin boolean not null default false,
  signed_by_secretaria boolean not null default false,
  signed_at timestamptz,
  producing_started_at timestamptz,
  production_ready_at timestamptz,
  digital_sent_at timestamptz,
  physical_ready_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.lp_document_requests add column if not exists document_type text;
alter table public.lp_document_requests add column if not exists document_other text;
alter table public.lp_document_requests add column if not exists cpf text;
alter table public.lp_document_requests add column if not exists rg text;
alter table public.lp_document_requests add column if not exists whatsapp text;
alter table public.lp_document_requests add column if not exists matricula text;
alter table public.lp_document_requests add column if not exists id_document_path text;
alter table public.lp_document_requests add column if not exists id_document_mime text;
alter table public.lp_document_requests add column if not exists id_document_size bigint;
alter table public.lp_document_requests add column if not exists status text default 'requerimento_em_analise';
alter table public.lp_document_requests add column if not exists signed_by_admin boolean not null default false;
alter table public.lp_document_requests add column if not exists signed_by_secretaria boolean not null default false;
alter table public.lp_document_requests add column if not exists signed_at timestamptz;
alter table public.lp_document_requests add column if not exists producing_started_at timestamptz;
alter table public.lp_document_requests add column if not exists production_ready_at timestamptz;
alter table public.lp_document_requests add column if not exists digital_sent_at timestamptz;
alter table public.lp_document_requests add column if not exists physical_ready_at timestamptz;
alter table public.lp_document_requests add column if not exists updated_at timestamptz not null default now();

create table if not exists public.lp_request_status_history (
  id bigserial primary key,
  request_id uuid not null references public.lp_document_requests(id) on delete cascade,
  protocol text not null,
  old_status text,
  new_status text not null,
  changed_by text not null,
  changed_by_email text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_lp_document_requests_requester_identifier
  on public.lp_document_requests (requester_identifier);
create index if not exists idx_lp_document_requests_status
  on public.lp_document_requests (status);
create index if not exists idx_lp_request_status_history_request
  on public.lp_request_status_history (request_id, created_at desc);
create index if not exists idx_lp_request_status_history_protocol
  on public.lp_request_status_history (protocol, created_at desc);

create or replace function public.tg_lp_document_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_lp_document_requests_updated_at on public.lp_document_requests;
create trigger trg_lp_document_requests_updated_at
before update on public.lp_document_requests
for each row
execute function public.tg_lp_document_requests_updated_at();

alter table public.lp_document_requests enable row level security;
alter table public.lp_request_status_history enable row level security;

drop policy if exists authenticated_insert_own_lp_requests on public.lp_document_requests;
drop policy if exists authenticated_select_own_lp_requests on public.lp_document_requests;
drop policy if exists admin_secretaria_select_all_lp_requests on public.lp_document_requests;
drop policy if exists admin_secretaria_update_all_lp_requests on public.lp_document_requests;

create policy authenticated_insert_own_lp_requests
on public.lp_document_requests
for insert
to authenticated
with check (
  requester_identifier = auth.uid()::text
  and coalesce(status, 'requerimento_em_analise') = 'requerimento_em_analise'
  and coalesce(signed_by_admin, false) = false
  and coalesce(signed_by_secretaria, false) = false
);

create policy authenticated_select_own_lp_requests
on public.lp_document_requests
for select
to authenticated
using (requester_identifier = auth.uid()::text);

create policy admin_secretaria_select_all_lp_requests
on public.lp_document_requests
for select
to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

create policy admin_secretaria_update_all_lp_requests
on public.lp_document_requests
for update
to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
)
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

drop policy if exists authenticated_select_own_lp_history on public.lp_request_status_history;
drop policy if exists authenticated_insert_own_lp_history on public.lp_request_status_history;
drop policy if exists admin_secretaria_select_all_lp_history on public.lp_request_status_history;
drop policy if exists admin_secretaria_insert_all_lp_history on public.lp_request_status_history;

create policy authenticated_select_own_lp_history
on public.lp_request_status_history
for select
to authenticated
using (
  exists (
    select 1
    from public.lp_document_requests req
    where req.id = lp_request_status_history.request_id
      and req.requester_identifier = auth.uid()::text
  )
);

create policy authenticated_insert_own_lp_history
on public.lp_request_status_history
for insert
to authenticated
with check (
  exists (
    select 1
    from public.lp_document_requests req
    where req.id = lp_request_status_history.request_id
      and req.requester_identifier = auth.uid()::text
  )
);

create policy admin_secretaria_select_all_lp_history
on public.lp_request_status_history
for select
to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

create policy admin_secretaria_insert_all_lp_history
on public.lp_request_status_history
for insert
to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'id_autorizacao_enviados',
  'id_autorizacao_enviados',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id)
do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists authenticated_upload_own_id_docs on storage.objects;
drop policy if exists authenticated_read_own_or_admin_id_docs on storage.objects;
drop policy if exists admin_secretaria_insert_id_docs on storage.objects;
drop policy if exists admin_secretaria_update_id_docs on storage.objects;
drop policy if exists admin_secretaria_delete_id_docs on storage.objects;

create policy authenticated_upload_own_id_docs
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'id_autorizacao_enviados'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy authenticated_read_own_or_admin_id_docs
on storage.objects
for select
to authenticated
using (
  bucket_id = 'id_autorizacao_enviados'
  and (
    (storage.foldername(name))[1] = auth.uid()::text
    or lower(coalesce(auth.jwt() ->> 'email', '')) in (
      'diretor@einsteinhub.co',
      'secretaria@einsteinhub.co'
    )
  )
);

create policy admin_secretaria_insert_id_docs
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'id_autorizacao_enviados'
  and lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

create policy admin_secretaria_update_id_docs
on storage.objects
for update
to authenticated
using (
  bucket_id = 'id_autorizacao_enviados'
  and lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
)
with check (
  bucket_id = 'id_autorizacao_enviados'
  and lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

create policy admin_secretaria_delete_id_docs
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'id_autorizacao_enviados'
  and lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);
