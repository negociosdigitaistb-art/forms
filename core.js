// TB Forms — núcleo compartilhado (tipos, lógica condicional, variáveis)
(function () {
  const TIPOS = {
    curto:    { nome: "Texto curto",       ic: "Aa",  grupo: "Texto" },
    longo:    { nome: "Texto longo",       ic: "¶",   grupo: "Texto" },
    email:    { nome: "E-mail",            ic: "@",   grupo: "Contato" },
    telefone: { nome: "Telefone",          ic: "☎",   grupo: "Contato" },
    numero:   { nome: "Número",            ic: "#",   grupo: "Texto" },
    unica:    { nome: "Escolha única",     ic: "◉",   grupo: "Escolha", opcoes: true },
    multipla: { nome: "Múltipla escolha",  ic: "☑",   grupo: "Escolha", opcoes: true },
    lista:    { nome: "Lista suspensa",    ic: "▾",   grupo: "Escolha", opcoes: true },
    sim_nao:  { nome: "Sim ou não",        ic: "⇄",   grupo: "Escolha" },
    nps:      { nome: "NPS (0 a 10)",      ic: "N",   grupo: "Avaliação" },
    escala:   { nome: "Escala",            ic: "▤",   grupo: "Avaliação" },
    estrelas: { nome: "Estrelas",          ic: "★",   grupo: "Avaliação" },
    data:     { nome: "Data",              ic: "▦",   grupo: "Texto" },
    aviso:    { nome: "Texto / aviso",     ic: "i",   grupo: "Outros", semResposta: true },
    score:    { nome: "Lead Score (cálculo)", ic: "Σ", grupo: "Lógica", semResposta: true, interno: true },
    faixa:    { nome: "Condição por score",   ic: "⑂", grupo: "Lógica", semResposta: true, interno: true },
    active:   { nome: "ActiveCampaign",    ic: "AC",  grupo: "Integrações", semResposta: true, interno: true }
  };

  const OPS = {
    igual:          "é igual a",
    diferente:      "é diferente de",
    contem:         "contém",
    nao_contem:     "não contém",
    maior:          "é maior que",
    menor:          "é menor que",
    maior_igual:    "é maior ou igual a",
    menor_igual:    "é menor ou igual a",
    respondeu:      "foi respondida",
    nao_respondeu:  "não foi respondida"
  };

  function uid(p) {
    const a = "abcdefghijkmnopqrstuvwxyz23456789";
    let s = "";
    const r = (window.crypto && crypto.getRandomValues) ? crypto.getRandomValues(new Uint8Array(6)) : Array.from({ length: 6 }, () => Math.random() * 255);
    for (let i = 0; i < 6; i++) s += a[r[i] % a.length];
    return (p || "q") + "_" + s;
  }

  function vazio(v) {
    return v == null || v === "" || (Array.isArray(v) && v.length === 0);
  }

  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");

  function valorDe(ref, respostas) {
    if (ref && ref[0] === "$") return ((respostas && respostas.__vars) || {})[ref.slice(1)];
    return respostas[ref];
  }
  function avaliar(cond, respostas) {
    if (!cond || !cond.pergunta || !cond.op) return false;
    const v = valorDe(cond.pergunta, respostas);
    const alvo = cond.valor;
    switch (cond.op) {
      case "respondeu": return !vazio(v);
      case "nao_respondeu": return vazio(v);
    }
    if (vazio(v)) return cond.op === "diferente" || cond.op === "nao_contem";
    const lista = Array.isArray(v) ? v : [v];
    const num = (x) => { const n = Number(String(x).replace(",", ".")); return isNaN(n) ? null : n; };
    switch (cond.op) {
      case "igual": return lista.some((x) => norm(x) === norm(alvo));
      case "diferente": return !lista.some((x) => norm(x) === norm(alvo));
      case "contem": return lista.some((x) => norm(x).includes(norm(alvo)));
      case "nao_contem": return !lista.some((x) => norm(x).includes(norm(alvo)));
    }
    const a = num(lista[0]), b = num(alvo);
    if (a == null || b == null) return false;
    switch (cond.op) {
      case "maior": return a > b;
      case "menor": return a < b;
      case "maior_igual": return a >= b;
      case "menor_igual": return a <= b;
    }
    return false;
  }

  // Regra pode ter várias condições: { conds:[...], juncao:"e"|"ou", destino }
  // (aceita também o formato antigo { cond, destino })
  function regraBate(regra, respostas) {
    const conds = regra.conds || (regra.cond ? [regra.cond] : []);
    if (!conds.length) return false;
    return regra.juncao === "ou" ? conds.some((c) => avaliar(c, respostas)) : conds.every((c) => avaliar(c, respostas));
  }

  // Devolve { tipo:"pergunta", id } ou { tipo:"fim", id }
  function proximo(form, atualId, respostas) {
    const ps = form.perguntas || [];
    const finais = form.finais || [];
    const fimPadrao = { tipo: "fim", id: finais[0] ? finais[0].id : null };
    const resolver = (dest) => {
      if (!dest) return null;
      if (dest === "fim") return fimPadrao;
      if (dest.startsWith("fim:")) {
        const id = dest.slice(4);
        return { tipo: "fim", id: finais.some((f) => f.id === id) ? id : fimPadrao.id };
      }
      if (ps.some((p) => p.id === dest)) return { tipo: "pergunta", id: dest };
      return null;
    };
    if (atualId == null) return ps.length ? { tipo: "pergunta", id: ps[0].id } : fimPadrao;
    const i = ps.findIndex((p) => p.id === atualId);
    const p = ps[i];
    if (p && p.tipo === "faixa") {
      const fx = faixaDe(p, respostas);
      if (fx) { const d = resolver(fx.destino); if (d) return d; }
    }
    if (p) {
      for (const r of p.regras || []) {
        if (regraBate(r, respostas)) { const d = resolver(r.destino); if (d) return d; }
      }
      const d = resolver(p.depois);
      if (d) return d;
    }
    if (i >= 0 && i + 1 < ps.length) return { tipo: "pergunta", id: ps[i + 1].id };
    return fimPadrao;
  }

  // ---------- Lead Score ----------
  const num = (x) => { if (x == null || x === "") return null; const n = Number(String(x).replace(/\./g, (m, o, t) => /,\d+$/.test(t) ? "" : m).replace(",", ".")); return isNaN(n) ? null : n; };
  function nomeVar(b) { return (b && b.score_var ? String(b.score_var) : "score").replace(/[^\w]/g, "") || "score"; }
  // calcula e grava em respostas.__vars[nome]; devolve { total, linhas:[{regra, pontos}] }
  function calcularScore(bloco, respostas) {
    respostas.__vars = respostas.__vars || {};
    const nome = nomeVar(bloco);
    let total = bloco.zerar === false ? (num(respostas.__vars[nome]) || 0) : 0;
    const linhas = [];
    for (const r of bloco.pontuacao || []) {
      let pts = 0;
      if (r.tipo === "valor") {
        const v = num(Array.isArray(respostas[r.pergunta]) ? respostas[r.pergunta].length : respostas[r.pergunta]);
        if (v != null) pts = v * (num(r.fator) == null ? 1 : num(r.fator));
      } else if (regraBate(r, respostas)) pts = num(r.pontos) || 0;
      if (pts) linhas.push({ id: r.id, pontos: pts });
      total += pts;
    }
    total = Math.round(total * 100) / 100;
    respostas.__vars[nome] = total;
    return { total, linhas };
  }
  function faixaDe(bloco, respostas) {
    const v = num(((respostas && respostas.__vars) || {})[nomeVar(bloco)]) || 0;
    return (bloco.faixas || []).find((f) => (num(f.min) == null || v >= num(f.min)) && (num(f.max) == null || v <= num(f.max))) || null;
  }
  function rotuloFaixa(f) {
    const a = num(f.min), b = num(f.max);
    const fmt = (n) => String(n).replace(".", ",");
    if (a != null && b != null) return fmt(a) + " a " + fmt(b);
    if (a != null) return "≥ " + fmt(a);
    if (b != null) return "≤ " + fmt(b);
    return "qualquer valor";
  }
  // nomes das variáveis de score usadas no formulário
  function varsDoForm(form) {
    const s = new Set();
    (form.perguntas || []).forEach((p) => { if (p.tipo === "score") s.add(nomeVar(p)); });
    return [...s];
  }

  function textoResposta(v) {
    if (vazio(v)) return "";
    if (Array.isArray(v)) return v.join(", ");
    return String(v);
  }

  // Troca {{chave}} pela resposta (ou parâmetro da URL)
  function variaveis(txt, form, respostas, params, codificar) {
    if (!txt) return "";
    const porChave = {};
    (form.perguntas || []).forEach((p) => { if (p.chave) porChave[p.chave.toLowerCase()] = p.id; });
    return String(txt).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
      const kl = k.toLowerCase();
      let v = "";
      if (porChave[kl]) v = textoResposta(respostas[porChave[kl]]);
      const vs = (respostas && respostas.__vars) || {};
      if (!v && vs[k] != null) v = String(vs[k]).replace(".", ",");
      if (!v && params && params[k] != null) v = params[k];
      if (!v && params && params[kl] != null) v = params[kl];
      if (/^%[A-Z_]+%$|^\{\{.*\}\}$|^\[.*\]$/.test(String(v).trim())) v = ""; // tag de e-mail não trocada
      return codificar ? encodeURIComponent(v) : v;
    });
  }

  function chaveSugerida(titulo, usadas) {
    let base = norm(titulo).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").split("_").slice(0, 3).join("_") || "pergunta";
    if (/^\d/.test(base)) base = "p_" + base;
    let k = base, n = 2;
    while (usadas.has(k)) k = base + "_" + n++;
    return k;
  }

  function slugify(s) {
    return norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "form";
  }

  // ---------- pré-preenchimento pela URL ----------
  const PREENCHE = ["curto", "longo", "email", "telefone", "numero", "data"];
  const APELIDOS = {
    email: ["email", "e-mail", "mail"],
    telefone: ["telefone", "phone", "whatsapp", "celular", "tel", "fone"],
    nome: ["nome", "name", "first_name", "primeiro_nome"]
  };
  function pareceNome(p) {
    return p.tipo === "curto" && (/^(nome|primeiro_nome|seu_nome|name)(_|$)/.test(norm(p.chave)) || /\b(seu|teu) (primeiro )?nome\b/.test(norm(p.titulo)));
  }
  // nomes de parâmetro que preenchem esta pergunta, em ordem de prioridade
  function paramsDaPergunta(p) {
    if (!PREENCHE.includes(p.tipo)) return [];
    const l = [];
    if (p.param) l.push(p.param);
    if (p.chave) l.push(p.chave);
    if (p.tipo === "email") l.push(...APELIDOS.email);
    else if (p.tipo === "telefone") l.push(...APELIDOS.telefone);
    else if (pareceNome(p)) l.push(...APELIDOS.nome);
    return [...new Set(l.map((x) => x.toLowerCase()))];
  }
  // params: já decodificados (+ vira espaço); brutos: sem trocar + por espaço (para e-mail e telefone)
  function valorDaUrl(p, params, brutos) {
    const nomes = paramsDaPergunta(p);
    if (!nomes.length) return null;
    const fonte = p.tipo === "email" || p.tipo === "telefone" ? brutos : params;
    const lower = {};
    Object.keys(fonte || {}).forEach((k) => { lower[k.toLowerCase()] = fonte[k]; });
    for (const n of nomes) {
      let v = lower[n];
      if (v == null || !String(v).trim()) continue;
      v = String(v).trim().slice(0, 300);
      if (/^%[A-Z_]+%$|^\{\{.*\}\}$|^\[.*\]$/.test(v)) continue; // tag de e-mail que não foi trocada
      if (p.tipo === "email") v = v.replace(/\s/g, "").toLowerCase();
      if (p.tipo === "telefone") v = v.replace(/[^\d+()\s-]/g, "");
      if (p.tipo === "numero") { const n2 = Number(v.replace(",", ".")); if (isNaN(n2)) continue; v = n2; }
      if (p.tipo === "data" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v); if (!m) continue; v = m[3] + "-" + m[2] + "-" + m[1];
      }
      return v;
    }
    return null;
  }

  // pergunta que a pessoa responde (exclui texto/aviso e blocos de integração)
  const ehPergunta = (q) => !!q && q.tipo !== "aviso" && !(TIPOS[q.tipo] && TIPOS[q.tipo].interno);
  const ehInterno = (q) => !!q && !!(TIPOS[q.tipo] && TIPOS[q.tipo].interno);

  window.FM = { ehPergunta, ehInterno, calcularScore, faixaDe, rotuloFaixa, nomeVar, varsDoForm, valorDe, num, PREENCHE, paramsDaPergunta, valorDaUrl, TIPOS, OPS, uid, vazio, avaliar, regraBate, proximo, textoResposta, variaveis, chaveSugerida, slugify, norm };
})();
