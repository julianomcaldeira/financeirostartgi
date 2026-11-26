// Oportunidades de redução de custos: detectadas a cada atualização do Omie
// e acompanhadas no Supabase (status, responsável, economia realizada).
const { sb, supabaseConfigurado } = require('./orcamento-ia');

// Guardado na tabela orcamento_versoes (ano = 0), para não exigir tabela nova no Supabase.
// Cada gravação cria uma linha nova com o estado completo; vale sempre a mais recente.
const TABELA_BASE = 'orcamento_versoes', ANO_CUSTOS = 0;
async function lerMapa() {
  const rows = await sb(`${TABELA_BASE}?ano=eq.${ANO_CUSTOS}&select=id,dados&order=id.desc&limit=1`);
  return new Map(Object.entries(rows[0]?.dados?.custos || {}));
}
async function gravarMapa(mapa) {
  await sb(TABELA_BASE, { method: 'POST', headers: { prefer: 'return=minimal' },
    body: JSON.stringify([{ ano: ANO_CUSTOS, dados: { custos: Object.fromEntries(mapa) }, mensagem: 'Acompanhamento de redução de custos' }]) });
}
const STATUS = ['Nova', 'Em análise', 'Em execução', 'Capturada', 'Descartada'];

const FOLHA = /sal[aá]rio|pr[oó][\s-]?labore|folha|fgts|\binss\b|irrf|f[eé]rias|13[ºo°]|d[eé]cimo|rescis|comiss|bolsa|est[aá]gi|plr|adiantamento/i;
const IMPOSTO = /imposto|\biss\b|pis|cofins|csll|irpj|simples|das\b|darf|tribut|\bicms\b/i;
const JUROS = /juros|multa|mora\b|encargos? financeiros?/i;
const TARIFA = /tarifa|taxa banc|\biof\b|manuten[cç][aã]o de conta|\bted\b|\bdoc\b|boleto|despesas? banc/i;
const ASSINATURA = /software|sistema|licen[cç]|assinatura|cloud|saas|hospedagem|servidor|\baws\b|google|microsoft|azure|internet|telefon|celular|ferramenta|plataforma|tecnologia|\bapi\b|dom[ií]nio/i;
const TRANSFERENCIA = /transfer[eê]ncia|aplica[cç][aã]o|resgate|empr[eé]stimo|financiamento|distribui[cç][aã]o de lucro|dividend/i;

const mesKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const R$ = v => 'R$ ' + Math.round(v || 0).toLocaleString('pt-BR');
const r2 = v => Math.round(v * 100) / 100;

// Gasto pago por mês (regime de caixa: o que de fato saiu).
function base(d) {
  const hoje = new Date();
  const fechados = [1, 2, 3, 4, 5, 6].map(i => mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1))).reverse(); // 6 meses fechados, do mais antigo
  const recentes = fechados.slice(3), anteriores = fechados.slice(0, 3);
  const pagos = (d.lancamentos || []).filter(l => l.tipo === 'despesa' && Number(l.valorPago || 0) > 0 && (l.pagamento || l.vencimento));
  const porForn = new Map(), porCat = new Map(), receitaMes = {};
  for (const l of d.lancamentos || []) {
    if (l.tipo === 'receita' && Number(l.valorPago) > 0) { const m = String(l.pagamento || l.vencimento).slice(0, 7); receitaMes[m] = (receitaMes[m] || 0) + Number(l.valorPago); }
  }
  const pagamentosAtrasados = [];
  for (const l of pagos) {
    const m = String(l.pagamento || l.vencimento).slice(0, 7);
    if (!fechados.includes(m)) continue;
    const v = Number(l.valorPago), cat = l.categoria || 'Sem categoria', forn = l.parceiro || 'Não identificado';
    if (TRANSFERENCIA.test(cat)) continue;
    const add = (mapa, k, extra) => {
      if (!mapa.has(k)) mapa.set(k, { nome: k, meses: {}, ...extra });
      const x = mapa.get(k); x.meses[m] = (x.meses[m] || 0) + v;
      if (x.categorias) x.categorias[cat] = (x.categorias[cat] || 0) + v;
    };
    add(porCat, cat, {});
    add(porForn, forn, { categorias: {} });
    if (l.pagamento && l.vencimento && l.pagamento > l.vencimento && Number(l.valorPago) > Number(l.valor || 0) + 0.5)
      pagamentosAtrasados.push({ forn, cat, mes: m, excedente: Number(l.valorPago) - Number(l.valor || 0) });
  }
  const serie = x => fechados.map(m => x.meses[m] || 0);
  for (const x of [...porForn.values(), ...porCat.values()]) {
    x.serie = serie(x);
    x.mediaRecente = media(recentes.map(m => x.meses[m] || 0));
    x.mediaAnterior = media(anteriores.map(m => x.meses[m] || 0));
    x.mesesComPagamento = x.serie.filter(v => v > 0).length;
    if (x.categorias) x.categoria = Object.entries(x.categorias).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }
  const recRec = media(recentes.map(m => receitaMes[m] || 0)), recAnt = media(anteriores.map(m => receitaMes[m] || 0));
  return { fechados, recentes, porForn, porCat, pagamentosAtrasados, crescReceita: recAnt ? recRec / recAnt - 1 : 0 };
}

function detectar(d) {
  const b = base(d);
  const ops = [];
  const pessoalOuImposto = cat => FOLHA.test(cat) || IMPOSTO.test(cat);
  const op = o => ops.push({ ...o, economiaMensal: r2(Math.max(0, o.economiaMensal)), economiaAnual: r2(Math.max(0, o.economiaMensal) * 12) });

  // 1. Juros e multas: custo 100% evitável.
  for (const c of b.porCat.values()) if (JUROS.test(c.nome) && c.mediaRecente + c.mediaAnterior > 0) {
    const m = media(c.serie);
    op({ id: `juros:${slug(c.nome)}`, tipo: 'Juros e multas', escopo: { tipo: 'categoria', nome: c.nome }, titulo: `Eliminar ${c.nome.toLowerCase()}`,
      descricao: `A StartGi pagou em média ${R$(m)} por mês em ${c.nome} nos últimos 6 meses. É custo de atraso, 100% evitável com pagamento em dia ou renegociação.`,
      acao: 'Mapear quais contas geraram juros, ajustar o calendário de pagamentos e alinhar vencimentos com a entrada de caixa.',
      gastoMensal: m, economiaMensal: m, confianca: 'alta', serie: c.serie });
  }
  // 2. Pagamentos com atraso (valor pago acima do título).
  if (b.pagamentosAtrasados.length) {
    const total = b.pagamentosAtrasados.reduce((a, x) => a + x.excedente, 0);
    const forns = [...new Set(b.pagamentosAtrasados.map(x => x.forn))].slice(0, 5);
    op({ id: 'atrasos:pagamentos', tipo: 'Juros e multas', escopo: null, titulo: 'Parar de pagar contas com atraso',
      descricao: `${b.pagamentosAtrasados.length} ${b.pagamentosAtrasados.length === 1 ? 'pagamento' : 'pagamentos'} nos últimos 6 meses ${b.pagamentosAtrasados.length === 1 ? 'saiu' : 'saíram'} depois do vencimento e com valor acima do título (${R$(total)} a mais no total). Principais: ${forns.join(', ')}.`,
      acao: 'Ativar DDA/agendamento automático e revisar quais vencimentos caem antes do recebimento dos clientes.',
      gastoMensal: total / 6, economiaMensal: total / 6, confianca: 'alta', serie: null });
  }
  // 3. Tarifas bancárias: negociáveis.
  for (const c of b.porCat.values()) if (TARIFA.test(c.nome) && c.mediaRecente >= 100) {
    op({ id: `tarifa:${slug(c.nome)}`, tipo: 'Tarifas bancárias', escopo: { tipo: 'categoria', nome: c.nome }, titulo: `Negociar ${c.nome.toLowerCase()}`,
      descricao: `Média de ${R$(c.mediaRecente)} por mês nos últimos 3 meses. Bancos digitais e pacotes PJ costumam reduzir essas tarifas pela metade ou zerar.`,
      acao: 'Pedir isenção ao gerente (com proposta de outro banco em mãos) ou migrar boletos/TEDs para um banco digital.',
      gastoMensal: c.mediaRecente, economiaMensal: c.mediaRecente * 0.5, confianca: 'média', serie: c.serie });
  }
  for (const f of b.porForn.values()) {
    if (pessoalOuImposto(f.categoria) || JUROS.test(f.categoria) || TARIFA.test(f.categoria)) continue;
    const esc = { tipo: 'fornecedor', nome: f.nome };
    const opF = o => op({ ...o, categoriaFornecedor: f.categoria });
    // 4. Fornecedor que ficou mais caro.
    const dif = f.mediaRecente - f.mediaAnterior;
    if (f.mediaAnterior >= 300 && dif >= 300 && f.mediaRecente / f.mediaAnterior - 1 >= 0.2) {
      opF({ id: `aumento:${slug(f.nome)}`, tipo: 'Fornecedor mais caro', escopo: esc, titulo: `${f.nome}: gasto subiu ${Math.round((f.mediaRecente / f.mediaAnterior - 1) * 100)}%`,
        descricao: `Média mensal passou de ${R$(f.mediaAnterior)} para ${R$(f.mediaRecente)} (${f.categoria}). Verificar se foi reajuste, aumento de uso ou cobrança indevida.`,
        acao: 'Pedir a memória de cálculo ao fornecedor, comparar com o contrato e negociar o reajuste ou reduzir o volume contratado.',
        gastoMensal: f.mediaRecente, economiaMensal: dif, confianca: 'média', serie: f.serie });
    }
    // 5. Novo custo fixo.
    const primeiro = f.serie.findIndex(v => v > 0);
    if (primeiro >= 3 && f.mesesComPagamento >= 2 && f.mediaRecente >= 500) {
      opF({ id: `novo:${slug(f.nome)}`, tipo: 'Novo custo fixo', escopo: esc, titulo: `Novo custo recorrente: ${f.nome}`,
        descricao: `Começou a ser pago nos últimos 3 meses e já soma ${R$(f.mediaRecente)} por mês (${f.categoria}). Custos novos tendem a ficar para sempre se ninguém valida.`,
        acao: 'Confirmar dono interno, objetivo e prazo. Se for teste, definir data para cancelar ou manter.',
        gastoMensal: f.mediaRecente, economiaMensal: f.mediaRecente * 0.3, confianca: 'baixa', serie: f.serie });
    }
    // 6. Assinaturas e ferramentas recorrentes.
    if (ASSINATURA.test(`${f.categoria} ${f.nome}`) && f.mesesComPagamento >= 4 && f.mediaRecente >= 200) {
      opF({ id: `assinatura:${slug(f.nome)}`, tipo: 'Assinaturas e ferramentas', escopo: esc, titulo: `Revisar plano de ${f.nome}`,
        descricao: `Pago em ${f.mesesComPagamento} dos últimos 6 meses, média de ${R$(f.mediaRecente)} por mês (${f.categoria}). Planos de software costumam ter licenças ociosas ou desconto no anual.`,
        acao: 'Contar usuários ativos x licenças pagas, rebaixar plano se possível e pedir desconto para pagamento anual (10–20%).',
        gastoMensal: f.mediaRecente, economiaMensal: f.mediaRecente * 0.15, confianca: 'média', serie: f.serie });
    }
  }
  // 7. Muitas ferramentas na mesma categoria: possível sobreposição.
  const recorrentesPorCat = {};
  for (const f of b.porForn.values()) if (ASSINATURA.test(`${f.categoria} ${f.nome}`) && f.mesesComPagamento >= 3 && f.mediaRecente >= 100 && !pessoalOuImposto(f.categoria))
    (recorrentesPorCat[f.categoria] = recorrentesPorCat[f.categoria] || []).push(f);
  for (const [cat, fs] of Object.entries(recorrentesPorCat)) if (fs.length >= 3) {
    fs.sort((a, b2) => a.mediaRecente - b2.mediaRecente);
    op({ id: `sobreposicao:${slug(cat)}`, tipo: 'Ferramentas sobrepostas', escopo: { tipo: 'categoria', nome: cat }, titulo: `${fs.length} ferramentas pagas em ${cat}`,
      descricao: `Fornecedores recorrentes na mesma categoria: ${fs.map(f => f.nome).join(', ')}. Vale checar se alguma faz o mesmo que outra.`,
      acao: 'Listar para que serve cada uma e quem usa. Consolidar em menos ferramentas.',
      gastoMensal: fs.reduce((a, f) => a + f.mediaRecente, 0), economiaMensal: fs[0].mediaRecente, confianca: 'baixa', serie: null });
  }
  // 8. Categoria crescendo mais rápido que a receita.
  for (const c of b.porCat.values()) {
    if (pessoalOuImposto(c.nome) || JUROS.test(c.nome) || TARIFA.test(c.nome) || c.mediaAnterior < 1000) continue;
    const cresc = c.mediaRecente / c.mediaAnterior - 1;
    if (cresc - b.crescReceita >= 0.15 && c.mediaRecente - c.mediaAnterior >= 1000) {
      const excesso = c.mediaRecente - c.mediaAnterior * (1 + Math.max(0, b.crescReceita));
      op({ id: `categoria:${slug(c.nome)}`, tipo: 'Custo crescendo acima da receita', escopo: { tipo: 'categoria', nome: c.nome }, titulo: `${c.nome} cresceu ${Math.round(cresc * 100)}%`,
        descricao: `Nos últimos 3 meses, ${c.nome} cresceu ${Math.round(cresc * 100)}% contra ${Math.round(b.crescReceita * 100)}% da receita recebida. Média foi de ${R$(c.mediaAnterior)} para ${R$(c.mediaRecente)} por mês.`,
        acao: 'Abrir os lançamentos da categoria, achar o que puxou o aumento e definir um teto mensal.',
        gastoMensal: c.mediaRecente, economiaMensal: excesso, confianca: 'média', serie: c.serie });
    }
  }
  ops.sort((a, b2) => b2.economiaAnual - a.economiaAnual);
  return { ops, base: b };
}

// Gasto mensal atual de um escopo (média dos 3 últimos meses fechados), para medir a economia realizada.
function gastoAtual(b, escopo) {
  if (!escopo) return null;
  const x = (escopo.tipo === 'fornecedor' ? b.porForn : b.porCat).get(escopo.nome);
  return x ? x.mediaRecente : 0;
}

async function lerAcompanhamento() {
  if (!supabaseConfigurado()) return { mapa: new Map(), erro: 'Supabase não configurado.' };
  try { return { mapa: await lerMapa() }; }
  catch (e) { return { mapa: new Map(), erro: e.message }; }
}

async function listar(d) {
  const { ops, base: b } = d ? detectar(d) : { ops: [], base: null };
  const { mapa: salvo, erro } = await lerAcompanhamento();
  const agora = new Date().toISOString();
  // Registra a primeira vez que cada oportunidade apareceu (é o que permite marcar "nova").
  const novas = ops.filter(o => !salvo.has(o.id));
  if (!erro && novas.length) {
    for (const o of novas) salvo.set(o.id, { id: o.id, status: 'Nova', titulo: o.titulo, tipo: o.tipo, escopo: o.escopo, detectada_em: agora, atualizado_em: agora, economia_estimada: o.economiaMensal, manual: false });
    try { await gravarMapa(salvo); } catch (e) { /* segue sem gravar */ }
  }
  const detectadas = new Set(ops.map(o => o.id));
  const lista = ops.map(o => ({ ...o, ...acomp(salvo.get(o.id), o, b), ativa: true }));
  // Itens que saíram da detecção ou foram criados à mão continuam visíveis enquanto estiverem em andamento.
  for (const s of salvo.values()) {
    if (detectadas.has(s.id)) continue;
    if (!s.manual && ['Nova', 'Descartada'].includes(s.status)) continue;
    lista.push({ id: s.id, tipo: s.tipo || 'Ideia do time', titulo: s.titulo, descricao: s.nota || '', acao: '', escopo: s.escopo || null,
      gastoMensal: b ? gastoAtual(b, s.escopo) : null, economiaMensal: Number(s.economia_estimada || 0), economiaAnual: Number(s.economia_estimada || 0) * 12,
      confianca: s.manual ? 'manual' : '—', serie: null, ...acomp(s, null, b), ativa: false });
  }
  const ativas = lista.filter(o => o.status !== 'Descartada');
  return {
    lista,
    resumo: {
      potencialMensal: potencial(ativas.filter(o => o.status !== 'Capturada')),
      capturadaMensal: r2(lista.filter(o => ['Em execução', 'Capturada'].includes(o.status)).reduce((a, o) => a + Math.max(0, o.economiaRealizada || 0), 0)),
      novas: lista.filter(o => o.status === 'Nova' && o.ativa).length,
      emAndamento: lista.filter(o => ['Em análise', 'Em execução'].includes(o.status)).length,
      meses: b ? b.fechados : [],
      crescReceita: b ? b.crescReceita : null,
    },
    status: STATUS,
    erroBanco: erro || null,
    atualizadoEm: d?.atualizadoEm || null,
  };
}

// Soma do potencial sem contar duas vezes o mesmo fornecedor/categoria:
// por escopo vale a maior economia; alertas de categoria só somam o que excede os fornecedores já contados.
function potencial(lista) {
  const porEscopo = new Map();
  for (const o of lista) {
    const k = o.escopo ? `${o.escopo.tipo}:${o.escopo.nome}` : o.id;
    porEscopo.set(k, Math.max(porEscopo.get(k) || 0, o.economiaMensal || 0));
  }
  let total = 0;
  for (const [k, v] of porEscopo) {
    if (k.startsWith('categoria:')) {
      const cat = k.slice(10);
      const forns = new Set(lista.filter(o => o.escopo?.tipo === 'fornecedor' && o.categoriaFornecedor === cat).map(o => o.escopo.nome));
      const jaContado = [...forns].reduce((a, n) => a + (porEscopo.get(`fornecedor:${n}`) || 0), 0);
      total += Math.max(0, v - jaContado);
    } else total += v;
  }
  return r2(total);
}

function acomp(s, o, b) {
  s = s || {};
  const baseline = s.baseline_mensal != null ? Number(s.baseline_mensal) : null;
  const atual = b && s.escopo ? gastoAtual(b, s.escopo) : (o ? o.gastoMensal : null);
  return {
    status: s.status || 'Nova',
    responsavel: s.responsavel || '',
    nota: s.nota || '',
    prazo: s.prazo || null,
    detectadaEm: s.detectada_em || null,
    atualizadoEm: s.atualizado_em || null,
    baselineMensal: baseline,
    gastoAtualMensal: atual,
    // Economia realizada: quanto o gasto mensal caiu desde que a ação começou.
    economiaRealizada: baseline != null && atual != null ? r2(baseline - atual) : null,
    manual: Boolean(s.manual),
  };
}

async function salvar(body, d) {
  const id = String(body.id || '').trim() || `manual:${Date.now()}`;
  const status = STATUS.includes(body.status) ? body.status : 'Nova';
  const mapa = await lerMapa();
  const atual = mapa.get(id);
  const linha = {
    id, status,
    titulo: String(body.titulo || atual?.titulo || '').slice(0, 200) || 'Oportunidade',
    tipo: body.tipo || atual?.tipo || 'Ideia do time',
    escopo: body.escopo !== undefined ? body.escopo : (atual?.escopo || null),
    responsavel: body.responsavel != null ? String(body.responsavel).slice(0, 80) : (atual?.responsavel || null),
    nota: body.nota != null ? String(body.nota).slice(0, 2000) : (atual?.nota || null),
    prazo: body.prazo || atual?.prazo || null,
    economia_estimada: body.economia_estimada != null && body.economia_estimada !== '' ? Number(body.economia_estimada) : (atual?.economia_estimada ?? null),
    manual: atual ? atual.manual : id.startsWith('manual:'),
    detectada_em: atual?.detectada_em || new Date().toISOString(),
    baseline_mensal: atual?.baseline_mensal ?? null,
    atualizado_em: new Date().toISOString(),
  };
  // Ao entrar em execução, congela o gasto de referência para medir a economia depois.
  if (['Em execução', 'Capturada'].includes(status) && linha.baseline_mensal == null && d && linha.escopo) {
    const b = base(d);
    linha.baseline_mensal = gastoAtual(b, linha.escopo);
  }
  mapa.set(id, linha);
  await gravarMapa(mapa);
  return linha;
}

module.exports = { listar, salvar, detectar, STATUS };
