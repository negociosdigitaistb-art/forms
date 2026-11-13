-- TB Forms · usuários (rodar uma vez no projeto TB Disparador)
create table if not exists public.fm_usuarios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nome text not null default '',
  email text not null default '',
  criado_em timestamptz not null default now(),
  criado_por uuid
);
alter table public.fm_usuarios enable row level security;

-- quem já administrava (Webnario) continua com acesso
insert into public.fm_usuarios(user_id, nome, email)
select a.user_id, coalesce(nullif(a.nome,''), split_part(u.email,'@',1)), coalesce(u.email,'')
from public.wb_admins a join auth.users u on u.id = a.user_id
on conflict (user_id) do nothing;

create or replace function public.fm_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.fm_usuarios where user_id = auth.uid());
$$;

-- usada só pela função fm-usuarios para achar um login que já existe
create or replace function public.fm_id_por_email(p_email text) returns uuid
language sql stable security definer set search_path = public, auth as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke all on function public.fm_id_por_email(text) from public, anon, authenticated;
grant execute on function public.fm_id_por_email(text) to service_role;

drop policy if exists fm_usuarios_ler on public.fm_usuarios;
create policy fm_usuarios_ler on public.fm_usuarios for select to authenticated using (public.fm_is_admin());
revoke insert, update, delete on public.fm_usuarios from anon, authenticated;
revoke all on public.fm_usuarios from anon;

-- ===== ActiveCampaign (fm-active) =====
create table if not exists public.fm_config (
  chave text primary key, url text, api_key text, conta text,
  atualizado_em timestamptz not null default now()
);
alter table public.fm_config enable row level security;
revoke all on public.fm_config from anon, authenticated;
alter table public.fm_respostas add column if not exists integracoes jsonb not null default '{}'::jsonb;

-- ===== Parâmetros do link (fm_ajustes) — ver migração fm_ajustes_parametros =====
create table if not exists public.fm_ajustes (chave text primary key, valor jsonb not null default '{}'::jsonb, atualizado_em timestamptz not null default now());
alter table public.fm_ajustes enable row level security;
-- política fm_ajustes_admin (fm_is_admin) e fm_publico devolvendo 'captura'
