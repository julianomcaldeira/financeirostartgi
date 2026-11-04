// Orçamento montado pela IA a partir dos números do Omie.
// Versões ficam no Supabase (tabela orcamento_versoes); o servidor calcula os totais.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TABELA = 'orcamento_versoes';

// ---------- Supabase (REST) ----------
function supabaseConfigurado() { return Boolean(SUPABASE_URL && SUPABASE_KEY); }

async function sb(caminho, opcoes = {}) {
  if (!supabaseConfigurado()) throw new Error('Supabase não configurado (SUPABASE_URL e SUPABASE_KEY).');
  const headers = { apikey: SUPABASE_KEY, 'content-type': 'application/json', ...(opcoes.headers || {}) };
  // Chaves antigas (JWT) também precisam ir no Authorization; as novas (sb_secret_) não.
  if (!SUPABASE_KEY.startsWith('sb_')) headers.authorization = `Bearer ${SUPABASE_KEY}`;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, { ...opcoes, headers });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${j?.message || j?.hint || txt.slice(0, 160)}`);
  return j;
}

async function salvarVersao(ano, dados, mensagem) {
  const [row] = await sb(TABELA, {
    method: 'POST',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify([{ ano: Number(ano), dados, mensagem: String(mensagem || '').slice(0, 500) }]),
  });
  return row;
}
async function versaoAtual(ano) {
  const filtro = ano ? `ano=eq.${Number(ano)}&` : '';
  const rows = await sb(`${TABELA}?${filtro}select=*&order=id.desc&limit=1`);
  return rows[0] || null;
}
async function listarVersoes(ano) {
  return sb(`${TABELA}?ano=eq.${Number(ano)}&select=id,ano,mensagem,criado_em&order=id.desc&limit=60`);
}
async function obterVersao(id) {
  const rows = await sb(`${TABELA}?id=eq.${Number(id)}&select=*`);
  return rows[0] || null;
}
async function statusSupabase() {
  if (!supabaseConfigurado()) return { configurado: false, conectado: false, erro: 'Variáveis SUPABASE_URL e SUPABASE_KEY ausentes.' };
  try {
    const rows = await sb(`${TABELA}?select=id&limit=1`);
    return { configurado: true, conectado: true, tabela: true, temVersoes: rows.length > 0 };
  } catch (e) {
    return { configurado: true, conectado: false, erro: e.message };
  }
}

// ---------- Base do Omie para a IA ----------
const FINANCEIRO = /receita financeira|rendimento|juros|tarifa|aplica[cç][aã]o|resgate|transfer[eê]ncia|aporte|empr[eé]stimo/i;
const arred = v => Math.round(Number(v) || 0);

function mesesAnteriores(n) {
  const out = [], d = new Date();
  d.setDate(1);
  for (let i = n; i >= 1; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function baseOmie(d) {
  const meses = mesesAnteriores(12); // 12 meses fechados
  const idx = Object.fromEntries(meses.map((m, i) => [m, i]));
  const validos = (d.lancamentos || []).filter(l => !/cancel/i.test(String(l.status || '')));
  const porGrupo = (tipo, chave, filtroFin) => {
    const mapa = {};
    for (const l of validos) {
      if (l.tipo !== tipo) continue;
      if (filtroFin && FINANCEIRO.test(String(l.categoria || ''))) continue;
      const mes = String(l.competencia || l.vencimento || '').slice(0, 7);
      if (!(mes in idx)) continue;
      const k = l[chave] || '(sem ' + chave + ')';
      (mapa[k] ||= Array(12).fill(0))[idx[mes]] += Number(l.valor || 0);
    }
    return Object.entries(mapa).map(([nome, v]) => {
      const media = n => arred(v.slice(-n).reduce((a, x) => a + x, 0) / n);
      return { nome, porMes: v.map(arred), total12: arred(v.reduce((a, x) => a + x, 0)), media3: media(3), media6: media(6) };
    }).sort((a, b) => b.total12 - a.total12);
  };
  const despesasCategoria = porGrupo('despesa', 'categoria', true);
  const receitasCategoria = porGrupo('receita', 'categoria', true);
  const receitasCliente = porGrupo('receita', 'parceiro', true).slice(0, 30);
  const despesasFinanceiras = porGrupo('despesa', 'categoria', false).filter(c => FINANCEIRO.test(c.nome));
  const receitasFinanceiras = porGrupo('receita', 'categoria', false).filter(c => FINANCEIRO.test(c.nome));
  const r = d.recorrente || {}, ct = d.contratos || {};
  // Ano corrente mês a mês (meses futuros = o que já está lançado a receber/pagar)
  const anoAtual = new Date().getFullYear(), mesAtual = new Date().toISOString().slice(0, 7);
  const anoCorrente = Array.from({ length: 12 }, (_, i) => {
    const mes = `${anoAtual}-${String(i + 1).padStart(2, '0')}`;
    const soma = tipo => arred(validos.filter(l => l.tipo === tipo && !FINANCEIRO.test(String(l.categoria || '')) && String(l.competencia || l.vencimento || '').slice(0, 7) === mes).reduce((a, l) => a + Number(l.valor || 0), 0));
    return { mes, situacao: mes < mesAtual ? 'fechado' : mes === mesAtual ? 'parcial' : 'previsto no Omie', receita: soma('receita'), despesa: soma('despesa') };
  });
  return {
    anoCorrente: { ano: anoAtual, meses: anoCorrente, receitaLancada: anoCorrente.reduce((a, m) => a + m.receita, 0), observacao: 'Meses parciais e futuros podem estar incompletos; projete o fechamento do ano antes de aplicar crescimento sobre ele.' },
    mesesBase: meses,
    observacao: 'Valores por competência (ou vencimento quando não há competência), meses fechados. Receitas e despesas financeiras separadas.',
    caixa: { total: arred(d.saldo), disponivel: arred(d.saldoDisponivel), aplicado: arred(d.caixaAplicado) },
    contratos: { ativos: ct.ativos, mrrContratado: arred(ct.mrr) },
    recorrente: { mensalMedia: arred(r.mensalMedia), ultimoMes: arred(r.ultimoMes), participacao: r.participacao },
    receitasCategoria, receitasCliente, despesasCategoria, receitasFinanceiras, despesasFinanceiras,
    aReceber30: arred(d.kpis?.receber30), aPagar30: arred(d.kpis?.pagar30),
  };
}

// ---------- Estrutura e totais ----------
const AREAS_OPEX = ['Diretoria', 'Administrativo', 'Tecnologia', 'Operação / CS', 'Comercial'];
const AREAS = ['Receita', 'Impostos', 'Infraestrutura', ...AREAS_OPEX, 'Financeiro'];

function mesesDoAno(ano) { return Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`); }
const doze = v => Array.from({ length: 12 }, (_, i) => arred(Array.isArray(v) ? v[i] : 0));
const somaV = (linhas) => doze(null).map((_, i) => linhas.reduce((a, l) => a + l.valores[i], 0));
const linhaTotal = (area, nome, tipo, valores, extra = {}) => ({ area, nome, tipo, percentual: false, valores, total: valores.reduce((a, x) => a + x, 0), ...extra });

// Normaliza o que a IA devolveu: só linhas de detalhe, com sinais corretos.
function normalizarPlano(plano) {
  const linhas = (plano.linhas || []).map(l => {
    let area = AREAS.find(a => a.toLowerCase() === String(l.area || '').trim().toLowerCase()) || String(l.area || 'Administrativo').trim();
    let valores = doze(l.valores);
    if (area !== 'Receita' && area !== 'Financeiro') valores = valores.map(v => -Math.abs(v));
    if (area === 'Receita') valores = valores.map(v => Math.abs(v));
    return { area, nome: String(l.nome || 'Sem nome').trim(), valores, recorrente: Boolean(l.recorrente), base: String(l.base || '').slice(0, 300) };
  });
  return {
    cenario: String(plano.cenario || 'Plano base').slice(0, 80),
    caixaInicial: arred(plano.caixaInicial),
    headcount: doze(plano.headcount),
    premissas: (plano.premissas || []).map(p => ({ nome: String(p.nome || ''), valor: String(p.valor ?? '') })).filter(p => p.nome),
    pessoas: Array.isArray(plano.pessoas) ? plano.pessoas.slice(0, 200) : [],
    linhas,
  };
}

// Gera a estrutura completa que a tela usa (linhas de total + resumo mensal).
function calcular(plano, ano) {
  const meses = mesesDoAno(ano);
  const det = plano.linhas.map(l => ({ ...l, tipo: 'linha', percentual: false, total: l.valores.reduce((a, x) => a + x, 0) }));
  const da = area => det.filter(l => l.area === area);
  const extras = [...new Set(det.map(l => l.area))].filter(a => !AREAS.includes(a));
  const opex = [...AREAS_OPEX, ...extras];
  const out = [];

  const rec = da('Receita'); out.push(...rec);
  const rb = somaV(rec); out.push(linhaTotal('Receita', 'RECEITA BRUTA', 'receitaBruta', rb));
  const imp = da('Impostos'); out.push(...imp);
  const rl = rb.map((v, i) => v + somaV(imp)[i]); out.push(linhaTotal('Receita', 'RECEITA LÍQUIDA', 'receitaLiquida', rl));
  const inf = da('Infraestrutura'); out.push(...inf);
  const lb = rl.map((v, i) => v + somaV(inf)[i]); out.push(linhaTotal('Resultado', 'LUCRO BRUTO', 'lucroBruto', lb));
  const totaisOpex = [];
  for (const area of opex) {
    const ls = da(area);
    if (!ls.length) continue;
    out.push(...ls);
    const t = somaV(ls); totaisOpex.push(t);
    out.push(linhaTotal(area, 'TOTAL ' + area.toUpperCase(), 'totalArea', t));
  }
  const dop = doze(null).map((_, i) => totaisOpex.reduce((a, t) => a + t[i], 0));
  out.push(linhaTotal('Resultado', 'TOTAL DESPESAS OPERACIONAIS', 'despesasOperacionais', dop));
  const eb = lb.map((v, i) => v + dop[i]); out.push(linhaTotal('Resultado', 'EBITDA', 'ebitda', eb));
  const mg = eb.map((v, i) => rb[i] ? Math.round((v / rb[i]) * 1000) / 10 : 0);
  const mgTotal = rb.reduce((a, x) => a + x, 0);
  out.push({ area: 'Resultado', nome: 'Margem EBITDA', tipo: 'margemEbitda', percentual: true, valores: mg, total: mgTotal ? Math.round(eb.reduce((a, x) => a + x, 0) / mgTotal * 1000) / 10 : 0 });
  const fin = da('Financeiro'); out.push(...fin);
  const rf = somaV(fin); out.push(linhaTotal('Financeiro', 'Resultado financeiro', 'resultadoFinanceiro', rf));
  const rm = eb.map((v, i) => v + rf[i]); out.push(linhaTotal('Resultado', 'RESULTADO DO MÊS', 'resultadoMes', rm));
  let saldo = plano.caixaInicial;
  const cx = rm.map(v => (saldo += v)); out.push({ ...linhaTotal('Caixa', 'Caixa final (estimado)', 'caixaFinal', cx), total: cx[11] });
  const mrr = somaV(rec.filter(l => l.recorrente)); out.push({ ...linhaTotal('Indicador', 'MRR total', 'mrrTotal', mrr), total: mrr[11] });
  out.push({ ...linhaTotal('Indicador', 'Headcount', 'headcount', plano.headcount), total: plano.headcount[11] });

  const resumo = meses.map((mes, i) => ({
    mes, receita: rb[i], receitaLiquida: rl[i], custos: Math.max(0, rl[i] - lb[i]),
    despesasOperacionais: Math.abs(dop[i]), despesa: rb[i] - eb[i], ebitda: eb[i],
    margemEbitda: rb[i] ? eb[i] / rb[i] : 0, resultadoFinanceiro: rf[i], resultadoMes: rm[i],
    caixaFinal: cx[i], mrrTotal: mrr[i], headcount: plano.headcount[i],
  }));
  return { ano: Number(ano), meses, linhas: out, resumo, premissas: plano.premissas, pessoas: plano.pessoas, cenario: plano.cenario, realizadoLinhas: [], realizadoDisponivel: false };
}

// Diferenças por linha para mostrar no chat o que a IA mudou.
function diferencas(antes, depois) {
  const chave = l => `${l.area}||${l.nome}`.toLowerCase();
  const a = new Map((antes?.linhas || []).map(l => [chave(l), l]));
  const b = new Map((depois?.linhas || []).map(l => [chave(l), l]));
  const tot = l => (l ? l.valores.reduce((s, x) => s + x, 0) : 0);
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k), y = b.get(k);
    const mudou = !x || !y || x.valores.some((v, i) => v !== y.valores[i]);
    if (mudou) out.push({ area: (y || x).area, nome: (y || x).nome, antes: tot(x), depois: tot(y), nova: !x, removida: !y });
  }
  return out.sort((p, q) => Math.abs(q.depois - q.antes) - Math.abs(p.depois - p.antes));
}

// ---------- Prompt ----------
function promptSistema({ ano, contexto, base, planoAtual }) {
  return `Você é o CFO da StartGi Tecnologia (GovTech/B2B, investida pelo FIP GovTech) e monta o orçamento ${ano} junto com o CEO, Juliano, que não é especialista em finanças.

Seu trabalho:
- Montar e ajustar o orçamento anual ${ano}, mês a mês, a partir dos números reais do Omie (BASE_OMIE) e das premissas que o CEO der.
- Cada linha deve ter a explicação de onde veio o número no campo "base" (ex.: "média dos últimos 6 meses de Cloud no Omie + 5%").
- Quando faltar uma premissa importante, use a média recente do Omie e diga isso na resposta.
- Ao ajustar, altere só o que foi pedido e mantenha as demais linhas iguais às do ORÇAMENTO_ATUAL.
- Se o CEO só fizer uma pergunta, responda sem alterar o orçamento.

Áreas permitidas (use exatamente estes nomes): Receita, Impostos, Infraestrutura (custos diretos de entrega), Diretoria, Administrativo, Tecnologia, Operação / CS, Comercial, Financeiro (rendimentos e despesas financeiras).
Valores em reais, números inteiros já calculados: nunca escreva contas (como 12000*1.3), separador de milhar, comentários ou reticências no JSON. Receitas positivas; impostos e despesas positivos também (o sistema aplica o sinal). Em Financeiro, rendimento positivo e despesa negativa.
Marque "recorrente": true nas linhas de receita recorrente (MRR). Não crie linhas de total: o sistema calcula receita bruta, líquida, lucro bruto, EBITDA, resultado e caixa.
"caixaInicial" é o caixa no início de ${ano}; estime a partir do caixa atual do Omie se o CEO não informar.

Responda SOMENTE com um JSON válido, sem texto fora dele, neste formato:
{"resposta":"texto curto em português, até 120 palavras, sem markdown, dizendo o que fez ou respondendo a pergunta",
 "alterou": true ou false,
 "orcamento": null ou {"cenario":"Plano base","caixaInicial":0,"headcount":[12 números],"premissas":[{"nome":"","valor":""}],"pessoas":[{"nome":"","area":"","vinculo":"CLT|PJ","custoMensal":0,"entrada":"${ano}-01","saida":null}],"linhas":[{"area":"Receita","nome":"","recorrente":true,"valores":[12 números],"base":""}]}}
Quando "alterou" for true, envie o orçamento completo em "orcamento" (todas as linhas, não só as alteradas).

CONTEXTO DA EMPRESA:
${contexto || '(não informado)'}

BASE_OMIE (últimos 12 meses fechados):
${JSON.stringify(base)}

ORÇAMENTO_ATUAL:
${planoAtual ? JSON.stringify(planoAtual) : '(ainda não existe; se o CEO pedir, monte o primeiro)'}`;
}

// Corrige deslizes comuns da IA fora das strings: contas (12000*1.3),
// separador de milhar (1.200.000), vírgulas sobrando e comentários.
function repararJSON(t) {
  let out = '', i = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === '"') { // copia a string inteira sem mexer
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      out += t.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && t[i + 1] === '*') { const f = t.indexOf('*/', i + 2); i = f < 0 ? t.length : f + 2; continue; }
    const m = t.slice(i).match(/^-?[\d.()\s]*\d[\d.()\s*/+-]*/);
    if (m && /[\d]/.test(c + (t[i + 1] || '')) || (c === '-' || c === '(') && m) {
      let expr = m[0].trimEnd();
      if (/^-?\d{1,3}(\.\d{3})+$/.test(expr)) expr = expr.replace(/\./g, '');
      let v = Number(expr);
      if (!Number.isFinite(v) && /^[\d.()\s*/+-]+$/.test(expr)) {
        try { v = Function(`"use strict";return (${expr})`)(); } catch { v = NaN; }
      }
      out += Number.isFinite(v) ? String(Math.round(v * 100) / 100) : expr;
      i += m[0].trimEnd().length; continue;
    }
    out += c; i++;
  }
  return out.replace(/,\s*([\]}])/g, '$1');
}

function extrairJSON(texto) {
  const t = String(texto || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{'), f = t.lastIndexOf('}');
  if (i < 0 || f < i) throw new Error('A IA não devolveu um JSON.');
  const bruto = t.slice(i, f + 1);
  try { return JSON.parse(bruto); } catch (e1) {
    try { return JSON.parse(repararJSON(bruto)); } catch { throw e1; }
  }
}

module.exports = {
  supabaseConfigurado, salvarVersao, versaoAtual, listarVersoes, obterVersao, statusSupabase,
  baseOmie, normalizarPlano, calcular, diferencas, promptSistema, extrairJSON, AREAS,
};
