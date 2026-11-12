// =====================================================================
//  TB Forms · fm-usuarios (Supabase Edge Function)
//  Só quem já tem acesso ao TB Forms consegue chamar.
//  Ações: criar (nome, e-mail, senha), senha (troca a senha de alguém),
//  remover (tira o acesso ao TB Forms; o login continua existindo porque
//  é o mesmo do Disparador/Webnario).
//  A chave de serviço fica só aqui dentro do Supabase.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return resp(405, { ok: false, erro: "Use POST." });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // quem chama precisa ter acesso ao TB Forms
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: quem } = await admin.auth.getUser(jwt);
  if (!quem?.user) return resp(401, { ok: false, erro: "Faça login de novo." });
  const { data: eu } = await admin.from("fm_usuarios").select("user_id").eq("user_id", quem.user.id).maybeSingle();
  if (!eu) return resp(403, { ok: false, erro: "Você não tem acesso para cadastrar usuários." });

  let b: any = {};
  try { b = await req.json(); } catch (_) { return resp(400, { ok: false, erro: "Pedido inválido." }); }

  try {
    if (b.acao === "criar") {
      const nome = String(b.nome ?? "").trim().slice(0, 80);
      const email = String(b.email ?? "").trim().toLowerCase();
      const senha = String(b.senha ?? "");
      if (!nome) return resp(400, { ok: false, erro: "Informe o nome." });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resp(400, { ok: false, erro: "E-mail inválido." });
      if (senha.length < 8) return resp(400, { ok: false, erro: "A senha precisa ter pelo menos 8 caracteres." });

      let id: string | null = null, jaExistia = false;
      const { data: novo, error } = await admin.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome } });
      if (error) {
        if (!/already|registered|exists/i.test(error.message)) throw new Error(error.message);
        // já tem login (ex.: usa o Disparador): só libera o acesso, sem mexer na senha dele
        const { data: achado } = await admin.rpc("fm_id_por_email", { p_email: email });
        if (!achado) throw new Error("Esse e-mail já tem login, mas não consegui localizar.");
        id = achado as string; jaExistia = true;
      } else id = novo.user!.id;

      const { data: tem } = await admin.from("fm_usuarios").select("user_id").eq("user_id", id).maybeSingle();
      if (tem) return resp(409, { ok: false, erro: "Esse usuário já tem acesso ao TB Forms." });
      const { error: e2 } = await admin.from("fm_usuarios").insert({ user_id: id, nome, email, criado_por: quem.user.id });
      if (e2) throw new Error(e2.message);
      return resp(200, { ok: true, id, ja_existia: jaExistia });
    }

    if (b.acao === "senha") {
      const senha = String(b.senha ?? "");
      if (!b.usuario_id) return resp(400, { ok: false, erro: "Usuário não informado." });
      if (senha.length < 8) return resp(400, { ok: false, erro: "A senha precisa ter pelo menos 8 caracteres." });
      const { data: alvo } = await admin.from("fm_usuarios").select("user_id").eq("user_id", b.usuario_id).maybeSingle();
      if (!alvo) return resp(404, { ok: false, erro: "Usuário não encontrado no TB Forms." });
      const { error } = await admin.auth.admin.updateUserById(b.usuario_id, { password: senha });
      if (error) throw new Error(error.message);
      return resp(200, { ok: true });
    }

    if (b.acao === "remover") {
      if (!b.usuario_id) return resp(400, { ok: false, erro: "Usuário não informado." });
      if (b.usuario_id === quem.user.id) return resp(400, { ok: false, erro: "Você não pode remover o próprio acesso." });
      const { error } = await admin.from("fm_usuarios").delete().eq("user_id", b.usuario_id);
      if (error) throw new Error(error.message);
      return resp(200, { ok: true });
    }

    return resp(400, { ok: false, erro: "Ação desconhecida." });
  } catch (e) {
    return resp(500, { ok: false, erro: e instanceof Error ? e.message : String(e) });
  }
});
