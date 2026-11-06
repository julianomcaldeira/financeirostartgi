// Cadastro de colaboradores: pagamentos individuais vêm do Omie;
// salário, admissão, tipo e encargos (que o Omie financeiro não tem) ficam no Supabase.
const { sb, rateio, SEM_DEP, supabaseConfigurado } = require('./orcamento-ia');

const TABELA = 'colaboradores';
// Pagamentos feitos diretamente à pessoa (não inclui guias de FGTS/INSS nem operadoras de benefício).
const PAGAMENTO_PESSOA = /sal[aá]rio|pr[oó][\s-]?labore|folha|prestador|servi[cç]os? (de )?pj|\bpj\b|rescis|f[eé]rias|13[ºo°]|d[eé]cimo|comiss|bolsa|est[aá]gi|plr|adiantamento|honor[aá]rio|remunera|terceir|freela|bonifica|gratifica|pessoal/i;
// Quem recebe mas não é pessoa: órgãos públicos, bancos, operadoras, sindicatos, contabilidade.
const NAO_PESSOA = /prefeitura|munic[ií]p|secretaria|receita federal|minist[eé]rio|governo|tesouro|estado d[eo]|caixa econ|\bbanco\b|\binss\b|\bfgts\b|sindicat|unimed|amil|bradesco|sul ?am[eé]rica|hapvida|notredame|alelo|sodexo|ticket|\bflash\b|\bcaju\b|vr benef|pluxee|ifood|contab|seguro|tribunal|conselho|cart[oó]rio|detran|sebrae|senac|sesc|senai|associa[cç][aã]o|funda[cç][aã]o|cooperativa|n[aã]o identificado/i;
const EMPRESA = /\bltda\b|\beireli\b|\bs\.?\/?a\.?$|\bme\b|\bepp\b|\bmei\b|servi[cç]os|consultoria|tecnologia|solu[cç][oõ]es|comercio|com[eé]rcio/i;
const IMPOSTO = /imposto|\biss\b|irrf|tribut|taxa|guia|darf|contribui[cç][aã]o sindical/i;
const PJ_CAT = /\bpj\b|prestador|servi[cç]os? (de )?pj|terceir|honor[aá]rio|freela/i;
// Recebedores no Omie que são uma pessoa do time com outro nome (ex.: empresa PJ da pessoa).
const APELIDOS = [[/\brubi\b/i, 'Aline · Rubi', 'Administrativo']];
const depApelido = nome => (APELIDOS.find(([, n]) => n === nome) || [])[2] || null;
const apelido = nome => (APELIDOS.find(([re]) => re.test(nome || '')) || [])[1] || null;
function ehPessoa(nome, categoria) {
  if (apelido(nome)) return true;
  if (IMPOSTO.test(categoria || '')) return false;
  if (NAO_PESSOA.test(nome || '')) return false;
  if (EMPRESA.test(nome || '') && !PJ_CAT.test(categoria || '')) return false;
  return true;
}
const titulo = s => String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, m => m.toLowerCase());

// Encargos + benefícios sobre o salário bruto, por tipo de contrato (editável por pessoa).

// Estima o bruto a partir do líquido pago (INSS + IRRF aproximados). Só usado quando não há salário cadastrado.
const TETO_INSS = 8157.41;
function inssCLT(b) {
  const f = [[1518, .075], [2793.88, .09], [4190.83, .12], [TETO_INSS, .14]];
  let ant = 0, t = 0;
  for (const [lim, al] of f) { if (b > ant) t += (Math.min(b, lim) - ant) * al; ant = lim; }
  return t;
}
function irrf(base) {
  const f = [[2428.8, 0, 0], [2826.65, .075, 182.16], [3751.05, .15, 394.16], [4664.68, .225, 675.49], [Infinity, .275, 908.73]];
  const [, al, ded] = f.find(([lim]) => base <= lim);
  let ir = Math.max(0, base * al - ded);
  if (base <= 5000) ir = 0; else if (base <= 7350) ir = Math.max(0, ir - (978.62 - 0.133145 * base));
  return ir;
}
function liquidoDe(bruto, tipo) {
  const inss = tipo === 'Pró-labore' ? Math.min(bruto, TETO_INSS) * 0.11 : inssCLT(bruto);
  return bruto - inss - irrf(bruto - inss);
}
function brutoEstimado(liquido, tipo) {
  if (!liquido) return null;
  if (tipo !== 'CLT' && tipo !== 'Pró-labore') return liquido;
  let lo = liquido, hi = liquido * 2;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (liquidoDe(m, tipo) < liquido) lo = m; else hi = m; }
  return Math.round(hi * 100) / 100;
}

const ENCARGOS_PADRAO = { CLT: Number(process.env.ENCARGOS_CLT_PCT || 70), 'Pró-labore': 20, PJ: 0, Estágio: 0 };
const mesKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const chave = nome => String(nome || '').trim().toLowerCase();

async function lerCadastro() {
  if (!supabaseConfigurado()) return { linhas: [], erro: 'Supabase não configurado.' };
  try { return { linhas: await sb(`${TABELA}?select=*`) }; }
  catch (e) { return { linhas: [], erro: e.message }; }
}

async function salvarCadastro(c) {
  const linha = {
    nome: String(c.nome || '').trim().slice(0, 200),
    cargo: c.cargo ? String(c.cargo).slice(0, 120) : null,
    tipo: c.tipo ? String(c.tipo).slice(0, 30) : null,
    departamento: c.departamento ? String(c.departamento).slice(0, 120) : null,
    salario: c.salario === '' || c.salario == null ? null : Number(c.salario),
    admissao: c.admissao || null,
    encargos_pct: c.encargos_pct === '' || c.encargos_pct == null ? null : Number(c.encargos_pct),
    ativo: c.ativo !== false,
    atualizado_em: new Date().toISOString(),
  };
  if (!linha.nome) throw new Error('Nome obrigatório.');
  if (linha.salario != null && !isFinite(linha.salario)) throw new Error('Salário inválido.');
  const [row] = await sb(`${TABELA}?on_conflict=nome`, {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([linha]),
  });
  return row;
}

function pagamentosOmie(d) {
  const hoje = new Date();
  const mesAtual = mesKey(hoje);
  const ultimosFechados = [1, 2, 3].map(i => mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)));
  const pessoas = new Map(), ignorados = new Set();
  for (const l of d.lancamentos || []) {
    if (l.tipo !== 'despesa') continue;
    if (!PAGAMENTO_PESSOA.test(l.categoria || '') && !apelido(l.parceiro)) continue;
    if (apelido(l.parceiro) && IMPOSTO.test(l.categoria || '')) continue;
    const pago = Number(l.valorPago) > 0 ? Number(l.valorPago) : (['PAGO', 'LIQUIDADO'].includes(l.status) ? Number(l.valor || 0) : 0);
    if (!pago) continue;
    const data = l.pagamento || l.vencimento;
    if (!data) continue;
    const mes = String(data instanceof Date ? data.toISOString() : data).slice(0, 7);
    let nome = l.parceiro && l.parceiro !== 'Não identificado' ? l.parceiro : (l.descricao || 'Sem nome');
    const ap = apelido(nome);
    if (!ap && !ehPessoa(nome, l.categoria)) { ignorados.add(nome); continue; }
    if (ap) nome = ap;
    const k = chave(nome);
    if (!pessoas.has(k)) pessoas.set(k, { nome, apelido: Boolean(ap), meses: {}, deps: {}, categorias: new Set(), primeiro: mes, ultimo: mes });
    const p = pessoas.get(k);
    p.meses[mes] = (p.meses[mes] || 0) + pago;
    p.categorias.add(l.categoria);
    if (mes < p.primeiro) p.primeiro = mes;
    if (mes > p.ultimo) p.ultimo = mes;
    for (const [dep, v] of rateio(l, pago)) p.deps[dep] = (p.deps[dep] || 0) + v;
  }
  const lista = [...pessoas.values()].map(p => {
    const depsOrd = Object.entries(p.deps).sort((a, b) => b[1] - a[1]);
    const comDep = depsOrd.filter(([n]) => n !== SEM_DEP);
    const mesesPagos = Object.keys(p.meses).filter(m => m < mesAtual).sort();
    const ultimoMes = mesesPagos[mesesPagos.length - 1] || null;
    const media3 = ultimosFechados.reduce((a, m) => a + (p.meses[m] || 0), 0) / 3;
    return {
      nome: p.nome,
      apelido: p.apelido,
      departamentoOmie: comDep[0]?.[0] || null,
      departamentosOmie: comDep.map(([n, v]) => ({ nome: n, valor: Math.round(v) })),
      categorias: [...p.categorias],
      liquidoUltimoMes: ultimoMes ? p.meses[ultimoMes] : 0,
      ultimoMes,
      liquidoMedia3: media3,
      primeiroPagamento: p.primeiro,
      ultimoPagamento: p.ultimo,
      // sem pagamento nos últimos 2 meses fechados = provável desligado
      ativoOmie: Boolean(p.meses[ultimosFechados[0]] || p.meses[ultimosFechados[1]] || p.meses[mesAtual]),
    };
  });
  return { lista, ignorados: [...ignorados].sort() };
}

function tipoProvavel(categorias) {
  const c = categorias.join(' ');
  if (/pr[oó][\s-]?labore/i.test(c)) return 'Pró-labore';
  if (/est[aá]gi|bolsa/i.test(c)) return 'Estágio';
  if (/\bpj\b|prestador|servi[cç]os/i.test(c)) return 'PJ';
  return 'CLT';
}

async function listar(d) {
  const { lista: omie, ignorados } = d ? pagamentosOmie(d) : { lista: [], ignorados: [] };
  const { linhas, erro } = await lerCadastro();
  const cad = new Map(linhas.map(l => [chave(l.nome), l]));
  const nomes = new Set([...omie.map(p => chave(p.nome)), ...cad.keys()]);
  const porNome = new Map(omie.map(p => [chave(p.nome), p]));
  const lista = [...nomes].map(k => {
    const o = porNome.get(k) || {};
    const c = cad.get(k) || {};
    const tipo = c.tipo || (o.apelido ? 'PJ' : tipoProvavel(o.categorias || []));
    const encargos = c.encargos_pct != null ? Number(c.encargos_pct) : (ENCARGOS_PADRAO[tipo] ?? 0);
    const salarioCad = c.salario != null ? Number(c.salario) : null;
    const liquido = o.liquidoUltimoMes || 0;
    // Sem salário cadastrado, estima o bruto pela média líquida paga nos últimos 3 meses.
    const salario = salarioCad != null ? salarioCad : brutoEstimado(o.liquidoMedia3 || liquido, tipo);
    const custo = salario != null ? salario * (1 + encargos / 100) : null;
    const departamento = c.departamento || depApelido(o.nome) || o.departamentoOmie || SEM_DEP;
    return {
      nome: c.nome || o.nome,
      nomeExibicao: titulo(c.nome || o.nome),
      cargo: c.cargo || '',
      tipo,
      departamento,
      origemDepartamento: c.departamento ? 'manual' : o.departamentoOmie ? 'omie' : 'nenhuma',
      departamentosOmie: o.departamentosOmie || [],
      salario,
      admissao: c.admissao || null,
      admissaoEstimada: c.admissao ? null : (o.primeiroPagamento || null),
      encargosPct: encargos,
      custo,
      salarioEstimado: salarioCad == null && salario != null,
      custoEstimado: salarioCad == null,
      liquidoUltimoMes: liquido,
      ultimoMes: o.ultimoMes || null,
      liquidoMedia3: o.liquidoMedia3 || 0,
      categorias: o.categorias || [],
      ativo: c.ativo === false ? false : (c.nome ? true : (o.ativoOmie ?? true)),
      cadastrado: Boolean(c.nome),
      noOmie: Boolean(o.nome),
    };
  }).filter(c => c.tipo !== 'Não é colaborador')
    .sort((a, b) => a.departamento.localeCompare(b.departamento) || a.nome.localeCompare(b.nome));
  const ocultos = linhas.filter(l => l.tipo === 'Não é colaborador').map(l => l.nome);
  return { lista, ignorados, ocultos, erroBanco: erro || null, encargosPadrao: ENCARGOS_PADRAO, supabase: supabaseConfigurado() };
}

module.exports = { listar, salvarCadastro, ehPessoa, titulo };
