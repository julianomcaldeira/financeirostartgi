// Painel Financeiro StartGi — backend que consulta o Omie e calcula os indicadores
const express = require('express');
const path = require('path');

const { OMIE_APP_KEY, OMIE_APP_SECRET, PAINEL_SENHA } = process.env;
const PORT = process.env.PORT || 3000;
const CACHE_MIN = Number(process.env.CACHE_MINUTOS || 15);

// Command Code Provider API (compatível com Anthropic Messages)
const AI_KEY = process.env.COMMAND_IA || process.env.COMMANDCODE_API_KEY || process.env.CMD_API_KEY || process.env.ANTHROPIC_API_KEY;
const AI_BASE = (process.env.COMMANDCODE_BASE_URL || 'https://api.commandcode.ai/provider/v1').replace(/\/$/, '');
const AI_MODEL = process.env.GURU_MODELO || 'claude-sonnet-5-5';

const app = express();
app.use(express.json());

// Proteção simples por senha (os dados são sensíveis)
app.use((req, res, next) => {
  if (!PAINEL_SENHA) return next();
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const senha = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  if (senha === PAINEL_SENHA) return next();
  res.set('WWW-Authenticate', 'Basic realm="Painel StartGi"').status(401).send('Acesso restrito');
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const fs = require('fs');
  const a = path.join(__dirname, 'public', 'index.html'), b = path.join(__dirname, 'index.html');
  res.sendFile(fs.existsSync(a) ? a : b);
});

// ---------- Omie ----------
async function omie(endpoint, call, param) {
  const r = await fetch(`https://app.omie.com.br/api/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call, app_key: OMIE_APP_KEY, app_secret: OMIE_APP_SECRET, param: [param] }),
  });
  const j = await r.json();
  if (j.faultstring) {
    // Omie devolve erro quando a lista está vazia — tratamos como vazio
    if (/não existem registros|nao existem registros/i.test(j.faultstring)) return null;
    throw new Error(`Omie ${call}: ${j.faultstring}`);
  }
  return j;
}

async function listarTudo(endpoint, call, chave, extra = {}) {
  let pagina = 1, total = 1, itens = [];
  do {
    const j = await omie(endpoint, call, { pagina, registros_por_pagina: 500, apenas_importado_api: 'N', ...extra });
    if (!j) break;
    itens = itens.concat(j[chave] || []);
    total = j.total_de_paginas || 1;
    pagina++;
    await new Promise(r => setTimeout(r, 350)); // respeita o limite de chamadas do Omie
  } while (pagina <= total);
  return itens;
}

const dt = s => { if (!s) return null; const [d, m, a] = s.split('/'); return new Date(+a, +m - 1, +d); };
const mesKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const soma = arr => arr.reduce((s, x) => s + x, 0);

// ---------- Cálculo dos indicadores ----------
async function montarDados() {
  const [receber, pagar, clientes, categorias, contas] = await Promise.all([
    listarTudo('financas/contareceber/', 'ListarContasReceber', 'conta_receber_cadastro'),
    listarTudo('financas/contapagar/', 'ListarContasPagar', 'conta_pagar_cadastro'),
    listarTudo('geral/clientes/', 'ListarClientesResumido', 'clientes_cadastro_resumido'),
    listarTudo('geral/categorias/', 'ListarCategorias', 'categoria_cadastro'),
    listarTudo('geral/contacorrente/', 'ListarResumoContasCorrentes', 'conta_corrente_lista').catch(() => []),
  ]);

  const nomeCli = Object.fromEntries(clientes.map(c => [c.codigo_cliente, c.nome_fantasia || c.razao_social]));
  const nomeCat = Object.fromEntries(categorias.map(c => [c.codigo, c.descricao]));
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

  const norm = (t, tipo) => ({
    tipo,
    valor: Number(t.valor_documento || 0),
    venc: dt(t.data_vencimento),
    status: (t.status_titulo || '').toUpperCase(),
    categoria: nomeCat[t.codigo_categoria] || t.codigo_categoria || 'Sem categoria',
    parceiro: nomeCli[t.codigo_cliente_fornecedor] || 'Não identificado',
  });
  const R = receber.map(t => norm(t, 'R')).filter(t => t.status !== 'CANCELADO' && t.venc);
  const P = pagar.map(t => norm(t, 'P')).filter(t => t.status !== 'CANCELADO' && t.venc);
  const quitado = t => t.status === 'RECEBIDO' || t.status === 'PAGO' || t.status === 'LIQUIDADO';
  const aberto = t => !quitado(t);

  // Últimos 12 meses (por vencimento dos títulos quitados)
  const meses = [];
  for (let i = 11; i >= 0; i--) meses.push(mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)));
  const porMes = (lista) => meses.map(m => soma(lista.filter(t => quitado(t) && mesKey(t.venc) === m).map(t => t.valor)));
  const entradas = porMes(R), saidas = porMes(P);
  const resultado = entradas.map((e, i) => e - saidas[i]);

  // Médias dos últimos 3 meses fechados
  const ult3 = a => soma(a.slice(-4, -1)) / 3;
  const receitaMedia = ult3(entradas), despesaMedia = ult3(saidas);

  // Em aberto
  const atrasadoR = R.filter(t => aberto(t) && t.venc < hoje);
  const atrasadoP = P.filter(t => aberto(t) && t.venc < hoje);
  const janela = (lista, dias) => soma(lista.filter(t => aberto(t) && t.venc >= hoje && t.venc <= new Date(hoje.getTime() + dias * 864e5)).map(t => t.valor));

  // Saldo bancário (se o Omie devolver)
  const saldo = soma(contas.map(c => Number(c.saldo_atual ?? c.nSaldo ?? 0)));
  const saldoDisponivel = contas.length > 0;

  // Fluxo projetado próximas 12 semanas
  const semanas = [];
  let acumulado = saldo;
  for (let w = 0; w < 12; w++) {
    const ini = new Date(hoje.getTime() + w * 7 * 864e5), fim = new Date(ini.getTime() + 7 * 864e5);
    const ent = soma(R.filter(t => aberto(t) && t.venc >= ini && t.venc < fim).map(t => t.valor));
    const sai = soma(P.filter(t => aberto(t) && t.venc >= ini && t.venc < fim).map(t => t.valor));
    acumulado += ent - sai;
    semanas.push({ semana: ini.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), entradas: ent, saidas: sai, saldo: acumulado });
  }

  // Concentração de clientes (últimos 12 meses)
  const ini12 = new Date(hoje.getFullYear(), hoje.getMonth() - 11, 1);
  const agrupa = (lista, campo) => {
    const m = {};
    lista.filter(t => quitado(t) && t.venc >= ini12).forEach(t => { m[t[campo]] = (m[t[campo]] || 0) + t.valor; });
    return Object.entries(m).map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  };
  const clientesRank = agrupa(R, 'parceiro');
  const despesasCat = agrupa(P, 'categoria');
  const receita12 = soma(entradas);
  const top1 = clientesRank[0] ? clientesRank[0].valor / receita12 : 0;
  const top3 = soma(clientesRank.slice(0, 3).map(c => c.valor)) / (receita12 || 1);

  const burn = despesaMedia - receitaMedia; // positivo = queimando caixa
  const runway = saldoDisponivel && burn > 0 ? saldo / burn : null;
  const margem = receitaMedia ? (receitaMedia - despesaMedia) / receitaMedia : 0;

  // ---------- Guru: diagnósticos automáticos ----------
  const brl = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const alertas = [];
  if (margem < 0) alertas.push({ nivel: 'alto', titulo: 'Gastando mais do que entra', texto: `Nos últimos 3 meses a StartGi gastou em média ${brl(despesaMedia)} e recebeu ${brl(receitaMedia)} por mês. Cada mês consome ${brl(burn)} do caixa.` });
  else alertas.push({ nivel: 'ok', titulo: 'Operação se pagando', texto: `Média dos últimos 3 meses: entra ${brl(receitaMedia)}, sai ${brl(despesaMedia)}. Sobra ${(margem * 100).toFixed(0)}% de cada real recebido.` });
  if (runway !== null) alertas.push({ nivel: runway < 6 ? 'alto' : runway < 12 ? 'medio' : 'ok', titulo: `Fôlego de caixa: ${runway.toFixed(1)} meses`, texto: `Se nada mudar, o saldo atual dura cerca de ${runway.toFixed(1)} meses. Abaixo de 6 meses é zona de atenção para uma empresa investida.` });
  if (top1 > 0.3) alertas.push({ nivel: top1 > 0.5 ? 'alto' : 'medio', titulo: 'Dependência de um cliente', texto: `${clientesRank[0].nome} representa ${(top1 * 100).toFixed(0)}% da receita dos últimos 12 meses. Se esse cliente atrasar ou sair, o impacto é direto no caixa.` });
  const totAtrasoR = soma(atrasadoR.map(t => t.valor));
  if (totAtrasoR > 0) alertas.push({ nivel: totAtrasoR > receitaMedia * 0.5 ? 'alto' : 'medio', titulo: `${brl(totAtrasoR)} para receber em atraso`, texto: `São ${atrasadoR.length} títulos vencidos. Cobrar isso é o dinheiro mais barato que a empresa pode conseguir.` });
  const piorSemana = semanas.reduce((a, b) => (b.saldo < a.saldo ? b : a), semanas[0]);
  if (saldoDisponivel && piorSemana && piorSemana.saldo < 0) alertas.push({ nivel: 'alto', titulo: 'Caixa negativo à vista', texto: `Pelas contas lançadas no Omie, o saldo fica negativo na semana de ${piorSemana.semana}. Antecipe recebimentos ou renegocie pagamentos.` });

  return {
    atualizadoEm: new Date().toISOString(),
    saldo, saldoDisponivel,
    kpis: {
      receitaMedia, despesaMedia, resultadoMedio: receitaMedia - despesaMedia, margem, burn, runway,
      receber30: janela(R, 30), pagar30: janela(P, 30),
      atrasadoReceber: totAtrasoR, atrasadoPagar: soma(atrasadoP.map(t => t.valor)),
      top1, top3, receita12,
    },
    meses, entradas, saidas, resultado, semanas,
    clientes: clientesRank.slice(0, 8),
    despesas: despesasCat.slice(0, 8),
    atrasados: atrasadoR.sort((a, b) => b.valor - a.valor).slice(0, 10).map(t => ({ cliente: t.parceiro, valor: t.valor, venc: t.venc.toLocaleDateString('pt-BR'), dias: Math.round((hoje - t.venc) / 864e5) })),
    alertas,
  };
}

let cache = { at: 0, data: null };
async function dados(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MIN * 60e3) return cache.data;
  cache = { at: Date.now(), data: await montarDados() };
  return cache.data;
}

app.get('/api/dados', async (req, res) => {
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) return res.status(500).json({ erro: 'Configure OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.' });
  try { res.json(await dados(req.query.atualizar === '1')); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- Guru (chat) ----------
app.post('/api/guru', async (req, res) => {
  if (!AI_KEY) return res.json({ resposta: 'O chat do guru precisa da variável COMMANDCODE_API_KEY configurada no servidor.' });
  try {
    const d = await dados();
    const contexto = JSON.stringify({ saldo: d.saldo, saldoDisponivel: d.saldoDisponivel, kpis: d.kpis, meses: d.meses, entradas: d.entradas, saidas: d.saidas, fluxo12semanas: d.semanas, clientes: d.clientes, despesas: d.despesas, atrasados: d.atrasados });
    const r = await fetch(`${AI_BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1200,
        system: `Você é o CFO as a Service da StartGi Tecnologia (GovTech/B2B, ~25 pessoas, investida pelo FIP GovTech). Seu cliente é o CEO, Juliano, que não é especialista em finanças. Aja como um CFO experiente e franco: dê o diagnóstico, diga o que importa, recomende decisões concretas com números, aponte riscos sem suavizar e explique qualquer termo técnico em uma frase. Responda em português, objetivo, em prosa curta (sem listas com hífen). Use apenas os dados abaixo, vindos do Omie; se faltar dado para decidir, diga qual e como obtê-lo. Feche com a recomendação: o que fazer esta semana.\n\nDADOS: ${contexto}`,
        messages: (req.body.historico || []).slice(-10),
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ resposta: `Erro do provedor de IA (${r.status}): ${j.error?.message || j.message || 'falha na chamada'}` });
    const texto = j.content?.map?.(b => b.text).filter(Boolean).join('\n') || j.choices?.[0]?.message?.content || j.output_text;
    res.json({ resposta: texto || `Sem resposta: ${JSON.stringify(j).slice(0, 800)}` });
  } catch (e) { res.status(500).json({ resposta: 'Erro: ' + e.message }); }
});

// TEMPORÁRIO: diagnóstico da integração de IA
app.post('/api/ai-test', async (req, res) => {
  try {
    const { model = AI_MODEL, max_tokens = 1200, thinking, prompt = 'Diga em uma frase se está funcionando.' } = req.body || {};
    const body = { model, max_tokens, messages: [{ role: 'user', content: prompt }] };
    if (thinking) body.thinking = thinking;
    const r = await fetch(`${AI_BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    res.json({ status: r.status, raw });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => console.log(`Painel financeiro StartGi na porta ${PORT}`));
