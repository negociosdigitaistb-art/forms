// =====================================================================
//  TB Forms · fm-active (Supabase Edge Function)
//  Integração com o ActiveCampaign. A chave da API fica só no banco
//  (tabela fm_config) e só esta função lê.
//
//  Público (formulário):  { acao:"enviar", token, bloco }
//    → faz o create/update do contato pelo e-mail com os campos mapeados
//      no bloco, aplica tags e lista, e grava o resultado na resposta.
//  Painel (precisa estar logado no TB Forms):
//    status | salvar {url,key} | copiar_webnario | remover | campos | tags {busca} | listas
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Cfg = { url: string; api_key: string; conta?: string };

// só aceita endereços do próprio ActiveCampaign
function normUrl(u: string): string | null {
  let s = String(u || "").trim().replace(/\/+$/, "").replace(/\/api\/3$/i, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/^http:\/\//i, "https://");
  return /^https:\/\/[a-z0-9-]+\.(api-us\d+\.com|activehosted\.com)$/i.test(s) ? s.toLowerCase() : null;
}

async function ac(cfg: Cfg, metodo: string, caminho: string, corpo?: unknown) {
  const r = await fetch(cfg.url + "/api/3/" + caminho, {
    method: metodo,
    headers: { "Api-Token": cfg.api_key, "Content-Type": "application/json", Accept: "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const t = await r.text();
  let d: any = {};
  try { d = t ? JSON.parse(t) : {}; } catch (_) { /* resposta não-JSON */ }
  if (!r.ok) {
    const msg = d?.errors?.[0]?.title || d?.errors?.[0]?.detail || d?.message || t.slice(0, 160) || r.statusText;
    const e: any = new Error(r.status === 401 || r.status === 403 ? "Chave da API recusada pelo ActiveCampaign." : `ActiveCampaign ${r.status}: ${msg}`);
    e.status = r.status;
    throw e;
  }
  return d;
}

const CAMPOS_PADRAO = [
  { id: "firstName", titulo: "Primeiro nome", tipo: "text", padrao: true },
  { id: "lastName", titulo: "Sobrenome", tipo: "text", padrao: true },
  { id: "_nome_completo", titulo: "Nome completo (separa em nome e sobrenome)", tipo: "text", padrao: true },
  { id: "phone", titulo: "Telefone", tipo: "text", padrao: true },
];

function texto(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return String(v).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "Use POST." });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  let b: any = {};
  try { b = await req.json(); } catch (_) { return resp(400, { ok: false, erro: "Pedido inválido." }); }

  const lerCfg = async (): Promise<Cfg | null> => {
    const { data } = await db.from("fm_config").select("url,api_key,conta").eq("chave", "active").maybeSingle();
    return data && data.url && data.api_key ? (data as Cfg) : null;
  };

  // ------------------------------------------------------------------ público
  if (b.acao === "enviar") {
    const token = String(b.token || ""), bloco = String(b.bloco || "");
    if (token.length < 16 || !bloco) return resp(400, { ok: false, erro: "Pedido inválido." });
    const { data: r } = await db.from("fm_respostas").select("id,form_id,respostas,params,vistas,integracoes,iniciado_em").eq("token", token).maybeSingle();
    if (!r) return resp(404, { ok: false, erro: "Resposta não encontrada." });
    if (!(r.vistas || []).includes(bloco)) return resp(400, { ok: false, erro: "Etapa ainda não alcançada." });
    const { data: f } = await db.from("fm_forms").select("titulo,perguntas").eq("id", r.form_id).single();
    const blk = (f?.perguntas || []).find((p: any) => p.id === bloco && p.tipo === "active");
    if (!blk) return resp(404, { ok: false, erro: "Bloco não encontrado." });
    const integ = r.integracoes || {};
    const antes = integ[bloco] || {};
    const tentativas = (antes.tentativas || 0) + 1;
    if (tentativas > 6) return resp(429, { ok: false, erro: "Limite de envios para esta resposta." });

    const salvar = async (res: Record<string, unknown>) => {
      const { data: atual } = await db.from("fm_respostas").select("integracoes").eq("id", r.id).single();
      const novo = { ...(atual?.integracoes || {}), [bloco]: { ...res, tentativas, em: new Date().toISOString(), nome: blk.titulo || "ActiveCampaign" } };
      await db.from("fm_respostas").update({ integracoes: novo }).eq("id", r.id);
    };

    const cfg = await lerCfg();
    if (!cfg) { await salvar({ ok: false, erro: "ActiveCampaign não está configurado no TB Forms." }); return resp(200, { ok: false, erro: "não configurado" }); }

    const conf = blk.ac || {};
    const qs: any[] = f!.perguntas || [];
    const valor = (fonte: string): unknown => {
      if (!fonte) return "";
      if (fonte.startsWith("q:")) return (r.respostas || {})[fonte.slice(2)];
      if (fonte.startsWith("param:")) { const k = fonte.slice(6).toLowerCase(); const p = r.params || {}; const kk = Object.keys(p).find((x) => x.toLowerCase() === k); return kk ? p[kk] : ""; }
      if (fonte.startsWith("fixo:")) return fonte.slice(5);
      if (fonte.startsWith("var:")) { const v = ((r.respostas || {}).__vars || {})[fonte.slice(4)]; return v == null ? "" : String(v); }
      if (fonte === "meta:form") return f!.titulo || "";
      if (fonte === "meta:data") return String(r.iniciado_em || "").slice(0, 10);
      return "";
    };

    // e-mail: o escolhido no bloco, senão a primeira pergunta de e-mail, senão ?email= na URL
    let fonteEmail = conf.email || "";
    if (!fonteEmail) { const qe = qs.find((q) => q.tipo === "email"); fonteEmail = qe ? "q:" + qe.id : "param:email"; }
    const email = texto(valor(fonteEmail)).replace(/\s/g, "").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
      await salvar({ ok: false, erro: email ? "E-mail inválido: " + email : "Sem e-mail para identificar o contato." });
      return resp(200, { ok: false, erro: "sem e-mail" });
    }

    const contact: Record<string, unknown> = { email };
    const fieldValues: { field: string; value: string }[] = [];
    for (const m of conf.campos || []) {
      const bruto = valor(m.fonte);
      if (bruto == null || bruto === "" || (Array.isArray(bruto) && !bruto.length)) continue;
      if (m.ac === "_nome_completo") {
        const partes = texto(bruto).split(/\s+/).filter(Boolean);
        if (partes.length) { contact.firstName = partes[0]; if (partes.length > 1) contact.lastName = partes.slice(1).join(" "); }
      } else if (["firstName", "lastName", "phone"].includes(m.ac)) {
        contact[m.ac] = texto(bruto);
      } else if (m.ac) {
        const tipo = String(m.ac_tipo || "");
        const lista = Array.isArray(bruto) ? bruto.map(String) : [texto(bruto)];
        const v = ["checkbox", "listbox", "multiselect"].includes(tipo) ? "||" + lista.join("||") + "||" : lista.join(", ");
        fieldValues.push({ field: String(m.ac), value: v });
      }
    }
    if (fieldValues.length) contact.fieldValues = fieldValues;

    try {
      const sync = await ac(cfg, "POST", "contact/sync", { contact });
      const id = sync?.contact?.id;
      const avisos: string[] = [];
      for (const t of conf.tags || []) {
        try { await ac(cfg, "POST", "contactTags", { contactTag: { contact: id, tag: String(t.id) } }); }
        catch (e: any) { if (e.status !== 422) avisos.push("tag " + (t.nome || t.id) + ": " + e.message); }
      }
      if (conf.lista && conf.lista.id) {
        try { await ac(cfg, "POST", "contactLists", { contactList: { list: String(conf.lista.id), contact: id, status: 1 } }); }
        catch (e: any) { avisos.push("lista: " + e.message); }
      }
      await salvar({ ok: true, contato: id, email, campos: fieldValues.length + Object.keys(contact).length - 1, tags: (conf.tags || []).length, avisos });
      return resp(200, { ok: true });
    } catch (e: any) {
      await salvar({ ok: false, email, erro: e.message || String(e) });
      return resp(200, { ok: false, erro: e.message });
    }
  }

  // ------------------------------------------------------------------ painel
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: quem } = await db.auth.getUser(jwt);
  if (!quem?.user) return resp(401, { ok: false, erro: "Faça login de novo." });
  const { data: eu } = await db.from("fm_usuarios").select("user_id").eq("user_id", quem.user.id).maybeSingle();
  if (!eu) return resp(403, { ok: false, erro: "Sem acesso ao TB Forms." });

  try {
    if (b.acao === "status") {
      const { data } = await db.from("fm_config").select("url,api_key,conta,atualizado_em").eq("chave", "active").maybeSingle();
      const { data: wb } = await db.from("wb_integracoes").select("url,conta").eq("chave", "active").maybeSingle();
      if (!data || !data.api_key) return resp(200, { ok: true, configurado: false, webnario: wb ? { url: wb.url, conta: wb.conta } : null });
      return resp(200, { ok: true, configurado: true, url: data.url, conta: data.conta, chave_final: "••••" + String(data.api_key).slice(-4), atualizado_em: data.atualizado_em, webnario: wb ? { url: wb.url, conta: wb.conta } : null });
    }

    if (b.acao === "salvar" || b.acao === "copiar_webnario") {
      let url: string | null, key: string;
      if (b.acao === "copiar_webnario") {
        const { data: wb } = await db.from("wb_integracoes").select("url,api_key").eq("chave", "active").maybeSingle();
        if (!wb) return resp(404, { ok: false, erro: "O Webnario não tem ActiveCampaign configurado." });
        url = normUrl(wb.url); key = String(wb.api_key || "");
      } else { url = normUrl(b.url); key = String(b.key || "").trim(); }
      if (!url) return resp(400, { ok: false, erro: "Endereço inválido. Use o da sua conta, ex.: https://suaconta.api-us1.com" });
      if (key.length < 20) return resp(400, { ok: false, erro: "Cole a chave da API completa." });
      const me = await ac({ url, api_key: key }, "GET", "users/me");
      const conta = me?.user?.email || me?.user?.username || url.replace(/^https:\/\//, "");
      const { error } = await db.from("fm_config").upsert({ chave: "active", url, api_key: key, conta, atualizado_em: new Date().toISOString() });
      if (error) throw new Error(error.message);
      return resp(200, { ok: true, conta, url });
    }

    if (b.acao === "remover") {
      await db.from("fm_config").delete().eq("chave", "active");
      return resp(200, { ok: true });
    }

    const cfg = await lerCfg();
    if (!cfg) return resp(400, { ok: false, erro: "Conecte o ActiveCampaign em Configurações primeiro." });

    if (b.acao === "campos") {
      const campos: any[] = [];
      for (let off = 0; off < 1000; off += 100) {
        const d = await ac(cfg, "GET", `fields?limit=100&offset=${off}`);
        for (const x of d.fields || []) campos.push({ id: String(x.id), titulo: x.title, tipo: x.type, perstag: x.perstag });
        if ((d.fields || []).length < 100) break;
      }
      campos.sort((a, b2) => String(a.titulo).localeCompare(String(b2.titulo), "pt-BR"));
      return resp(200, { ok: true, padrao: CAMPOS_PADRAO, campos });
    }

    if (b.acao === "tags") {
      const busca = encodeURIComponent(String(b.busca || "").slice(0, 60));
      const d = await ac(cfg, "GET", `tags?limit=50${busca ? "&search=" + busca : ""}`);
      return resp(200, { ok: true, tags: (d.tags || []).map((t: any) => ({ id: String(t.id), nome: t.tag })) });
    }

    if (b.acao === "listas") {
      const listas: any[] = [];
      for (let off = 0; off < 500; off += 100) {
        const d = await ac(cfg, "GET", `lists?limit=100&offset=${off}`);
        for (const l of d.lists || []) listas.push({ id: String(l.id), nome: l.name });
        if ((d.lists || []).length < 100) break;
      }
      return resp(200, { ok: true, listas });
    }

    return resp(400, { ok: false, erro: "Ação desconhecida." });
  } catch (e: any) {
    return resp(e.status && e.status < 500 ? 400 : 500, { ok: false, erro: e.message || String(e) });
  }
});
