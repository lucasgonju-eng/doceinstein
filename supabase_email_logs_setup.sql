-- Auditoria de envio de e-mails do workflow DOC-Einstein
-- Execute no SQL Editor do projeto Supabase (ijyuinzducrtgerupcyk)

create extension if not exists pgcrypto;

create table if not exists public.lp_email_event_logs (
  id uuid primary key default gen_random_uuid(),
  protocol text not null,
  request_id uuid null references public.lp_document_requests(id) on delete set null,
  event_type text not null,
  recipient_email text not null,
  provider text not null default 'resend',
  provider_message_id text,
  status text not null check (status in ('success', 'error')),
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_lp_email_event_logs_protocol
  on public.lp_email_event_logs (protocol, created_at desc);

create index if not exists idx_lp_email_event_logs_request_id
  on public.lp_email_event_logs (request_id, created_at desc);

create index if not exists idx_lp_email_event_logs_event_status
  on public.lp_email_event_logs (event_type, status, created_at desc);

alter table public.lp_email_event_logs enable row level security;

drop policy if exists admin_secretaria_select_email_logs on public.lp_email_event_logs;
drop policy if exists user_select_own_email_logs on public.lp_email_event_logs;

create policy admin_secretaria_select_email_logs
on public.lp_email_event_logs
for select
to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'diretor@einsteinhub.co',
    'secretaria@einsteinhub.co'
  )
);

-- Opcional para transparência ao usuário: pode ver logs vinculados ao seu pedido
create policy user_select_own_email_logs
on public.lp_email_event_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.lp_document_requests req
    where req.id = lp_email_event_logs.request_id
      and req.requester_identifier = auth.uid()::text
  )
);
