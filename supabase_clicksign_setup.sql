-- Integração Clicksign: campos de rastreio + eventos webhook
-- Execute no SQL Editor do projeto ijyuinzducrtgerupcyk

alter table public.lp_document_requests
  add column if not exists clicksign_envelope_id text,
  add column if not exists clicksign_document_id text,
  add column if not exists clicksign_signer_admin_id text,
  add column if not exists clicksign_signer_secretaria_id text,
  add column if not exists clicksign_status text,
  add column if not exists clicksign_last_event text,
  add column if not exists clicksign_signed_admin_at timestamptz,
  add column if not exists clicksign_signed_secretaria_at timestamptz,
  add column if not exists secretaria_release_email_at timestamptz;

create index if not exists idx_lp_document_requests_clicksign_envelope
  on public.lp_document_requests (clicksign_envelope_id);

create index if not exists idx_lp_document_requests_clicksign_document
  on public.lp_document_requests (clicksign_document_id);

create table if not exists public.lp_clicksign_events (
  id bigserial primary key,
  event_id text not null unique,
  request_id uuid references public.lp_document_requests(id) on delete set null,
  protocol text,
  event_name text not null,
  payload jsonb not null default '{}'::jsonb,
  processing_status text not null default 'received',
  error_message text,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_lp_clicksign_events_request_id
  on public.lp_clicksign_events (request_id, created_at desc);

create index if not exists idx_lp_clicksign_events_event_name
  on public.lp_clicksign_events (event_name, created_at desc);

alter table public.lp_clicksign_events enable row level security;

drop policy if exists admin_secretaria_select_clicksign_events on public.lp_clicksign_events;
drop policy if exists admin_secretaria_insert_clicksign_events on public.lp_clicksign_events;

create policy admin_secretaria_select_clicksign_events
on public.lp_clicksign_events
for select
to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

create policy admin_secretaria_insert_clicksign_events
on public.lp_clicksign_events
for insert
to authenticated
with check (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);
