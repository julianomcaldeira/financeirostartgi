// Cadastro de colaboradores: pagamentos individuais vêm do Omie;
// salário, admissão, tipo e encargos (que o Omie financeiro não tem) ficam no Supabase.
const { sb, rateio, SEM_DEP, supabaseConfigurado } = require('./orcamento-ia');

const TABELA = 'colaboradores';
// Pagamentos feitos diretamente à pessoa (não inclui guias de FGTS/INSS nem operadoras de benefício).
const PAGAMENTO_PESSOA = /sal[aá]rio|pr[oó][\s-]?labore|folha|prestador|servi[cç]os? (de )?pj|\bpj\b|rescis|f[eé]rias|13[ºo°]|d[eé]cimo|comiss|bolsa|est[aá]gi|plr|adiantamento/i;
// Quem recebe mas não é pessoa: órgãos públicos, bancos, operadoras, sindicatos, contabilidade.
const NAO_PESSOA = /prefeitura|munic[ií]p|secretaria|receita federal|minist[eé]rio|governo|tesouro|estado d[eo]|caixa econ|\bbanco\b|\binss\b|\bfgts\b|sindicat|unimed|amil|bradesco|sul ?am[eé]rica|hapvida|notredame|alelo|sodexo|ticket|\bflash\b|\bcaju\b|vr benef|pluxee|ifood|contab|seguro|tribunal|conselho|cart[oó]rio|detran|sebrae|senac|sesc|senai|associa[cç][aã]o|funda[cç][aã]o|cooperativa|\brubi\b|n[aã]o identificado/i;
const EMPRESA = /\bltda\b|\beireli\b|\bs\.?\/?a\.?$|\bme\b|\bepp\b|\bmei\b|servi[cç]os|consultoria|tecnologia|solu[cç][oõ]es|comercio|com[eé]rcio/i;
const IMPOSTO = /imposto|\biss\b|irrf|tribut|taxa|guia|darf|contribui[cç][aã]o sindical/i;
const PJ_CAT = /\bpj\b|prestador|servi[cç]os? (de )?pj|terceiro/i;
function ehPessoa(nome, categoria) {
  if (IMPOSTO.test(categoria || '')) return false;
  if (NAO_PESSOA.test(nome || '')) return false;
  if (EMPRESA.test(nome || '') && !PJ_CAT.test(categoria || '')) return false;
  return true;
}
const titulo = s => String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\s(D[aeo]s?|E)\s/g, m => m.toLowerCase());

// Encargos + benefícios sobre o salário bruto, por tipo de contrato (editável por pessoa).
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
    if (l.tipo !== 'despesa' || !PAGAMENTO_PESSOA.test(l.categoria || '')) continue;
    const pago = Number(l.valorPago) > 0 ? Number(l.valorPago) : (['PAGO', 'LIQUIDADO'].includes(l.status) ? Number(l.valor || 0) : 0);
    if (!pago) continue;
    const data = l.pagamento || l.vencimento;
    if (!data) continue;
    const mes = String(data instanceof Date ? data.toISOString() : data).slice(0, 7);
    const nome = l.parceiro && l.parceiro !== 'Não identificado' ? l.parceiro : (l.descricao || 'Sem nome');
    if (!ehPessoa(nome, l.categoria)) { ignorados.add(nome); continue; }
    const k = chave(nome);
    if (!pessoas.has(k)) pessoas.set(k, { nome, meses: {}, deps: {}, categorias: new Set(), primeiro: mes, ultimo: mes });
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
    const tipo = c.tipo || tipoProvavel(o.categorias || []);
    const encargos = c.encargos_pct != null ? Number(c.encargos_pct) : (ENCARGOS_PADRAO[tipo] ?? 0);
    const salario = c.salario != null ? Number(c.salario) : null;
    const liquido = o.liquidoUltimoMes || 0;
    // Custo: salário bruto + encargos/benefícios; sem salário cadastrado, usa o valor pago (PJ) ou fica em aberto.
    const custo = salario != null ? salario * (1 + encargos / 100) : (tipo === 'PJ' || tipo === 'Estágio' ? (o.liquidoMedia3 || liquido) : null);
    const departamento = c.departamento || o.departamentoOmie || SEM_DEP;
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
      custoEstimado: salario == null,
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
