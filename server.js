// Painel Financeiro StartGi — backend que consulta o Omie e calcula os indicadores
const express = require('express');
const path = require('path');
const fs = require('fs');
const { googleSheetExportUrl, googleSheetGvizUrl, parseOrcamentoCSV, montarOrcamento } = require('./lib/orcamento');

const { OMIE_APP_KEY, OMIE_APP_SECRET, PAINEL_SENHA } = process.env;
const PORT = process.env.PORT || 3000;
const REFRESH_MIN = Number(process.env.ATUALIZACAO_MINUTOS || 120);
const CACHE_MIN = Number(process.env.CACHE_MINUTOS || REFRESH_MIN);
const INSIGHTS_MIN = Number(process.env.INSIGHTS_MINUTOS || 10080); // 7 dias
const INSIGHTS_MODEL = process.env.INSIGHTS_MODELO || 'claude-haiku-5-5';

// Command Code Provider API (compatível com Anthropic Messages)
const AI_KEY = process.env.COMMAND_IA || process.env.COMMANDCODE_API_KEY || process.env.CMD_API_KEY || process.env.ANTHROPIC_API_KEY;
const AI_BASE = (process.env.COMMANDCODE_BASE_URL || 'https://api.commandcode.ai/provider/v1').replace(/\/$/, '');
const AI_MODEL = process.env.GURU_MODELO || 'claude-sonnet-5-5';

// Contexto livre da empresa (editável em contexto.md, sem mexer no código)
function contextoEmpresa() {
  let txt = '';
  try { txt = fs.readFileSync(path.join(__dirname, 'contexto.md'), 'utf8'); } catch {}
  if (process.env.CONTEXTO_EXTRA) txt += '\n\n' + process.env.CONTEXTO_EXTRA;
  return txt.trim().slice(0, 12000);
}

// Caixa aplicado que não aparece nas contas correntes do Omie.
// Preferência: variável CAIXA_APLICADO. Fallback: extrai do contexto.md.
function caixaAplicadoContexto() {
  if (process.env.CAIXA_APLICADO !== undefined) {
    const v = Number(String(process.env.CAIXA_APLICADO).replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  }
  const txt = contextoEmpresa();
  const m = txt.match(/R\$\s*([\d.,]+)\s*(milh(?:ão|ões)|mil)?[^.\n]{0,40}(?:aplicad|aplica[cç])/i)
    || txt.match(/(?:caixa\s+aplicado|aplica[cç][aã]o)[^.\n]{0,40}?R\$\s*([\d.,]+)\s*(milh(?:ão|ões)|mil)?/i);
  if (!m) return 0;
  let v = Number(m[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(v)) return 0;
  const escala = (m[2] || '').toLowerCase();
  if (escala.startsWith('milh')) v *= 1e6;
  else if (escala === 'mil') v *= 1e3;
  return v;
}

async function chamarIA(system, mensagens, maxTokens = 4096, modelo = AI_MODEL) {
  const r = await fetch(`${AI_BASE}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelo, max_tokens: maxTokens, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system, messages: mensagens }),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
  });
  const bruto = await r.text();
  let j;
  try { j = JSON.parse(bruto); } catch { throw new Error(`IA ${r.status} respondeu HTML/texto em vez de JSON: ${bruto.slice(0, 180)}`); }
  if (!r.ok) throw new Error(`IA ${r.status}: ${j.error?.message || j.message || 'falha na chamada'}`);
  const texto = j.content?.filter?.(b => b.type === 'text' || b.text)?.map?.(b => b.text).filter(Boolean).join('\n') || j.choices?.[0]?.message?.content || j.output_text || '';
  if (!texto) {
    const tipos = Array.isArray(j.content) ? j.content.map(b => b.type || 'sem-tipo').join(',') : typeof j.content;
    throw new Error(`IA sem texto (blocos: ${tipos}; stop: ${j.stop_reason || '—'}; tokens: ${j.usage?.output_tokens ?? '—'})`);
  }
  return texto;
}

async function chamarIAOpenAI(system, mensagens, maxTokens = 4096, modelo = INSIGHTS_MODEL) {
  const r = await fetch(`${AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}` },
    body: JSON.stringify({ model: modelo, max_tokens: maxTokens, temperature: 0.3, messages: [{ role: 'system', content: system }, ...mensagens] }),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined,
  });
  const bruto = await r.text();
  let j;
  try { j = JSON.parse(bruto); } catch { throw new Error(`IA ${r.status} respondeu HTML/texto em vez de JSON: ${bruto.slice(0, 180)}`); }
  if (!r.ok) throw new Error(`IA ${r.status}: ${j.error?.message || j.message || 'falha na chamada'}`);
  const msg = j.choices?.[0]?.message || {};
  const texto = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(b => b.text || b.content || '').join('\n') : (j.output_text || '');
  if (!texto) throw new Error(`IA sem texto (finish: ${j.choices?.[0]?.finish_reason || '—'}; tokens: ${j.usage?.completion_tokens ?? '—'})`);
  return texto;
}

const app = express();
app.use(express.json());

// Favicon público (antes da proteção por senha)
app.get('/favicon.svg', (req, res) => res.type('image/svg+xml').sendFile(path.join(__dirname, 'favicon.svg')));
app.get('/favicon.ico', (req, res) => res.redirect(302, '/favicon.svg'));

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

const baixasCache = { CR: { at: 0, data: {} }, CP: { at: 0, data: {} } };
async function listarBaixas(tipo, force = false) {
  const cache = baixasCache[tipo];
  if (!force && Date.now() - cache.at < CACHE_MIN * 60e3) return cache.data;
  let pagina = 1, total = 1;
  const mapa = {};
  do {
    const j = await omie('financas/mf/', 'ListarMovimentos', { nPagina: pagina, nRegPorPagina: 50, cTpLancamento: `BX${tipo}` });
    if (!j) break;
    for (const mov of j.movimentos || []) {
      const d = mov.detalhes || {};
      const id = String(d.nCodTitulo || '');
      const data = dt(d.dDtPagamento) || dt(d.dDtCredito);
      if (!id || !data) continue;
      const valor = Number(mov.resumo?.nValPago ?? d.nValorMovCC ?? 0);
      (mapa[id] ||= []).push({ data, valor });
    }
    total = j.nTotPaginas || 1;
    pagina++;
    await new Promise(r => setTimeout(r, 350));
  } while (pagina <= total);
  for (const lista of Object.values(mapa)) lista.sort((a, b) => a.data - b.data);
  baixasCache[tipo] = { at: Date.now(), data: mapa };
  return mapa;
}

const dt = s => { if (!s) return null; const [d, m, a] = s.split('/'); return new Date(+a, +m - 1, +d); };
const mesKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const soma = arr => arr.reduce((s, x) => s + x, 0);
const media = arr => arr.length ? soma(arr) / arr.length : 0;
const desvio = arr => {
  if (!arr.length) return 0;
  const m = media(arr);
  return Math.sqrt(media(arr.map(x => (x - m) ** 2)));
};
const varRel = (atual, anterior) => anterior ? (atual - anterior) / Math.abs(anterior) : null;
const moedaIns = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pctIns = v => (v === null || v === undefined || Number.isNaN(v)) ? '—' : `${(v * 100).toFixed(0)}%`;
const NOMES_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function montarInsights(d) {
  const k = d.kpis || {};
  const atr = d.atrasadosResumo || { buckets: [] };
  const rec = d.recorrente || {};
  const ctr = d.contratos || {};
  const reg = d.regimes || {};
  const caixa = reg.caixa || {};
  const comp = reg.competencia || {};
  const dif = reg.diferenca || {};
  const fechados = (d.serieMensal || []).slice(0, -1);
  const ult3Arr = fechados.slice(-3);
  const ant3Arr = fechados.slice(-6, -3);
  const recMedia = media(ult3Arr.map(x => x.receita));
  const recAnt = media(ant3Arr.map(x => x.receita));
  const despMedia = media(ult3Arr.map(x => x.despesa));
  const despAnt = media(ant3Arr.map(x => x.despesa));
  const resMedia = recMedia - despMedia;
  const margem3 = recMedia ? resMedia / recMedia : null;
  const varReceita = varRel(recMedia, recAnt);
  const varDespesa = varRel(despMedia, despAnt);

  const recSerie = (rec.serie || []).slice(0, -1);
  const recMedia3 = media(recSerie.slice(-3).map(x => Number(x.recorrente || 0)));
  const recAntMedia = media(recSerie.slice(-6, -3).map(x => Number(x.recorrente || 0)));
  const varRec = varRel(recMedia3, recAntMedia);

  const receita12 = caixa.receita || k.receita12 || 0;
  const atrasoRatio = receita12 ? Number(atr.total || 0) / receita12 : 0;
  const bucket90 = (atr.buckets || []).find(b => /90\+/.test(b.faixa || '')) || {};
  const ratio90 = atr.total ? Number(bucket90.valor || 0) / atr.total : 0;
  const gapMrr = Number(ctr.mrr || 0) - Number(rec.mensalMedia || 0);

  const topCli = (d.clientes || [])[0];
  const topProd = (d.produtosReceita || [])[0];
  const topDesp = (d.despesas || [])[0];
  const desp12 = soma((d.serieMensal || []).slice(-12).map(x => x.despesa));
  const topDespShare = topDesp && desp12 ? topDesp.valor / desp12 : 0;

  const rec12Arr = fechados.slice(-12).map(x => x.receita);
  const mediaRec12 = media(rec12Arr);
  const vol12 = mediaRec12 ? desvio(rec12Arr) / mediaRec12 : 0;
  const piorSemana = (d.semanas || []).reduce((a, b) => (b.saldo < a.saldo ? b : a), (d.semanas || [])[0]);

  const mapaSaz = {};
  fechados.forEach(x => {
    if (!x.mes) return;
    const m = Number(x.mes.split('-')[1]);
    if (!mapaSaz[m]) mapaSaz[m] = [];
    mapaSaz[m].push(x);
  });
  const sazonalidade = NOMES_MES.map((nome, i) => {
    const arr = mapaSaz[i + 1] || [];
    return { mes: i + 1, nome, receita: media(arr.map(x => x.receita)), resultado: media(arr.map(x => x.resultado)), amostra: arr.length };
  });
  const comSaz = sazonalidade.filter(x => x.amostra > 0);
  const melhorMes = comSaz.slice().sort((a, b) => b.resultado - a.resultado)[0] || null;
  const piorMes = comSaz.slice().sort((a, b) => a.resultado - b.resultado)[0] || null;

  const mapaAtraso = {};
  (d.atrasadosTodos || []).forEach(t => {
    const nome = t.cliente || 'Não identificado';
    if (!mapaAtraso[nome]) mapaAtraso[nome] = { cliente: nome, total: 0, qtd: 0, maiorDias: 0 };
    const x = mapaAtraso[nome];
    x.total += Number(t.valor || 0);
    x.qtd += 1;
    x.maiorDias = Math.max(x.maiorDias, Number(t.dias || 0));
  });
  const clientesAtraso = Object.values(mapaAtraso).sort((a, b) => b.total - a.total).slice(0, 6);

  const anoAtual = (d.ano || {}).atual || {};
  const anoAnt = (d.ano || {}).anterior || {};
  const varYTD = varRel(anoAtual.receita, anoAnt.receita);

  const insights = [];
  const add = (tema, nivel, titulo, leitura, numero, acao, comportamento) =>
    insights.push({ tema, nivel, titulo, leitura, numero, acao, comportamento });

  const gapCaixa = Number(dif.resultado || 0);
  if (gapCaixa > 50000) {
    add('Caixa', 'alto', 'O resultado na competência não virou caixa',
      `Nos últimos 12 meses a competência fechou em ${moedaIns(comp.resultado)} e o caixa em ${moedaIns(caixa.resultado)}. A diferença de ${moedaIns(gapCaixa)} está presa em recebíveis e prazos.`,
      `Gap de ${moedaIns(gapCaixa)}`,
      'Colocar os maiores atrasados em cobrança ativa e revisar prazos dos novos contratos.',
      'Toda segunda, comparar competência x caixa e cobrar a diferença.');
  }
  if (atr.total > 0) {
    add('Cobrança', atrasoRatio > 0.08 || ratio90 > 0.4 ? 'alto' : 'medio', `${moedaIns(atr.total)} vencidos para receber`,
      `São ${atr.qtd} títulos, equivalentes a ${pctIns(atrasoRatio)} da receita dos últimos 12 meses. ${pctIns(ratio90)} do saldo tem mais de 90 dias.`,
      `${atr.qtd} títulos · ${pctIns(ratio90)} acima de 90 dias`,
      'Colocar os 10 maiores em cobrança ativa esta semana e definir régua para os demais.',
      'Régua semanal: D+1 lembrete, D+7 contato, D+15 negociação, D+30 escalação.');
  } else {
    add('Cobrança', 'ok', 'Carteira em dia', 'Não há títulos vencidos em aberto no momento.', 'R$ 0 em atraso', 'Manter a régua preventiva de cobrança.', 'Revisar semanalmente os vencimentos da semana.');
  }
  if (atr.maiorDias > 180) {
    add('Cobrança', 'alto', 'Títulos antigos demais na carteira',
      `O título mais antigo está vencido há ${atr.maiorDias} dias e a média da carteira é de ${atr.mediaDias} dias. Quanto mais velho, menor a chance de recuperação.`,
      `Maior atraso: ${atr.maiorDias} dias`,
      'Separar títulos acima de 180 dias para negociação, provisão ou baixa.',
      'Revisar mensalmente a carteira acima de 180 dias e definir responsável.');
  }
  if (varReceita !== null && Math.abs(varReceita) >= 0.05) {
    add('Receita', varReceita < 0 ? 'alto' : 'ok', varReceita < 0 ? 'A receita caiu no trimestre' : 'A receita cresceu no trimestre',
      `A média mensal passou de ${moedaIns(recAnt)} para ${moedaIns(recMedia)} (${pctIns(varReceita)}).`,
      `${varReceita >= 0 ? '+' : ''}${pctIns(varReceita)} vs trimestre anterior`,
      varReceita < 0 ? 'Revisar pipeline, conversão e retenção dos próximos 90 dias.' : 'Identificar o que puxou o crescimento e repetir o playbook.',
      'Revisar trimestralmente pipeline, conversão e churn.');
  } else if (recMedia > 0) {
    add('Receita', 'ok', 'Receita estável no trimestre',
      `A média mensal dos últimos 3 meses fechados é de ${moedaIns(recMedia)}, sem variação relevante contra o trimestre anterior.`,
      `Média de ${moedaIns(recMedia)}/mês`,
      'Usar a estabilidade para corrigir margem e previsibilidade.',
      'Acompanhar mensalmente a variação da receita.');
  }
  if (varDespesa !== null && varReceita !== null && varDespesa > varReceita + 0.05) {
    add('Custos', 'alto', 'A despesa cresce mais rápido que a receita',
      `No trimestre, a despesa variou ${pctIns(varDespesa)} contra ${pctIns(varReceita)} da receita. A margem perde espaço se isso continuar.`,
      `Despesa ${pctIns(varDespesa)} x receita ${pctIns(varReceita)}`,
      'Revisar as 3 maiores despesas e congelar contratações não essenciais.',
      'Mensalmente, comparar a variação das 5 maiores despesas com a receita.');
  }
  if (margem3 !== null && margem3 < 0) {
    add('Resultado', 'alto', 'A operação está consumindo caixa',
      `Média dos últimos 3 meses fechados: ${moedaIns(resMedia)} de resultado e margem de ${pctIns(margem3)}.`,
      `Resultado médio: ${moedaIns(resMedia)}`,
      'Definir meta de ponto de equilíbrio e cortar o que não sustenta receita.',
      'Revisar semanalmente as entradas e saídas contra a meta de equilíbrio.');
  } else if (margem3 !== null && margem3 < 0.08) {
    add('Resultado', 'medio', 'Margem apertada',
      `A margem média dos últimos 3 meses é de ${pctIns(margem3)}, com resultado de ${moedaIns(resMedia)} por mês.`,
      `Margem de ${pctIns(margem3)}`,
      'Priorizar receita recorrente e renegociar as maiores despesas.',
      'Acompanhar margem mensalmente antes de aumentar custo fixo.');
  } else if (margem3 !== null) {
    add('Resultado', 'ok', 'Operação com margem',
      `A margem média dos últimos 3 meses é de ${pctIns(margem3)}, com resultado de ${moedaIns(resMedia)} por mês.`,
      `Margem de ${pctIns(margem3)}`,
      'Direcionar parte da sobra para reserva antes de novos custos fixos.',
      'Mensalmente, definir quanto do resultado vira reserva.');
  }
  if (k.runway !== undefined && k.runway !== null && k.runway < 6) {
    add('Caixa', 'alto', 'Fôlego de caixa curto',
      `No ritmo atual, o saldo cobre ${k.runway.toFixed(1)} meses. Abaixo de 6 meses é zona de atenção.`,
      `${k.runway.toFixed(1)} meses de fôlego`,
      'Antecipar recebíveis, renegociar pagamentos e congelar novas contratações.',
      'Revisar o runway toda semana até superar 6 meses.');
  }
  if (d.saldoDisponivel && piorSemana && piorSemana.saldo < 0) {
    add('Caixa', 'alto', 'Caixa negativo à vista',
      `Pelas contas lançadas no Omie, o saldo fica negativo na semana de ${piorSemana.semana}.`,
      `Pior saldo: ${moedaIns(piorSemana.saldo)}`,
      'Antecipar recebimentos ou renegociar vencimentos dessa semana.',
      'Olhar o fluxo de 12 semanas toda segunda-feira.');
  }
  if ((rec.participacao || 0) >= 0.6) {
    add('Receita', 'ok', 'Receita majoritariamente recorrente',
      `${pctIns(rec.participacao)} da receita dos últimos 12 meses veio de mensalidades (${moedaIns(rec.receita12)}).`,
      `${pctIns(rec.participacao)} recorrente`,
      'Proteger renovações e usar a base para vender expansão.',
      'Revisar mensalmente churn, renovações e upsell.');
  } else {
    add('Receita', 'medio', 'Receita ainda pouco previsível',
      `Apenas ${pctIns(rec.participacao)} da receita de 12 meses é recorrente. O restante depende de vendas pontuais.`,
      `${pctIns(rec.participacao)} recorrente`,
      'Empacotar serviços de implantação em ofertas com mensalidade.',
      'Medir a participação recorrente todo mês.');
  }
  if (varRec !== null && varRec < -0.05) {
    add('Receita', 'alto', 'A receita recorrente caiu',
      `A média de mensalidades passou de ${moedaIns(recAntMedia)} para ${moedaIns(recMedia3)} (${pctIns(varRec)}).`,
      `${pctIns(varRec)} na recorrência`,
      'Mapear contratos em risco e antecipar renovação dos maiores.',
      'Revisar semanalmente os contratos com renovação nos próximos 90 dias.');
  }
  if (gapMrr > Math.max(10000, Number(ctr.mrr || 0) * 0.05)) {
    add('Receita', 'oportunidade', 'Há MRR contratado sem virar caixa',
      `Contratos ativos somam ${moedaIns(ctr.mrr)}/mês, mas a recorrência realizada é ${moedaIns(rec.mensalMedia)}/mês. Há um gap de ${moedaIns(gapMrr)}/mês.`,
      `${moedaIns(gapMrr)}/mês de gap`,
      'Conciliar contratos ativos com o faturamento e cobrar serviços contratados sem nota.',
      'Mensalmente, reconciliar MRR contratado x faturado.');
  }
  if ((k.top1 || 0) > 0.3 && topCli) {
    add('Clientes', (k.top1 || 0) > 0.5 ? 'alto' : 'medio', 'Dependência do maior cliente',
      `${topCli.nome} representa ${pctIns(k.top1)} da receita dos últimos 12 meses.`,
      `${pctIns(k.top1)} em um cliente`,
      'Fechar ao menos um contrato novo de porte médio no trimestre.',
      'Revisar a concentração da carteira a cada trimestre.');
  }
  if (topProd && (topProd.participacao || 0) > 0.3) {
    add('Produtos', 'medio', 'Um produto concentra a receita',
      `${topProd.nome} responde por ${pctIns(topProd.participacao)} da receita de 12 meses (${moedaIns(topProd.valor)}).`,
      `${pctIns(topProd.participacao)} em um produto`,
      'Criar ofertas complementares e reduzir a dependência do produto principal.',
      'Revisar o mix de produtos todo trimestre.');
  }
  if (topDesp && topDespShare > 0.2) {
    add('Custos', 'medio', 'Uma despesa concentra o orçamento',
      `${topDesp.nome} representa ${pctIns(topDespShare)} das despesas dos últimos 12 meses.`,
      `${pctIns(topDespShare)} das despesas`,
      'Colocar a maior despesa em revisão e buscar ao menos uma alternativa de negociação.',
      'Revisar mensalmente as 5 maiores despesas.');
  }
  if (melhorMes && piorMes && melhorMes.mes !== piorMes.mes && comSaz.length >= 6) {
    add('Sazonalidade', 'oportunidade', 'O histórico tem meses mais fracos',
      `Pela média histórica, ${piorMes.nome} rende ${moedaIns(piorMes.resultado)} de resultado e ${melhorMes.nome} rende ${moedaIns(melhorMes.resultado)}.`,
      `Pior: ${piorMes.nome} · Melhor: ${melhorMes.nome}`,
      'Planejar contratações, férias e compras grandes fora dos meses fracos.',
      'Trimestralmente, revisar orçamento e metas contra a sazonalidade.');
  }
  if (vol12 > 0.25) {
    add('Previsibilidade', 'medio', 'A receita oscila bastante',
      `O desvio mensal é de ${pctIns(vol12)} em torno da média dos últimos 12 meses.`,
      `Oscilação de ${pctIns(vol12)}`,
      'Aumentar a parcela recorrente e formar reserva para os meses fracos.',
      'Acompanhar a volatilidade da receita todo mês.');
  }
  if (varYTD !== null && anoAnt.ano) {
    add('Receita', varYTD < 0 ? 'medio' : 'ok', `${anoAtual.ano || 'Ano atual'} vs ${anoAnt.ano}`,
      `Receita YTD de ${moedaIns(anoAtual.receita)} contra ${moedaIns(anoAnt.receita)} (${pctIns(varYTD)}). Resultado de ${moedaIns(anoAtual.resultado)} contra ${moedaIns(anoAnt.resultado)}.`,
      `${varYTD >= 0 ? '+' : ''}${pctIns(varYTD)} na receita`,
      varYTD < 0 ? 'Recuperar o ritmo de vendas e rever o orçamento do ano.' : 'Manter o ritmo e proteger a margem.',
      'Comparar o YTD com o mesmo período do ano anterior todo mês.');
  }

  const ordem = { alto: 0, medio: 1, oportunidade: 2, ok: 3 };
  const ordenados = insights.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
  const criticos = ordenados.filter(i => i.nivel === 'alto').length;
  const oportunidades = ordenados.filter(i => i.nivel === 'oportunidade').length;
  const resumo = `Em 12 meses, a competência fechou em ${moedaIns(comp.resultado)} e o caixa em ${moedaIns(caixa.resultado)}. ` +
    (atr.total ? `Há ${moedaIns(atr.total)} vencidos, ${pctIns(atrasoRatio)} da receita. ` : 'A carteira está em dia. ') +
    `A recorrência responde por ${pctIns(rec.participacao)} da receita.`;

  const acoes = [];
  const addAcao = (prioridade, titulo, porque, impacto, prazo) => acoes.push({ prioridade, titulo, porque, impacto, prazo });
  if (atr.total > 0) addAcao('Agora', 'Mutirão de cobrança', `São ${atr.qtd} títulos vencidos e ${pctIns(ratio90)} do saldo tem mais de 90 dias.`, `Recuperar até ${moedaIns(atr.total)}`, 'Esta semana');
  if (gapCaixa > 50000) addAcao('Agora', 'Antecipar recebíveis e renegociar prazos', `O caixa está ${moedaIns(gapCaixa)} atrás da competência nos últimos 12 meses.`, `Fechar gap de ${moedaIns(gapCaixa)}`, 'Este mês');
  if (margem3 !== null && margem3 < 0) addAcao('Agora', 'Plano para virar o resultado', `A operação queima ${moedaIns(-resMedia)} por mês, em média, nos últimos 3 meses.`, `Sair do negativo para o equilíbrio`, 'Este mês');
  if (k.runway !== undefined && k.runway !== null && k.runway < 6) addAcao('Agora', 'Plano de fôlego de caixa', `O saldo cobre apenas ${k.runway.toFixed(1)} meses no ritmo atual.`, 'Levar o runway para 6+ meses', 'Este mês');
  if (gapMrr > Math.max(10000, Number(ctr.mrr || 0) * 0.05)) addAcao('Este mês', 'Reconciliar contratos x faturamento', `Há ${moedaIns(gapMrr)}/mês de MRR contratado que não aparece na receita recorrente realizada.`, `Até ${moedaIns(gapMrr)}/mês`, '30 dias');
  if (varDespesa !== null && varReceita !== null && varDespesa > varReceita + 0.05) addAcao('Este mês', 'Revisar as maiores despesas', `A despesa variou ${pctIns(varDespesa)} contra ${pctIns(varReceita)} da receita no trimestre.`, 'Proteger a margem', '30 dias');
  if (atr.maiorDias > 180) addAcao('Este mês', 'Limpar a carteira antiga', `O título mais antigo tem ${atr.maiorDias} dias de atraso.`, 'Reduzir ruído e provisão', '30 dias');
  if ((k.top1 || 0) > 0.3) addAcao('Este trimestre', 'Plano de diversificação comercial', `O maior cliente representa ${pctIns(k.top1)} da receita.`, `Reduzir dependência de ${pctIns(k.top1)}`, '90 dias');
  if ((rec.participacao || 0) < 0.6) addAcao('Este trimestre', 'Empacotar ofertas recorrentes', `Só ${pctIns(rec.participacao)} da receita é recorrente.`, 'Aumentar previsibilidade', '90 dias');
  if (!acoes.length) addAcao('Contínuo', 'Manter a rotina de acompanhamento', 'Os principais indicadores estão sob controle.', 'Preservar caixa e margem', 'Contínuo');
  const ordemAcao = { Agora: 0, 'Este mês': 1, 'Este trimestre': 2, Contínuo: 3 };
  acoes.sort((a, b) => ordemAcao[a.prioridade] - ordemAcao[b.prioridade]);

  const comportamentos = [
    { frequencia: 'Semanal', titulo: 'Reunião de caixa de 30 minutos', descricao: 'Abrir saldo, recebíveis da semana, atrasados acima de 7 dias e pagamentos que vencem.' },
    { frequencia: 'Semanal', titulo: 'Régua de cobrança', descricao: 'D+1 lembrete, D+7 contato humano, D+15 negociação e D+30 escalação. Nada vencido fica sem próximo passo.' },
    { frequencia: 'Mensal', titulo: 'Fechamento competência x caixa', descricao: 'Comparar os dois regimes e explicar a diferença antes de comemorar qualquer resultado.' },
    { frequencia: 'Mensal', titulo: 'Revisão das 5 maiores despesas', descricao: 'Olhar variação, necessidade e alternativa de negociação para cada uma.' },
    { frequencia: 'Mensal', titulo: 'Conciliação de contratos e faturamento', descricao: 'Comparar o MRR contratado com as mensalidades efetivamente faturadas e cobradas.' },
    { frequencia: 'Trimestral', titulo: 'Preço, renovação e retenção', descricao: 'Revisar reajustes, contratos a vencer e clientes com risco de churn.' },
    { frequencia: 'Trimestral', titulo: 'Orçamento contra a sazonalidade', descricao: 'Planejar contratações e compras usando os meses fortes e fracos do histórico.' },
  ];

  return {
    geradoEm: new Date().toISOString(),
    resumo,
    criticos,
    oportunidades,
    insights: ordenados.slice(0, 12),
    acoes: acoes.slice(0, 6),
    comportamentos,
    sazonalidade,
    clientesAtraso,
  };
}

// ---------- Cálculo dos indicadores ----------
async function montarDados() {
  const [receber, pagar, clientes, categorias, contas, contratosOmie, baixasCR, baixasCP] = await Promise.all([
    listarTudo('financas/contareceber/', 'ListarContasReceber', 'conta_receber_cadastro'),
    listarTudo('financas/contapagar/', 'ListarContasPagar', 'conta_pagar_cadastro'),
    listarTudo('geral/clientes/', 'ListarClientesResumido', 'clientes_cadastro_resumido'),
    listarTudo('geral/categorias/', 'ListarCategorias', 'categoria_cadastro'),
    listarTudo('geral/contacorrente/', 'ListarResumoContasCorrentes', 'conta_corrente_lista').catch(() => []),
    listarTudo('servicos/contrato/', 'ListarContratos', 'contratoCadastro').catch(() => []),
    listarBaixas('CR').catch(() => ({})),
    listarBaixas('CP').catch(() => ({})),
  ]);

  const nomeCli = Object.fromEntries(clientes.map(c => [c.codigo_cliente, c.nome_fantasia || c.razao_social]));
  const nomeCat = Object.fromEntries(categorias.map(c => [c.codigo, c.descricao]));
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);

  const baixasDe = t => {
    const lista = [];
    for (const v of [t.recebimento, t.pagamento]) {
      if (!v) continue;
      if (Array.isArray(v)) lista.push(...v);
      else if (typeof v === 'object') {
        if (v.data || v.data_pagamento || v.data_baixa || v.data_recebimento) lista.push(v);
        else lista.push(...Object.values(v).filter(x => x && typeof x === 'object'));
      }
    }
    return lista.map(b => ({
      data: dt(b.data || b.data_pagamento || b.data_baixa || b.data_recebimento),
      valor: Number(b.valor || b.valor_pago || b.valor_recebido || 0),
    })).filter(b => b.data);
  };
  const norm = (t, tipo, baixasMap = {}) => {
    const valor = Number(t.valor_documento || 0);
    const status = (t.status_titulo || '').toUpperCase();
    const baixas = baixasMap[String(t.codigo_lancamento_omie)] || baixasDe(t);
    const pagamento = baixas.length
      ? new Date(Math.max(...baixas.map(b => +b.data)))
      : dt(t.data_pagamento) || dt(t.data_baixa);
    const somaBaixas = baixas.reduce((a, b) => a + (b.valor || 0), 0);
    const liquidado = status === 'RECEBIDO' || status === 'PAGO' || status === 'LIQUIDADO';
    const valorPago = baixas.length ? (somaBaixas || valor) : (liquidado ? valor : 0);
    return {
      tipo,
      valor,
      valorPago,
      baixas,
      venc: dt(t.data_vencimento),
      pagamento,
      emissao: dt(t.data_emissao) || dt(t.data_previsao) || dt(t.data_registro) || dt(t.data_vencimento),
      competencia: dt(t.data_emissao) || dt(t.data_registro),
      status,
      categoria: nomeCat[t.codigo_categoria] || t.codigo_categoria || 'Sem categoria',
      parceiro: nomeCli[t.codigo_cliente_fornecedor] || 'Não identificado',
      descricao: [t.descricao, t.observacao].filter(Boolean).map(x => String(x).trim()).filter(Boolean).join(' · '),
      codigo: String(t.codigo_lancamento_omie ?? t.codigo_lancamento_integracao ?? ''),
      documento: String(t.numero_documento ?? ''),
    };
  };
  const R = receber.map(t => norm(t, 'R', baixasCR)).filter(t => t.status !== 'CANCELADO' && t.venc);
  const P = pagar.map(t => norm(t, 'P', baixasCP)).filter(t => t.status !== 'CANCELADO' && t.venc);
  const quitado = t => t.status === 'RECEBIDO' || t.status === 'PAGO' || t.status === 'LIQUIDADO';
  const aberto = t => !quitado(t);
  const iso = d => d ? d.toISOString().slice(0, 10) : '';
  const lancamentos = [...R, ...P].map(t => ({
    id: t.codigo,
    tipo: t.tipo === 'R' ? 'receita' : 'despesa',
    status: t.status,
    descricao: t.descricao || t.parceiro || '(sem descrição)',
    parceiro: t.parceiro,
    categoria: t.categoria,
    documento: t.documento,
    valor: t.valor,
    valorPago: t.valorPago,
    baixas: (t.baixas || []).map(b => ({ data: iso(b.data), valor: b.valor })),
    emissao: iso(t.emissao),
    competencia: iso(t.competencia),
    vencimento: iso(t.venc),
    pagamento: iso(t.pagamento),
    diasAtraso: aberto(t) && t.venc < hoje ? Math.max(0, Math.round((hoje - t.venc) / 864e5)) : 0,
  })).sort((a, b) => (b.pagamento || b.vencimento || b.emissao || '').localeCompare(a.pagamento || a.vencimento || a.emissao || ''));

  // Série mensal (24 meses) — 12 para o painel, 24 para o CFO
  const meses24 = [];
  for (let i = 23; i >= 0; i--) meses24.push(mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)));
  const somaNoMes = (lista, m) => soma(lista.filter(t => quitado(t) && mesKey(t.venc) === m).map(t => t.valor));
  const serieMensal = meses24.map(m => {
    const receita = somaNoMes(R, m), despesa = somaNoMes(P, m);
    return { mes: m, receita, despesa, resultado: receita - despesa, margem: receita ? (receita - despesa) / receita : null };
  });
  // Competência: tudo que foi emitido no mês, pago ou não
  const somaCompNoMes = (lista, m) => soma(lista.filter(t => t.emissao && mesKey(t.emissao) === m).map(t => t.valor));
  const compMensal = meses24.map(m => {
    const receita = somaCompNoMes(R, m), despesa = somaCompNoMes(P, m);
    return { mes: m, receita, despesa, resultado: receita - despesa, margem: receita ? (receita - despesa) / receita : null };
  });
  const ult12 = serieMensal.slice(-12);
  const competencia = compMensal.slice(-12);
  const meses = ult12.map(x => x.mes);
  const entradas = ult12.map(x => x.receita), saidas = ult12.map(x => x.despesa);
  const resultado = ult12.map(x => x.resultado);

  // Panorama do ano: YTD e mesmo período do ano anterior
  const mesesYTD = hoje.getMonth() + 1;
  const panoramaAno = (ano, meses) => {
    const noPeriodo = lista => lista.filter(t => quitado(t) && t.venc.getFullYear() === ano && t.venc.getMonth() < meses);
    const receita = soma(noPeriodo(R).map(t => t.valor));
    const despesa = soma(noPeriodo(P).map(t => t.valor));
    return { ano, meses, receita, despesa, resultado: receita - despesa, margem: receita ? (receita - despesa) / receita : null, mediaReceita: receita / meses, mediaDespesa: despesa / meses };
  };
  const ano = { atual: panoramaAno(hoje.getFullYear(), mesesYTD), anterior: panoramaAno(hoje.getFullYear() - 1, mesesYTD) };
  const panoramaComp = (ano, meses) => {
    const noPeriodo = lista => lista.filter(t => t.emissao && t.emissao.getFullYear() === ano && t.emissao.getMonth() < meses);
    const receita = soma(noPeriodo(R).map(t => t.valor));
    const despesa = soma(noPeriodo(P).map(t => t.valor));
    return { ano, meses, receita, despesa, resultado: receita - despesa, margem: receita ? (receita - despesa) / receita : null };
  };
  const anoCompetencia = { atual: panoramaComp(hoje.getFullYear(), mesesYTD), anterior: panoramaComp(hoje.getFullYear() - 1, mesesYTD) };
  // Caixa efetivo: usa a data de pagamento/recebimento quando o Omie informa.
  const pagoEm = t => t.pagamento || t.venc;
  const panoramaCaixa = (ano, meses) => {
    const noPeriodo = lista => lista.filter(t => quitado(t) && pagoEm(t) && pagoEm(t).getFullYear() === ano && pagoEm(t).getMonth() < meses);
    const receita = soma(noPeriodo(R).map(t => t.valor));
    const despesa = soma(noPeriodo(P).map(t => t.valor));
    return { ano, meses, receita, despesa, resultado: receita - despesa, margem: receita ? (receita - despesa) / receita : null };
  };
  const anoCaixa = { atual: panoramaCaixa(hoje.getFullYear(), mesesYTD), anterior: panoramaCaixa(hoje.getFullYear() - 1, mesesYTD) };

  // Médias dos últimos 3 meses fechados
  const ult3 = a => soma(a.slice(-4, -1)) / 3;
  const receitaMedia = ult3(entradas), despesaMedia = ult3(saidas);

  // Em aberto
  const atrasadoR = R.filter(t => aberto(t) && t.venc < hoje);
  const diasDe = t => Math.max(0, Math.round((hoje - t.venc) / 864e5));
  const atrasadoP = P.filter(t => aberto(t) && t.venc < hoje);
  const janela = (lista, dias) => soma(lista.filter(t => aberto(t) && t.venc >= hoje && t.venc <= new Date(hoje.getTime() + dias * 864e5)).map(t => t.valor));

  // Caixa total: contas correntes do Omie + valor aplicado informado no contexto.
  const saldoOmie = soma(contas.map(c => Number(c.saldo_atual ?? c.nSaldo ?? 0)));
  const caixaAplicado = caixaAplicadoContexto();
  const saldo = saldoOmie + caixaAplicado;
  const saldoDisponivel = contas.length > 0 || caixaAplicado > 0;

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

  // Composição completa das despesas do ano (caixa) e leitura específica de rescisões.
  const agrupaDetalhado = (lista, campo) => {
    const m = {};
    lista.forEach(t => {
      const nome = t[campo] || 'Sem categoria';
      if (!m[nome]) m[nome] = { valor: 0, qtd: 0 };
      m[nome].valor += t.valor;
      m[nome].qtd++;
    });
    return Object.entries(m).map(([nome, v]) => ({ nome, valor: v.valor, qtd: v.qtd })).sort((a, b) => b.valor - a.valor);
  };
  const anoAtual = hoje.getFullYear();
  const pagosAnoP = P.filter(t => quitado(t) && pagoEm(t) && pagoEm(t).getFullYear() === anoAtual);
  const despesasAno = {
    ano: anoAtual,
    base: 'data de pagamento; quando ausente, data de vencimento',
    total: soma(pagosAnoP.map(t => t.valor)),
    categorias: agrupaDetalhado(pagosAnoP, 'categoria'),
  };
  const RE_RESCISAO = /rescis|verbas rescis|multa.*fgts|fgts.*multa|aviso pr[eé]vio|indeniza|desligamento|demiss/i;
  const ehDespesaRescisoria = t => RE_RESCISAO.test(t.categoria || '') || RE_RESCISAO.test(t.descricao || '');
  const rescisoesP = pagosAnoP.filter(ehDespesaRescisoria);
  const fgtsP = pagosAnoP.filter(t => /fgts/i.test(t.categoria || ''));
  const rescisoes = {
    ano: anoAtual,
    total: soma(rescisoesP.map(t => t.valor)),
    quantidade: rescisoesP.length,
    porMes: Array.from({ length: mesesYTD }, (_, i) => {
      const mes = `${anoAtual}-${String(i + 1).padStart(2, '0')}`;
      return { mes, valor: soma(rescisoesP.filter(t => mesKey(pagoEm(t)) === mes).map(t => t.valor)) };
    }).filter(x => x.valor > 0),
    categorias: agrupaDetalhado(rescisoesP, 'categoria'),
    itens: rescisoesP.slice().sort((a, b) => pagoEm(b) - pagoEm(a)).slice(0, 40).map(t => ({
      fornecedor: t.parceiro,
      descricao: t.descricao || '(sem descrição)',
      categoria: t.categoria,
      valor: t.valor,
      data: pagoEm(t).toLocaleDateString('pt-BR'),
    })),
    fgtsTotal: soma(fgtsP.map(t => t.valor)),
    fgtsCategorias: agrupaDetalhado(fgtsP, 'categoria'),
    observacao: rescisoesP.length
      ? 'Valores localizados por categoria ou descrição contendo rescisão, verbas rescisórias, multa de FGTS, aviso prévio, indenização ou desligamento.'
      : 'Nenhum título pago no ano teve categoria ou descrição com palavras-chave de rescisão. O total pode estar diluído em Salários ou FGTS e não é separável pelos dados atuais.',
  };
  const somaSerie = s => ({ receita: soma(s.map(x => x.receita)), despesa: soma(s.map(x => x.despesa)), resultado: soma(s.map(x => x.resultado)) });
  const caixa12 = somaSerie(ult12);
  const comp12 = somaSerie(competencia);
  const regimes = {
    caixa: { ...caixa12, margem: caixa12.receita ? caixa12.resultado / caixa12.receita : null, serie: ult12 },
    competencia: { ...comp12, margem: comp12.receita ? comp12.resultado / comp12.receita : null, serie: competencia, ano: anoCompetencia },
    diferenca: { receita: comp12.receita - caixa12.receita, despesa: comp12.despesa - caixa12.despesa, resultado: comp12.resultado - caixa12.resultado },
  };

  // Receita por produto (categorias do Omie) e recorrência (categorias de mensalidade)
  const ehRecorrente = nome => /mensalidade/i.test(nome || '');
  const produtosRank = agrupa(R, 'categoria');
  const produtosReceita = produtosRank.map(p => ({
    nome: p.nome, valor: p.valor, participacao: p.valor / (receita12 || 1),
    recorrente: ehRecorrente(p.nome), mediaMensal: p.valor / 12,
  }));
  const recProdutos = produtosReceita.filter(p => p.recorrente);
  const receitaRecorrente12 = soma(recProdutos.map(p => p.valor));
  const serieRecorrente = ult12.map(x => {
    const [ano, mes] = x.mes.split('-').map(Number);
    const ini = new Date(ano, mes - 1, 1), fim = new Date(ano, mes, 1);
    const rec = soma(R.filter(t => quitado(t) && t.venc >= ini && t.venc < fim && ehRecorrente(t.categoria)).map(t => t.valor));
    return { mes: x.mes, recorrente: rec, naoRecorrente: x.receita - rec };
  });
  const recUltimo = serieRecorrente[serieRecorrente.length - 1]?.recorrente || 0;
  const recAnterior = serieRecorrente[serieRecorrente.length - 2]?.recorrente || 0;
  const ctrAtivos = contratosOmie.filter(c => (c.cabecalho || {}).cCodSit === '10');
  const mrrContratado = soma(ctrAtivos.map(c => Number((c.cabecalho || {}).nValTotMes || 0)));
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
  if (runway !== null) {
    const folego = runway < 1 ? 'menos de 1 mês' : `${runway.toFixed(1)} meses`;
    alertas.push({ nivel: runway < 6 ? 'alto' : runway < 12 ? 'medio' : 'ok', titulo: `Fôlego de caixa: ${folego}`, texto: `Se nada mudar, o saldo atual dura ${folego}. Abaixo de 6 meses é zona de atenção para uma empresa investida.` });
  }
  if (top1 > 0.3) alertas.push({ nivel: top1 > 0.5 ? 'alto' : 'medio', titulo: 'Dependência de um cliente', texto: `${clientesRank[0].nome} representa ${(top1 * 100).toFixed(0)}% da receita dos últimos 12 meses. Se esse cliente atrasar ou sair, o impacto é direto no caixa.` });
  const totAtrasoR = soma(atrasadoR.map(t => t.valor));
  if (totAtrasoR > 0) alertas.push({ nivel: totAtrasoR > receitaMedia * 0.5 ? 'alto' : 'medio', titulo: `${brl(totAtrasoR)} para receber em atraso`, texto: `São ${atrasadoR.length} títulos vencidos. Cobrar isso é o dinheiro mais barato que a empresa pode conseguir.` });
  const piorSemana = semanas.reduce((a, b) => (b.saldo < a.saldo ? b : a), semanas[0]);
  if (saldoDisponivel && piorSemana && piorSemana.saldo < 0) alertas.push({ nivel: 'alto', titulo: 'Caixa negativo à vista', texto: `Pelas contas lançadas no Omie, o saldo fica negativo na semana de ${piorSemana.semana}. Antecipe recebimentos ou renegocie pagamentos.` });

  const data = {
    atualizadoEm: new Date().toISOString(),
    saldo, saldoOmie, caixaAplicado, saldoDisponivel,
    caixa: { omie: saldoOmie, aplicado: caixaAplicado, total: saldo },
    kpis: {
      receitaMedia, despesaMedia, resultadoMedio: receitaMedia - despesaMedia, margem, burn, runway,
      receber30: janela(R, 30), pagar30: janela(P, 30),
      atrasadoReceber: totAtrasoR, atrasadoPagar: soma(atrasadoP.map(t => t.valor)),
      top1, top3, receita12,
    },
    meses, entradas, saidas, resultado, semanas, serieMensal, ano, anoCaixa,
    clientes: clientesRank.slice(0, 8),
    despesas: despesasCat.slice(0, 8),
    despesas12m: despesasCat,
    despesasAno,
    rescisoes,
    lancamentos,
    produtosReceita: produtosReceita.slice(0, 12),
    contratos: { total: contratosOmie.length, ativos: ctrAtivos.length, mrr: mrrContratado, arr: mrrContratado * 12 },
    recorrente: {
      receita12: receitaRecorrente12,
      participacao: receitaRecorrente12 / (receita12 || 1),
      mensalMedia: receitaRecorrente12 / 12,
      ultimoMes: recUltimo,
      mesAnterior: recAnterior,
      variacaoMes: recAnterior ? (recUltimo - recAnterior) / recAnterior : null,
      naoRecorrente12: receita12 - receitaRecorrente12,
      serie: serieRecorrente,
      produtos: recProdutos.slice(0, 8),
    },
    competencia, regimes,
    atrasados: atrasadoR.slice().sort((a, b) => b.valor - a.valor).slice(0, 10).map(t => ({ cliente: t.parceiro, valor: t.valor, venc: t.venc.toLocaleDateString('pt-BR'), dias: diasDe(t) })),
    atrasadosTodos: atrasadoR.slice().sort((a, b) => b.valor - a.valor).map(t => ({ cliente: t.parceiro, categoria: t.categoria, valor: t.valor, venc: t.venc.toLocaleDateString('pt-BR'), dias: diasDe(t) })),
    atrasadosResumo: (() => {
      const faixas = [[1, 30], [31, 60], [61, 90], [91, 99999]];
      const buckets = faixas.map(([de, ate]) => {
        const l = atrasadoR.filter(t => { const d = diasDe(t); return d >= de && d <= ate; });
        return { faixa: de === 91 ? '90+ dias' : `${de} a ${ate} dias`, qtd: l.length, valor: soma(l.map(t => t.valor)) };
      });
      return { qtd: atrasadoR.length, total: totAtrasoR, maiorDias: atrasadoR.length ? Math.max(...atrasadoR.map(diasDe)) : 0, mediaDias: atrasadoR.length ? Math.round(soma(atrasadoR.map(diasDe)) / atrasadoR.length) : 0, buckets };
    })(),
    alertas,
  };
  data.insights = montarInsights(data);
  return data;
}

let cache = { at: 0, data: null };
async function dados(force) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MIN * 60e3) return cache.data;
  cache = { at: Date.now(), data: await montarDados() };
  return cache.data;
}

// ---------- Insights estratégicos semanais (IA) ----------
const INSIGHTS_FILE = path.join(process.env.TMPDIR || '/tmp', 'startgi-insights.json');
let insightsCache = { at: 0, data: null, gerando: null };
try {
  const salvo = JSON.parse(fs.readFileSync(INSIGHTS_FILE, 'utf8'));
  if (salvo && salvo.data) insightsCache = { at: Number(salvo.at || 0), data: salvo.data, gerando: null };
} catch {}

function montarContextoIA(d) {
  const k = d.kpis || {}, r = d.recorrente || {}, ct = d.contratos || {}, atr = d.atrasadosResumo || {}, resc = d.rescisoes || {};
  const serie = s => (s || []).slice(-12).map(x => ({ mes: x.mes, receita: x.receita, despesa: x.despesa, resultado: x.resultado }));
  const reg = d.regimes || {}, cx = reg.caixa || {}, cp = reg.competencia || {};
  return {
    caixa: { total: d.saldo, omie: d.saldoOmie, aplicado: d.caixaAplicado, disponivel: d.saldoDisponivel, saldoOmie: d.caixa?.saldoOmie, saldoAplicado: d.caixa?.aplicado },
    kpis: { receber30: k.receber30, pagar30: k.pagar30, queimaMensal: k.queimaMensal, runwayMeses: k.runwayMeses },
    ano: d.ano, anoCaixa: d.anoCaixa,
    caixa12m: { receita: cx.receita, despesa: cx.despesa, resultado: cx.resultado, margem: cx.margem, serie: serie(cx.serie) },
    competencia12m: { receita: cp.receita, despesa: cp.despesa, resultado: cp.resultado, margem: cp.margem, serie: serie(cp.serie) },
    diferencaRegime: reg.diferenca,
    despesasAno: { total: d.despesasAno?.total, categorias: (d.despesasAno?.categorias || []).slice(0, 20) },
    rescisoes: { ano: resc.ano, total: resc.total, porMes: resc.porMes, itens: (resc.itens || []).slice(0, 8) },
    clientes: (d.clientes || []).slice(0, 8),
    atrasados: { total: atr.total, qtd: atr.qtd, maiorDias: atr.maiorDias, mediaDias: atr.mediaDias, buckets: atr.buckets, maiores: (d.atrasadosTodos || []).slice(0, 10) },
    produtos: (d.produtosReceita || []).slice(0, 8),
    recorrente: { receita12: r.receita12, mensalMedia: r.mensalMedia, participacao: r.participacao, naoRecorrente12: r.naoRecorrente12 },
    contratos: { ativos: ct.ativos, mrr: ct.mrr, arr: ct.arr, total: ct.total },
    alertas: (d.alertas || []).slice(0, 6),
  };
}

function montarCobrancaFallback(d) {
  const atr = d.atrasadosResumo || {};
  const clientes = (d.insights && d.insights.clientesAtraso) || [];
  const maior = clientes[0];
  const publico = (d.atrasadosTodos || []).filter(t => /prefeitura|municip|governo|secretaria|estado|federal/i.test(t.cliente || ''));
  const plays = [];
  if (atr.total > 0) {
    plays.push({
      publico: maior ? `${maior.cliente} e demais vencidos` : 'Carteira vencida',
      situacao: `${atr.qtd || 0} títulos e ${moedaIns(atr.total)} vencidos${maior ? `; maior devedor: ${moedaIns(maior.total)}` : ''}.`,
      estrategia: 'Novação com entrada e garantia',
      abordagem: 'Mesa de negociação com quem decide: entrada de 20% a 30%, saldo em até 6x e garantia pessoal, aval ou recebível como lastro. O serviço ou a entrega fica condicionado ao cumprimento do acordo.',
      porque: 'Troca desconto por prazo e garantia, em vez de repetir lembretes de cobrança.',
      impacto: `Recuperação potencial de até ${moedaIns(atr.total)}, com menos desgaste comercial.`,
    });
    plays.push({
      publico: 'Carteira acima de 60 dias',
      situacao: `O saldo antigo representa ${moedaIns(atr.total)} e perde valor a cada mês parado.`,
      estrategia: 'Desconto condicionado à quitação à vista',
      abordagem: 'Oferecer desconto apenas para pagamento imediato, com validade curta e aprovação por alçada. Em paralelo, avaliar cessão de crédito ou antecipação com o banco para transformar o recebível em caixa.',
      porque: 'Cria um incentivo econômico real para o devedor priorizar a StartGi e reduz o custo de oportunidade do caixa parado.',
      impacto: 'Acelera a conversão da carteira antiga em caixa sem renegociar todo o contas a receber.',
    });
    plays.push({
      publico: publico.length ? 'Clientes públicos' : 'Contratos com maior valor',
      situacao: publico.length ? `Há ${publico.length} lançamentos ligados a entes públicos na carteira vencida.` : 'Os maiores saldos estão concentrados nos contratos de maior valor.',
      estrategia: publico.length ? 'Ofício ao gestor e retenção de marcos' : 'Quebra de escopo e marcos de entrega',
      abordagem: publico.length ? 'Formalizar ofício ao gestor do contrato com medição, empenho e cronograma de pagamento; alinhar retenção de novas entregas ao recebimento e avaliar garantia contratual.' : 'Vincular a próxima entrega a um marco de pagamento, revisar o cronograma e suspender expansões até o recebível entrar.',
      porque: 'Ataca a causa do atraso no ponto onde a StartGi ainda tem alavancagem contratual.',
      impacto: 'Reduz a exposição sem depender apenas de cobrança administrativa.',
    });
  }
  plays.push({
    publico: 'Prevenção da próxima carteira',
    situacao: 'A empresa tem receita concentrada e precisa proteger o caixa contra novos atrasos.',
    estrategia: 'Blindagem contratual e seguro de crédito',
    abordagem: 'Padronizar cláusula de suspensão, garantia, conta escrow para contratos grandes e seguro de crédito para os maiores nomes. Para contratos públicos, trabalhar com empenho e cronograma de medição desde a assinatura.',
    porque: 'O ganho maior está em não repetir o problema, não em cobrar mais rápido depois que ele acontece.',
    impacto: 'Menor volatilidade de caixa e mais previsibilidade para o runway.',
  });
  return plays.slice(0, 4);
}

function fallbackInsights(d, motivo) {
  const base = (d && d.insights) || {};
  const prioridade = n => n === 'alto' ? 'alta' : n === 'medio' ? 'media' : 'baixa';
  const acao = (base.acoes || [])[0];
  return {
    geradoEm: new Date().toISOString(),
    proximaEm: new Date(Date.now() + INSIGHTS_MIN * 60e3).toISOString(),
    fonte: 'regras',
    modelo: null,
    aviso: motivo ? `Leitura gerada por regras porque a IA não respondeu: ${motivo}` : 'Leitura gerada por regras.',
    resumo: base.resumo || 'Ainda não há dados suficientes para uma leitura estratégica.',
    focoSemana: acao ? { titulo: acao.titulo, acao: acao.acao || acao.titulo, porque: acao.porque } : { titulo: 'Organizar o caixa da semana', acao: 'Fechar a agenda de caixa e recebíveis.', porque: 'Sem dados suficientes para uma prioridade mais específica.' },
    insights: (base.insights || []).slice(0, 3).map(i => ({
      area: i.tema, prioridade: prioridade(i.nivel), titulo: i.titulo,
      diagnostico: i.leitura, implicacao: i.numero, acao: i.acao, impacto: '', prazo: i.comportamento,
      metrica: i.comportamento || 'Acompanhar a evolução do indicador na reunião semanal.', dono: 'CEO e liderança da área.',
    })),
    cobranca: montarCobrancaFallback(d || {}),
  };
}

async function gerarInsightsIA(d) {
  if (!AI_KEY) return fallbackInsights(d, 'COMMANDCODE_API_KEY não configurada');
  const dadosIA = montarContextoIA(d);
  const system = `Você é o CFO de crescimento da StartGi Tecnologia (GovTech/B2B, ~25 pessoas, investida pelo FIP GovTech). Seu cliente é o CEO, Juliano. Hoje é ${new Date().toISOString().slice(0, 10)}.

Sua missão é dizer onde colocar energia e capital para a StartGi crescer receita recorrente com margem. Isto não é um painel de alertas nem uma lista de cobrança. Toda leitura deve responder: onde crescer, como crescer, o que parar e qual métrica prova progresso.

Regras:
- Trate caixa como combustível e restrição de timing, não como tese central. Recebíveis e atraso podem aparecer no máximo em 1 insight e nunca devem ser o foco da semana.
- Priorize crescimento: expansão na base, pricing, mix de produtos, novos canais, retenção, produtividade comercial e custo de servir. Vender é necessário, mas diga onde, para quem e com qual oferta.
- Não invente números. Use apenas os dados fornecidos. Use sempre o caixa total (contas Omie + aplicado) quando falar de capacidade de investimento.
- Gere exatamente 3 apostas fortes, distintas e acionáveis. Cada uma deve ter uma tese, o trade-off e um movimento claro. Nada de "vender mais", "reduzir custos", "melhorar processos" ou diagnóstico sem consequência.
- Em "acao", escreva 2 ou 3 passos concretos, em ordem, separados por ponto e vírgula.
- Em "metrica", defina um indicador leading mensurável e uma meta de direção. Em "dono", indique quem lidera (CEO, Comercial, Produto, CS, Financeiro).
- Em "resumo", escreva 2 frases curtas: a tese da semana e o principal trade-off.
- Em "focoSemana", resuma o único movimento mais alavancador da semana, com uma ação de crescimento, não de cobrança.
- Em "cobranca", no máximo 3 estratégias de engenharia de recebimento, como apoio de caixa: novação com garantia, entrada, cessão de crédito, antecipação, escrow, seguro de crédito, retenção de marcos ou proteção contratual.
- Se rescisões forem relevantes, use rescisoes.total, rescisoes.porMes e rescisoes.itens.
- Responda SOMENTE com JSON válido, sem markdown e sem cercas de código.

Formato:
{
  "resumo": "2 frases curtas com a tese e o trade-off da semana.",
  "focoSemana": {"titulo": "...", "acao": "...", "porque": "..."},
  "cobranca": [{"publico": "...", "situacao": "...", "estrategia": "...", "abordagem": "...", "porque": "...", "impacto": "..."}],
  "insights": [{"area": "Receita|Crescimento|Clientes|Produto|Pricing|Canais|Custos|Pessoas|Caixa", "prioridade": "alta|media|baixa", "titulo": "...", "diagnostico": "...", "implicacao": "...", "acao": "...", "metrica": "...", "dono": "...", "impacto": "...", "prazo": "..."}]
}

DADOS: ${JSON.stringify(dadosIA)}`;
  let texto = '';
  let j = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    texto = await chamarIA(
      system + (tentativa > 1 ? '\n\nATENÇÃO: a tentativa anterior não veio em JSON. Responda agora SOMENTE com o objeto JSON, começando por { e terminando em }.' : ''),
      [{ role: 'user', content: 'Gere a leitura estratégica desta semana no JSON pedido. Responda somente com JSON.' }],
      8000,
      INSIGHTS_MODEL
    );
    const m = String(texto || '').match(/\{[\s\S]*\}/);
    if (m) {
      try { j = JSON.parse(m[0]); break; } catch (e) { console.error('[insights] JSON inválido:', e.message, String(texto).slice(0, 300)); }
    } else {
      console.error('[insights] resposta sem JSON:', String(texto || '').slice(0, 300), 'len=', String(texto || '').length);
    }
  }
  if (!j) throw new Error('a IA não retornou JSON: ' + String(texto || '').slice(0, 160));
  const limpa = v => String(v ?? '').trim().slice(0, 1200);
  const pega = (o, ...chaves) => { for (const k of chaves) { const v = o?.[k]; if (v !== undefined && v !== null && String(v).trim()) return v; } return ''; };
  const lista = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
  const normPrio = v => { const p = String(v || '').toLowerCase(); return /alta|high|urgente/.test(p) ? 'alta' : /baixa|low/.test(p) ? 'baixa' : 'media'; };
  const insights = lista(j.insights).slice(0, 3).map(i => ({
    area: limpa(pega(i, 'area', 'tema', 'categoria') || 'Estratégia'), prioridade: normPrio(pega(i, 'prioridade', 'nivel', 'urgencia')),
    titulo: limpa(pega(i, 'titulo', 'título', 'title')), diagnostico: limpa(pega(i, 'diagnostico', 'diagnóstico', 'leitura', 'contexto')),
    implicacao: limpa(pega(i, 'implicacao', 'implicação', 'numero', 'número', 'dado')), acao: limpa(pega(i, 'acao', 'ação', 'action', 'movimento', 'recomendacao', 'recomendação')),
    impacto: limpa(pega(i, 'impacto', 'resultado', 'efeito')), prazo: limpa(pega(i, 'prazo', 'horizonte', 'quando')),
    metrica: limpa(pega(i, 'metrica', 'métrica', 'kpi', 'indicador', 'meta')), dono: limpa(pega(i, 'dono', 'responsavel', 'responsável', 'owner', 'lider')),
  })).filter(i => i.titulo && i.acao);
  if (!insights.length) throw new Error('a IA não retornou insights utilizáveis: ' + JSON.stringify(j).slice(0, 500));
  const cobranca = lista(j.cobranca || j.recebimento || j.planoRecebimento || j.collection).slice(0, 3).map(c => {
    const est = limpa(pega(c, 'estrategia', 'estratégia', 'movimento', 'acao', 'ação', 'recomendacao', 'recomendação', 'titulo', 'título'));
    const ab = limpa(pega(c, 'abordagem', 'como', 'plano', 'detalhe', 'execucao', 'execução')) || est;
    return {
      publico: limpa(pega(c, 'publico', 'público', 'cliente', 'devedor', 'grupo')), situacao: limpa(pega(c, 'situacao', 'situação', 'contexto', 'problema')),
      estrategia: est || ab, abordagem: ab, porque: limpa(pega(c, 'porque', 'porquê', 'justificativa', 'motivo', 'razao', 'razão')),
      impacto: limpa(pega(c, 'impacto', 'resultado', 'efeito', 'ganho')),
    };
  }).filter(c => c.estrategia && c.abordagem);
  return {
    geradoEm: new Date().toISOString(),
    proximaEm: new Date(Date.now() + INSIGHTS_MIN * 60e3).toISOString(),
    fonte: 'ia',
    modelo: INSIGHTS_MODEL,
    resumo: limpa(j.resumo),
    focoSemana: {
      titulo: limpa(j.focoSemana?.titulo || insights[0].titulo),
      acao: limpa(j.focoSemana?.acao || insights[0].acao),
      porque: limpa(j.focoSemana?.porque || insights[0].diagnostico),
    },
    insights,
    cobranca: cobranca.length ? cobranca : montarCobrancaFallback(d),
  };
}

async function obterInsightsSemanais(force = false) {
  const valido = insightsCache.data && Date.now() - insightsCache.at < INSIGHTS_MIN * 60e3;
  if (!force && valido) return insightsCache.data;
  if (insightsCache.gerando) return insightsCache.gerando;
  const prom = (async () => {
    let out;
    try {
      const d = await dados();
      out = await gerarInsightsIA(d);
    } catch (e) {
      console.error('[insights] IA falhou:', e.message);
      try {
        const d = await dados();
        out = fallbackInsights(d, e.message);
      } catch (e2) {
        out = { geradoEm: new Date().toISOString(), proximaEm: new Date(Date.now() + INSIGHTS_MIN * 60e3).toISOString(), fonte: 'erro', resumo: 'Não foi possível gerar a leitura semanal.', insights: [], cobranca: [], aviso: e2.message };
      }
    }
    insightsCache = { at: Date.now(), data: out, gerando: null };
    try { fs.writeFileSync(INSIGHTS_FILE, JSON.stringify(insightsCache)); } catch {}
    return out;
  })();
  insightsCache.gerando = prom;
  try { return await prom; } finally { if (insightsCache.gerando === prom) insightsCache.gerando = null; }
}

app.get('/api/insights', async (req, res) => {
  try {
    const data = await obterInsightsSemanais(req.query.atualizar === '1');
    res.json({ ...data, intervaloAtualizacaoMin: INSIGHTS_MIN });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/contexto', (req, res) => {
  res.json({ contexto: contextoEmpresa() });
});

app.get('/api/dados', async (req, res) => {
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) return res.status(500).json({ erro: 'Configure OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.' });
  try {
    const d = await dados(req.query.atualizar === '1');
    const { lancamentos, ...publico } = d;
    res.json({ ...publico, intervaloAtualizacaoMin: REFRESH_MIN, proximaAtualizacao: REFRESH_MIN > 0 ? new Date(cache.at + REFRESH_MIN * 60e3).toISOString() : null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function filtrarLancamentos(d, q = {}) {
  const base = ['vencimento', 'pagamento', 'emissao'].includes(q.base) ? q.base : 'vencimento';
  const tipo = String(q.tipo || '').toLowerCase();
  const status = String(q.status || '').toUpperCase();
  const categoria = String(q.categoria || '');
  const de = String(q.de || '');
  const ate = String(q.ate || '');
  const texto = String(q.q || '').trim().toLowerCase();
  return (d.lancamentos || []).filter(l => {
    if (tipo && l.tipo !== tipo) return false;
    if (status && l.status !== status) return false;
    if (categoria && l.categoria !== categoria) return false;
    const data = l[base] || '';
    if (de && data < de) return false;
    if (ate && data > ate) return false;
    if (texto && !`${l.descricao} ${l.parceiro} ${l.categoria} ${l.documento}`.toLowerCase().includes(texto)) return false;
    return true;
  });
}

function metaLancamentos(d) {
  return {
    categorias: [...new Set((d.lancamentos || []).map(l => l.categoria))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    status: [...new Set((d.lancamentos || []).map(l => l.status))].filter(Boolean).sort(),
  };
}

app.get('/api/lancamentos', async (req, res) => {
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) return res.status(500).json({ erro: 'Configure OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.' });
  try {
    const d = await dados();
    const itens = filtrarLancamentos(d, req.query);
    const total = itens.length;
    const limite = Math.min(1000, Math.max(20, Number(req.query.limite) || 100));
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const resumo = itens.reduce((a, l) => { a[l.tipo] += Number(l.valor || 0); return a; }, { receita: 0, despesa: 0 });
    resumo.saldo = resumo.receita - resumo.despesa;
    res.json({ total, pagina, limite, resumo, itens: itens.slice((pagina - 1) * limite, pagina * limite), ...metaLancamentos(d) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function clientesReceita(d, opts = {}) {
  if (typeof opts === 'string') opts = { mes: opts };
  const hoje = new Date();
  const isoLocal = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const isoValida = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '';
  const padraoInicio = isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const padraoFim = isoLocal(hoje);
  let inicio = isoValida(opts.inicio) || padraoInicio;
  let fim = isoValida(opts.fim) || padraoFim;
  if (inicio > fim) [inicio, fim] = [fim, inicio];
  const clienteFiltro = String(opts.cliente || '').trim().toLowerCase();
  const ordem = String(opts.ordem || 'pago_desc');
  const fimDate = new Date(fim + 'T12:00:00');
  const inicio12 = isoLocal(new Date(fimDate.getFullYear(), fimDate.getMonth() - 11, 1));
  const mapa = new Map();
  const ignorarCategoria = /receita financeira|rendimento|juros|aporte|empr[eé]stimo|tarifa|estorno|transfer[eê]ncia/i;
  for (const l of d.lancamentos || []) {
    if (l.tipo !== 'receita') continue;
    const nome = String(l.parceiro || l.descricao || '').trim();
    if (!nome) continue;
    const cat = String(l.categoria || '').trim();
    if (ignorarCategoria.test(cat)) continue;
    const chave = nome.toLowerCase();
    let c = mapa.get(chave);
    if (!c) {
      c = { cliente: nome, pago: 0, receitaPeriodo: 0, aberto: 0, receita12m: 0, ultimoPagamento: '', qtdTitulos: 0, qtdPagos: 0, produtosMap: new Map() };
      mapa.set(chave, c);
    }
    const valor = Number(l.valor || 0);
    const emissao = String(l.emissao || l.vencimento || '');
    const baixas = (l.baixas || []).length
      ? l.baixas
      : (l.pagamento ? [{ data: l.pagamento, valor: Number(l.valorPago || valor) }] : []);
    let pagouPeriodo = false;
    for (const b of baixas) {
      const data = String(b.data || '');
      if (!data) continue;
      if (data >= inicio && data <= fim) { c.pago += Number(b.valor || valor); pagouPeriodo = true; }
      if (data > c.ultimoPagamento) c.ultimoPagamento = data;
    }
    const receitaPeriodo = emissao >= inicio && emissao <= fim;
    if (pagouPeriodo) c.qtdPagos++;
    if (receitaPeriodo) c.receitaPeriodo += valor;
    if (!['RECEBIDO', 'PAGO', 'LIQUIDADO'].includes(String(l.status || '').toUpperCase())) c.aberto += Math.max(0, valor - Number(l.valorPago || 0));
    if (emissao >= inicio12 && emissao <= fim) c.receita12m += valor;
    if (receitaPeriodo || pagouPeriodo) {
      c.qtdTitulos++;
      if (cat) c.produtosMap.set(cat, (c.produtosMap.get(cat) || 0) + valor);
    }
    c.cliente = c.cliente || nome;
  }
  const cmp = {
    pago_desc: (a, b) => b.pago - a.pago || b.receitaPeriodo - a.receitaPeriodo || a.cliente.localeCompare(b.cliente, 'pt-BR'),
    pago_asc: (a, b) => a.pago - b.pago || a.cliente.localeCompare(b.cliente, 'pt-BR'),
    receita_desc: (a, b) => b.receitaPeriodo - a.receitaPeriodo || a.cliente.localeCompare(b.cliente, 'pt-BR'),
    receita_asc: (a, b) => a.receitaPeriodo - b.receitaPeriodo || a.cliente.localeCompare(b.cliente, 'pt-BR'),
    nome_asc: (a, b) => a.cliente.localeCompare(b.cliente, 'pt-BR'),
    aberto_desc: (a, b) => b.aberto - a.aberto || b.receitaPeriodo - a.receitaPeriodo,
    ultimo_desc: (a, b) => String(b.ultimoPagamento).localeCompare(String(a.ultimoPagamento)) || b.pago - a.pago,
    produto_asc: (a, b) => String(a.produtos[0] || '').localeCompare(String(b.produtos[0] || ''), 'pt-BR') || a.cliente.localeCompare(b.cliente, 'pt-BR'),
  };
  const todos = [...mapa.values()].map(c => {
    const produtos = [...c.produtosMap.entries()].sort((a, b) => b[1] - a[1]).map(([nome]) => nome).slice(0, 6);
    return { cliente: c.cliente, produtos, pago: c.pago, receitaPeriodo: c.receitaPeriodo, aberto: c.aberto, receita12m: c.receita12m, ultimoPagamento: c.ultimoPagamento, qtdTitulos: c.qtdTitulos, qtdPagos: c.qtdPagos };
  });
  const clientes = todos.map(c => c.cliente).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  let itens = todos;
  if (clienteFiltro) itens = itens.filter(c => c.cliente.toLowerCase() === clienteFiltro);
  else itens = itens.filter(c => c.pago > 0 || c.receitaPeriodo > 0 || c.aberto > 0);
  itens.sort(cmp[ordem] || cmp.pago_desc);
  const totais = itens.reduce((a, c) => {
    a.pago += c.pago; a.receitaPeriodo += c.receitaPeriodo; a.aberto += c.aberto; a.receita12m += c.receita12m;
    if (c.pago > 0) a.comPagamento++; a.clientes++;
    return a;
  }, { pago: 0, receitaPeriodo: 0, aberto: 0, receita12m: 0, clientes: 0, comPagamento: 0 });
  return { inicio, fim, cliente: opts.cliente || '', ordem, itens, totais, clientes };
}

function analiseReceita(d) {
  const hoje = new Date();
  const meses = [];
  for (let i = 23; i >= 0; i--) meses.push(mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)));
  const dentro = new Set(meses);
  const totalPorMes = Object.fromEntries(meses.map(m => [m, 0]));
  const recorrentePorMes = Object.fromEntries(meses.map(m => [m, 0]));
  const naoRecorrentePorMes = Object.fromEntries(meses.map(m => [m, 0]));
  const produtos = new Map();
  const valorDe = l => Number(l.valorPago) > 0 ? Number(l.valorPago) : Number(l.valor || 0);
  for (const l of d.lancamentos || []) {
    if (l.tipo !== 'receita') continue;
    if (l.status !== 'RECEBIDO' && l.status !== 'LIQUIDADO' && !(Number(l.valorPago) > 0)) continue;
    const data = l.pagamento || l.vencimento;
    if (!data) continue;
    const mes = String(data).slice(0, 7);
    if (!dentro.has(mes)) continue;
    const valor = valorDe(l);
    const nome = l.categoria || 'Sem categoria';
    const rec = /mensalidade/i.test(nome);
    totalPorMes[mes] += valor;
    if (rec) recorrentePorMes[mes] += valor; else naoRecorrentePorMes[mes] += valor;
    if (!produtos.has(nome)) produtos.set(nome, { nome, total: 0, qtd: 0, meses: {}, recorrente: rec });
    const item = produtos.get(nome);
    item.total += valor; item.qtd++;
    item.meses[mes] = (item.meses[mes] || 0) + valor;
  }
  return {
    base: 'Data de pagamento; quando ausente, vencimento.',
    atualizadoEm: d.atualizadoEm,
    meses, totalPorMes, recorrentePorMes, naoRecorrentePorMes,
    produtos: [...produtos.values()].sort((a, b) => b.total - a.total),
    contratos: d.contratos,
  };
}

function analiseDespesas(d) {
  const hoje = new Date();
  const meses = [];
  for (let i = 23; i >= 0; i--) meses.push(mesKey(new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)));
  const dentro = new Set(meses);
  const totalPorMes = Object.fromEntries(meses.map(m => [m, 0]));
  const receitaPorMes = Object.fromEntries(meses.map(m => [m, 0]));
  const categorias = new Map(), fornecedores = new Map();
  const valorDe = l => Number(l.valorPago) > 0 ? Number(l.valorPago) : Number(l.valor || 0);
  const registro = (mapa, nome, mes, valor) => {
    if (!mapa.has(nome)) mapa.set(nome, { nome, total: 0, qtd: 0, meses: {} });
    const item = mapa.get(nome);
    item.total += valor; item.qtd++;
    item.meses[mes] = (item.meses[mes] || 0) + valor;
  };
  for (const l of d.lancamentos || []) {
    const data = l.pagamento || l.vencimento;
    if (!data) continue;
    const mes = String(data).slice(0, 7);
    if (!dentro.has(mes)) continue;
    const valor = valorDe(l);
    if (l.tipo === 'receita') {
      if (l.status !== 'RECEBIDO' && l.status !== 'LIQUIDADO' && !(Number(l.valorPago) > 0)) continue;
      receitaPorMes[mes] += valor;
    } else if (l.tipo === 'despesa') {
      if (l.status !== 'PAGO' && l.status !== 'LIQUIDADO' && !(Number(l.valorPago) > 0)) continue;
      totalPorMes[mes] += valor;
      registro(categorias, l.categoria || 'Sem categoria', mes, valor);
      registro(fornecedores, l.parceiro || l.descricao || 'Sem fornecedor', mes, valor);
    }
  }
  return {
    base: 'Data de pagamento; quando ausente, vencimento.',
    atualizadoEm: d.atualizadoEm,
    meses, totalPorMes, receitaPorMes,
    categorias: [...categorias.values()].sort((a, b) => b.total - a.total),
    fornecedores: [...fornecedores.values()].sort((a, b) => b.total - a.total),
    rescisoes: d.rescisoes,
    anoAtual: d.anoCaixa?.atual || d.ano?.atual,
    anoAnterior: d.anoCaixa?.anterior || d.ano?.anterior,
  };
}

const ORCAMENTO_DIR = path.join(__dirname, 'data');
const orcamentoCache = {};
function lerOrcamento(ano) {
  const anos = fs.existsSync(ORCAMENTO_DIR)
    ? fs.readdirSync(ORCAMENTO_DIR).map(x => x.match(/^orcamento-(\d{4})\.json$/)).filter(Boolean).map(m => Number(m[1])).sort()
    : [];
  const alvo = Number(ano) || anos[anos.length - 1];
  if (!alvo) return null;
  if (orcamentoCache[alvo]) return orcamentoCache[alvo];
  const arq = path.join(ORCAMENTO_DIR, `orcamento-${alvo}.json`);
  if (!fs.existsSync(arq)) return null;
  const dados = JSON.parse(fs.readFileSync(arq, 'utf8'));
  orcamentoCache[alvo] = dados;
  return dados;
}

app.get('/api/orcamento', async (req, res) => {
  try {
    const orc = lerOrcamento(req.query.ano);
    if (!orc) return res.status(404).json({ erro: 'Nenhum orçamento importado.' });
    const d = await dados();
    const financeiro = /receita financeira|rendimento|juros|tarifa|aplica[cç][aã]o|resgate|transfer[eê]ncia|aporte|empr[eé]stimo/i;
    const base = (d.lancamentos || []).filter(l => !financeiro.test(String(l.categoria || '')));
    const hoje = new Date().toISOString().slice(0, 10);
    const soma = (tipo, campo, mes) => base
      .filter(l => l.tipo === tipo && String(l[campo] || '').slice(0, 7) === mes)
      .reduce((a, l) => a + Number(l.valor || 0), 0);
    const somaComp = (tipo, mes) => base
      .filter(l => l.tipo === tipo && l.competencia && l.competencia <= hoje && String(l.competencia).slice(0, 7) === mes)
      .reduce((a, l) => a + Number(l.valor || 0), 0);
    const competencia = orc.meses.map(mes => ({
      mes, receita: somaComp('receita', mes), despesa: somaComp('despesa', mes),
    }));
    const caixa = orc.meses.map(mes => ({
      mes, receita: soma('receita', 'pagamento', mes), despesa: soma('despesa', 'pagamento', mes),
    }));
    res.json({ ...orc, competencia, caixa, atualizadoEm: new Date().toISOString() });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

async function baixarCSVGoogle(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; StartGiPainel/1.0)', accept: 'text/csv,*/*' },
  });
  if (!r.ok) throw new Error(`Google Sheets retornou ${r.status}. Verifique o compartilhamento.`);
  const texto = await r.text();
  if (/^\s*<(!doctype|html)/i.test(texto)) {
    throw new Error('A planilha não está pública. Compartilhe como "Qualquer pessoa com o link · Leitor".');
  }
  return texto;
}

async function abasGoogleSheet(link) {
  const m = String(link || '').match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return [];
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/edit`, {
      signal: AbortSignal.timeout(20000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; StartGiPainel/1.0)' },
    });
    if (!r.ok) return [];
    const html = await r.text();
    return [...new Set([...html.matchAll(/docs-sheet-tab-caption">([^<]+)</g)].map(x => x[1]
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')))];
  } catch (e) { return []; }
}

app.post('/api/orcamento/importar', async (req, res) => {
  try {
    const link = String(req.body?.url || '').trim();
    const ano = Number(req.body?.ano) || undefined;
    if (!link) throw new Error('Informe o link da planilha.');
    const abas = await abasGoogleSheet(link);
    const nomes = [...abas, 'Orçado', 'Realizado', 'Premissas', 'Pessoas', 'Controle'];
    const achar = re => [...new Set(nomes)].find(n => re.test(n));
    const tentarAba = async re => {
      const nome = achar(re);
      if (!nome) return null;
      try { return { nome, texto: await baixarCSVGoogle(googleSheetGvizUrl(link, nome)) }; } catch (e) { return null; }
    };
    const orcado = await tentarAba(/^or[çc]ado/i);
    let dados;
    const usadas = [];
    if (orcado) {
      const realizado = await tentarAba(/^realizado/i);
      const premissas = await tentarAba(/^premissas/i);
      const pessoas = await tentarAba(/^pessoas/i);
      dados = montarOrcamento({
        orcado: orcado.texto,
        realizado: realizado?.texto,
        premissas: premissas?.texto,
        pessoas: pessoas?.texto,
      }, { ano, origem: 'Google Sheets', url: link });
      usadas.push(orcado.nome);
      if (realizado) usadas.push(realizado.nome);
      if (premissas) usadas.push(premissas.nome);
      if (pessoas) usadas.push(pessoas.nome);
    } else {
      const texto = await baixarCSVGoogle(googleSheetExportUrl(link));
      dados = parseOrcamentoCSV(texto, { ano, origem: 'Google Sheets', url: link });
      usadas.push('primeira aba');
    }
    fs.mkdirSync(ORCAMENTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(ORCAMENTO_DIR, `orcamento-${dados.ano}.json`), JSON.stringify(dados, null, 2) + '\n');
    delete orcamentoCache[dados.ano];
    res.json({ ok: true, ano: dados.ano, linhas: dados.linhas.length, cenario: dados.cenario, abas: usadas, realizado: !!dados.realizadoDisponivel });
  } catch (e) { res.status(400).json({ erro: e.message }); }
});

app.get('/api/receita', async (req, res) => {
  try {
    const d = await dados();
    res.json(analiseReceita(d));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/despesas', async (req, res) => {
  try {
    const d = await dados();
    res.json(analiseDespesas(d));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/clientes-receita', async (req, res) => {
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) return res.status(500).json({ erro: 'Configure OMIE_APP_KEY e OMIE_APP_SECRET nas variáveis de ambiente.' });
  try {
    const d = await dados();
    res.json(clientesReceita(d, { inicio: req.query.inicio, fim: req.query.fim, cliente: req.query.cliente, ordem: req.query.ordem }));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/api/lancamentos.csv', async (req, res) => {
  if (!OMIE_APP_KEY || !OMIE_APP_SECRET) return res.status(500).send('Configure OMIE_APP_KEY e OMIE_APP_SECRET.');
  try {
    const d = await dados();
    const itens = filtrarLancamentos(d, req.query);
    const dtbr = s => s ? s.split('-').reverse().join('/') : '';
    const val = v => Number(v || 0).toFixed(2).replace('.', ',');
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const linhas = [
      ['Tipo', 'Status', 'Descrição', 'Parceiro', 'Categoria', 'Documento', 'Emissão', 'Vencimento', 'Pagamento', 'Dias em atraso', 'Valor'].join(';'),
      ...itens.map(l => [
        l.tipo === 'receita' ? 'Receita' : 'Despesa', l.status, l.descricao, l.parceiro, l.categoria, l.documento,
        dtbr(l.emissao), dtbr(l.vencimento), dtbr(l.pagamento), String(l.diasAtraso || 0),
      ].map(esc).join(';') + ';' + val(l.valor)),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="startgi-lancamentos-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\ufeff' + linhas.join('\r\n'));
  } catch (e) { res.status(500).send('Erro ao exportar: ' + e.message); }
});

// Atualização automática em segundo plano (mesmo intervalo do cache por padrão)
let aquecendo = false;
async function atualizarEmSegundoPlano() {
  if (aquecendo) return;
  aquecendo = true;
  try {
    await dados(true);
    console.log(`[auto] dados atualizados em ${new Date().toLocaleString('pt-BR')}`);
  } catch (e) {
    console.error('[auto] falha ao atualizar:', e.message);
  } finally {
    aquecendo = false;
  }
}
if (REFRESH_MIN > 0) {
  setInterval(atualizarEmSegundoPlano, REFRESH_MIN * 60e3);
  console.log(`[auto] atualização automática a cada ${REFRESH_MIN} minutos`);
}

// Leitura estratégica semanal (gera no boot e renova a cada INSIGHTS_MIN)
if (INSIGHTS_MIN > 0) {
  setTimeout(() => obterInsightsSemanais().catch(e => console.error('[insights] boot:', e.message)), 6000);
  const timerInsights = setInterval(() => obterInsightsSemanais(true).catch(e => console.error('[insights] semanal:', e.message)), INSIGHTS_MIN * 60e3);
  if (timerInsights.unref) timerInsights.unref();
  console.log(`[insights] leitura estratégica a cada ${INSIGHTS_MIN} minutos`);
}

// ---------- Guru (chat) ----------
app.post('/api/guru', async (req, res) => {
  if (!AI_KEY) return res.json({ resposta: 'O chat do guru precisa da variável COMMANDCODE_API_KEY configurada no servidor.' });
  try {
    const d = await dados();
    const contexto = JSON.stringify({ saldo: d.saldo, saldoOmie: d.saldoOmie, caixaAplicado: d.caixaAplicado, caixa: d.caixa, saldoDisponivel: d.saldoDisponivel, kpis: d.kpis, serieMensal: d.serieMensal, competencia: d.competencia, regimes: d.regimes, ano: d.ano, anoCaixa: d.anoCaixa, mesAtual: d.meses[d.meses.length - 1], fluxo12semanas: d.semanas, clientes: d.clientes, despesas: d.despesas, despesas12m: d.despesas12m, despesasAno: d.despesasAno, rescisoes: d.rescisoes, atrasados: d.atrasados, atrasadosResumo: d.atrasadosResumo, produtosReceita: d.produtosReceita, recorrente: d.recorrente, contratos: d.contratos });
    const ctx = (typeof req.body.contexto === 'string' && req.body.contexto.trim()) ? req.body.contexto.trim().slice(0, 12000) : contextoEmpresa();
    const r = await fetch(`${AI_BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI_KEY}`, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 8192,
        system: `Você é o CFO as a Service da StartGi Tecnologia (GovTech/B2B, ~25 pessoas, investida pelo FIP GovTech). Seu cliente é o CEO, Juliano, que não é especialista em finanças. Aja como um CFO experiente e franco.

Regras de resposta:
- Responda em no máximo 180 palavras.
- Comece pela resposta direta em uma frase.
- No máximo 3 parágrafos curtos, sem markdown e sem listas.
- Cite no máximo 4 números por parágrafo; não liste todos os meses, só os que mudam a decisão.
- Quando a pergunta envolver tendência ou comparação, resuma a evolução mês a mês em uma frase.
- Inclua o panorama do ano (YTD x mesmo período do ano anterior) quando for relevante.
- O mês corrente é parcial; não o trate como fechado.
- Explique um termo técnico apenas se ele for indispensável.
- Feche com "Esta semana: " e uma única ação concreta.
- Use apenas os dados e o contexto abaixo; se faltar dado, diga qual e como obtê-lo.
- Para perguntas sobre um tipo de despesa (ex.: rescisão, FGTS, salários), verifique primeiro despesasAno.categorias e o bloco rescisoes. Não afirme que o dado não existe sem antes olhar todas as categorias e as descrições/itens de rescisão.
- Se rescisoes.total for zero, diga isso e informe o que existe em categorias relacionadas (FGTS, Salários), deixando claro que o Omie não separa o valor. Se houver itens em rescisoes, some e responda o total do ano pedido.

CONTEXTO DA EMPRESA:
${ctx || '(não informado)'}

DADOS: ${contexto}`,
        messages: (req.body.historico || []).slice(-10),
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ resposta: `Erro do provedor de IA (${r.status}): ${j.error?.message || j.message || 'falha na chamada'}` });
    const texto = j.content?.map?.(b => b.text).filter(Boolean).join('\n') || j.choices?.[0]?.message?.content || j.output_text;
    res.json({ resposta: texto || 'A IA não retornou texto desta vez. Tente novamente.' });
  } catch (e) { res.status(500).json({ resposta: 'Erro: ' + e.message }); }
});

app.listen(PORT, () => console.log(`Painel financeiro StartGi na porta ${PORT}`));
