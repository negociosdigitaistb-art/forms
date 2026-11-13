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

-- =====================================================================
-- Contatos (base de alunos) com tags + bloco "Tem a tag?"  (migração fm_contatos_tags)
-- =====================================================================
create or replace function public.fm_tel_norm(t text) returns text language plpgsql immutable set search_path = public as $$
declare d text := regexp_replace(coalesce(t, ''), '\D', '', 'g');
begin
  if length(d) >= 12 and left(d, 2) = '55' then d := substr(d, 3); end if;
  if length(d) < 10 then return null; end if;
  d := right(d, case when length(d) >= 11 then 11 else 10 end);
  return left(d, 2) || right(d, 8);   -- DDD + 8 últimos dígitos (ignora o 9 extra)
end $$;

create or replace function public.fm_norm_tags(t text[]) returns text[] language sql immutable set search_path = public as $$
  select coalesce(array_agg(distinct x order by x), '{}')
  from (select lower(btrim(u)) x from unnest(coalesce(t, '{}')) u) s where x <> '';
$$;

create table if not exists public.fm_contatos (
  id uuid primary key default gen_random_uuid(),
  email text, nome text, telefone text, tel_norm text,
  tags text[] not null default '{}',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create unique index if not exists fm_contatos_email on public.fm_contatos(email) where email is not null;
create index if not exists fm_contatos_tel on public.fm_contatos(tel_norm);
create index if not exists fm_contatos_tags_gin on public.fm_contatos using gin(tags);

create or replace function public.fm_contatos_normaliza() returns trigger language plpgsql set search_path = public as $$
begin
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.nome := nullif(btrim(coalesce(new.nome, '')), '');
  new.telefone := nullif(btrim(coalesce(new.telefone, '')), '');
  new.tel_norm := public.fm_tel_norm(new.telefone);
  new.tags := public.fm_norm_tags(new.tags);
  new.atualizado_em := now();
  return new;
end $$;
drop trigger if exists fm_contatos_normaliza on public.fm_contatos;
create trigger fm_contatos_normaliza before insert or update on public.fm_contatos for each row execute function public.fm_contatos_normaliza();

alter table public.fm_contatos enable row level security;
drop policy if exists fm_contatos_admin on public.fm_contatos;
create policy fm_contatos_admin on public.fm_contatos for all to authenticated using (public.fm_is_admin()) with check (public.fm_is_admin());

-- importa em lotes (até 1000 linhas por chamada); soma tags em quem já existe (mesmo e-mail ou telefone)
create or replace function public.fm_importar_contatos(p_linhas jsonb, p_tags text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l jsonb; v_email text; v_tel text; v_norm text; v_nome text; v_tags text[]; v_id uuid;
  novos int := 0; atualizados int := 0; ignorados int := 0;
begin
  if not public.fm_is_admin() then raise exception 'sem_permissao'; end if;
  if jsonb_array_length(p_linhas) > 1000 then raise exception 'lote_grande'; end if;
  for l in select * from jsonb_array_elements(p_linhas) loop
    v_email := nullif(lower(btrim(coalesce(l->>'email', ''))), '');
    if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_email := null; end if;
    v_tel := nullif(btrim(coalesce(l->>'telefone', '')), '');
    v_norm := public.fm_tel_norm(v_tel);
    v_nome := nullif(btrim(coalesce(l->>'nome', '')), '');
    v_tags := public.fm_norm_tags(coalesce(p_tags, '{}') || coalesce(array(select jsonb_array_elements_text(coalesce(l->'tags', '[]'::jsonb))), '{}'));
    if v_email is null and v_norm is null then ignorados := ignorados + 1; continue; end if;
    v_id := null;
    if v_email is not null then select id into v_id from public.fm_contatos where email = v_email; end if;
    if v_id is null and v_norm is not null then select id into v_id from public.fm_contatos where tel_norm = v_norm and (email is null or v_email is null) limit 1; end if;
    if v_id is null then
      insert into public.fm_contatos(email, nome, telefone, tags) values (v_email, v_nome, v_tel, v_tags);
      novos := novos + 1;
    else
      update public.fm_contatos set tags = public.fm_norm_tags(tags || v_tags),
        nome = coalesce(nome, v_nome), telefone = coalesce(telefone, v_tel), email = coalesce(email, v_email)
      where id = v_id;
      atualizados := atualizados + 1;
    end if;
  end loop;
  return jsonb_build_object('novos', novos, 'atualizados', atualizados, 'ignorados', ignorados);
end $$;

create or replace function public.fm_contatos_tags() returns table(tag text, total bigint)
language sql stable security definer set search_path = public as $$
  select t, count(*) from public.fm_contatos, unnest(tags) t where public.fm_is_admin() group by t order by 2 desc, 1;
$$;

create or replace function public.fm_contatos_tirar_tag(p_tag text) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.fm_is_admin() then raise exception 'sem_permissao'; end if;
  update public.fm_contatos set tags = array_remove(tags, lower(btrim(p_tag))) where lower(btrim(p_tag)) = any(tags);
  get diagnostics n = row_count; return n;
end $$;

-- pública: só responde sim/não, e só para as tags configuradas num bloco "tag" de um formulário publicado
create or replace function public.fm_tem_tag(p_slug text, p_bloco text, p_email text, p_tel text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare f public.fm_forms; b jsonb; v_tags text[]; v_email text; v_norm text; c public.fm_contatos;
begin
  select * into f from public.fm_forms where slug = lower(p_slug) and status = 'publicado';
  if not found then raise exception 'form_indisponivel'; end if;
  select x into b from jsonb_array_elements(f.perguntas) x where x->>'id' = p_bloco and x->>'tipo' = 'tag';
  if b is null then raise exception 'bloco_inexistente'; end if;
  v_tags := public.fm_norm_tags(array(select jsonb_array_elements_text(coalesce(b->'tags', '[]'::jsonb))));
  if coalesce(array_length(v_tags, 1), 0) = 0 then return false; end if;
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_norm := public.fm_tel_norm(p_tel);
  if v_email is not null then select * into c from public.fm_contatos where email = v_email; end if;
  if c.id is null and v_norm is not null then select * into c from public.fm_contatos where tel_norm = v_norm limit 1; end if;
  if c.id is null then return false; end if;
  if coalesce(b->>'modo', 'qualquer') = 'todas' then return c.tags @> v_tags; end if;
  return c.tags && v_tags;
end $$;
grant execute on function public.fm_tem_tag(text, text, text, text) to anon, authenticated;

-- =====================================================================
-- Valor editado pela pessoa substitui o do link (migração fm_params_editados)
-- O formulário manda respostas.__params {chave: valor editado}; o banco grava em params e tira de respostas.
-- =====================================================================
-- Valor editado pela pessoa substitui o que veio no link: respostas.__params {chave: valor}
-- só troca chaves que já estavam salvas em params (não deixa criar parâmetros novos)
create or replace function public.fm_mescla_params(p_atual jsonb, p_resp jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_resp->'__params') = 'object'
    then coalesce(p_atual, '{}'::jsonb) || coalesce((select jsonb_object_agg(k, left(v, 300)) from jsonb_each_text(p_resp->'__params') e(k, v) where coalesce(p_atual, '{}'::jsonb) ? k), '{}'::jsonb)
    else coalesce(p_atual, '{}'::jsonb) end;
$$;

create or replace function public.fm_progresso(p_token text, p_respostas jsonb, p_vistas text[], p_atual text)
 returns boolean language plpgsql security definer set search_path to 'public' as $function$
begin
  if pg_column_size(p_respostas) > 60000 or coalesce(array_length(p_vistas,1),0) > 300 then raise exception 'grande_demais'; end if;
  update public.fm_respostas r set
    params = public.fm_mescla_params(r.params, p_respostas),
    respostas = coalesce(p_respostas, '{}'::jsonb) - '__params',
    vistas = coalesce(p_vistas, '{}'),
    atual = left(p_atual, 40),
    status = case when r.status = 'concluida' then 'concluida'
                  when (coalesce(p_respostas,'{}'::jsonb) - '__params') <> '{}'::jsonb then 'parcial' else r.status end,
    atualizado_em = now()
  where r.token = p_token and r.status <> 'concluida'
    and exists (select 1 from public.fm_forms f where f.id = r.form_id and f.status = 'publicado');
  return found;
end $function$;

create or replace function public.fm_concluir(p_token text, p_respostas jsonb, p_vistas text[], p_final text)
 returns boolean language plpgsql security definer set search_path to 'public' as $function$
begin
  if pg_column_size(p_respostas) > 60000 or coalesce(array_length(p_vistas,1),0) > 300 then raise exception 'grande_demais'; end if;
  update public.fm_respostas r set
    params = public.fm_mescla_params(r.params, p_respostas),
    respostas = coalesce(p_respostas, '{}'::jsonb) - '__params',
    vistas = coalesce(p_vistas, '{}'),
    atual = null, final_id = left(p_final, 40),
    status = 'concluida', concluido_em = now(), atualizado_em = now()
  where r.token = p_token and r.status <> 'concluida'
    and exists (select 1 from public.fm_forms f where f.id = r.form_id and f.status = 'publicado');
  return found;
end $function$;
