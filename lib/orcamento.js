function numeroBR(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : 0;
  let s = String(valor ?? '').trim().replace(/[−–]/g, '-');
  if (!s || s === '-' || s === '—') return 0;
  const negativo = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()]/g, '').replace(/[R$\s%]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negativo ? -Math.abs(n) : n;
}

function numeroPct(valor) {
  const bruto = String(valor ?? '').trim();
  if (!bruto) return 0;
  const n = numeroBR(bruto);
  return /%/.test(bruto) || Math.abs(n) > 1 ? n / 100 : n;
}

function parseCSV(texto) {
  const linhas = String(texto || '').replace(/^\uFEFF/, '');
  const primeira = linhas.split(/\r?\n/, 1)[0] || '';
  const delimitador = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < linhas.length; i++) {
    const ch = linhas[i];
    if (quoted) {
      if (ch === '"') {
        if (linhas[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimitador) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function grupoDaLinha(nome) {
  if (/^MRR core|^MRR massificado|^Receita de projetos|^Receita bruta/i.test(nome)) return 'Receita';
  if (/DAS|Simples Nacional|Economia Simples|^Receita líquida/i.test(nome)) return 'Deduções';
  if (/CSP|^Lucro bruto|^Margem bruta/i.test(nome)) return 'Custos';
  if (/Despesas operacionais|Contingência|Mídia paga|Plano de saúde/i.test(nome)) return 'Despesas';
  if (/^EBITDA|^Margem EBITDA/i.test(nome)) return 'Resultado';
  if (/Resultado financeiro/i.test(nome)) return 'Financeiro';
  if (/Resultado após financeiro/i.test(nome)) return 'Resultado';
  return '';
}

function parseOrcamentoCSV(texto, opcoes = {}) {
  const rows = parseCSV(texto);
  const headerIdx = rows.findIndex(r => r.some(c => /^jan(?:eiro)?$/i.test(String(c || '').trim())));
  if (headerIdx < 0) throw new Error('Cabeçalho com os meses não encontrado. Use a aba do orçamento (Jan a Dez).');
  const header = rows[headerIdx];
  const colMes = header.findIndex(c => /^jan(?:eiro)?$/i.test(String(c || '').trim()));
  if (colMes < 0 || header.length < colMes + 12) throw new Error('A planilha precisa ter as colunas Jan a Dez.');

  const titulo = rows.slice(0, headerIdx).map(r => r.join(' ')).join(' ');
  const anoDetectado = Number((titulo.match(/20\d{2}/) || [])[0]);
  const ano = Number(opcoes.ano) || anoDetectado;
  if (!ano) throw new Error('Informe o ano do orçamento.');
  const cen = (titulo.match(/Cen[aá]rio\s*:\s*([^|]+)/i) || [])[1];
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`);
  const linhas = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const nome = String(row[0] || '').trim();
    if (!nome) continue;
    const grupo = grupoDaLinha(nome);
    if (!grupo) continue;
    const percentual = /%/.test(nome);
    const valores = meses.map((_, m) => {
      const v = row[colMes + m];
      return percentual ? numeroPct(v) : numeroBR(v);
    });
    const totalRaw = row[colMes + 12];
    const total = percentual
      ? numeroPct(totalRaw)
      : (String(totalRaw ?? '').trim() ? numeroBR(totalRaw) : valores.reduce((a, v) => a + v, 0));
    linhas.push({ grupo, nome, percentual, valores, total });
    if (/Resultado após financeiro/i.test(nome)) break;
  }

  const acha = regex => linhas.find(l => regex.test(l.nome));
  const receitaBruta = acha(/^Receita bruta/i);
  const ebitda = acha(/^EBITDA/i);
  if (!receitaBruta) throw new Error('Linha "Receita bruta" não encontrada.');
  if (!ebitda) throw new Error('Linha "EBITDA" não encontrada.');

  const resumo = meses.map((mes, i) => {
    const receita = receitaBruta.valores[i] || 0;
    const eb = ebitda.valores[i] || 0;
    return { mes, receita, despesa: receita - eb, ebitda: eb };
  });

  return {
    ano,
    cenario: (cen || 'Importado').trim(),
    origem: opcoes.origem || 'Google Sheets',
    fonteUrl: opcoes.url || undefined,
    importadoEm: new Date().toISOString(),
    meses,
    linhas,
    resumo,
  };
}

function googleSheetExportUrl(link) {
  const texto = String(link || '').trim();
  const gid = (texto.match(/[?&#]gid=(\d+)/) || [])[1];
  const publicado = texto.match(/docs\.google\.com\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/);
  if (publicado) {
    return `https://docs.google.com/spreadsheets/d/e/${publicado[1]}/pub?output=csv${gid ? `&gid=${gid}` : ''}`;
  }
  const m = texto.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Informe um link válido do Google Sheets.');
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}


function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function limpar(v) {
  return String(v ?? '').trim();
}

function cabecalhoMeses(rows) {
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (let c = 0; c <= row.length - 12; c++) {
      const ok = nomes.every((n, j) => new RegExp('^' + n, 'i').test(limpar(row[c + j])));
      if (ok) return { headerIdx: i, colMes: c };
    }
  }
  return null;
}

function cabecalhoOrcado(rows) {
  const linhaArea = rows.findIndex(r => /^área$/i.test(limpar(r[0])) && /^linha$/i.test(limpar(r[1])));
  if (linhaArea >= 0) {
    for (let i = linhaArea; i >= 0; i--) {
      const c = rows[i].findIndex(x => /^m[eê]s\s*n/i.test(limpar(x)));
      if (c >= 0) {
        let colMes = rows[i].findIndex((x, j) => j > c && /^1$/.test(limpar(x)));
        if (colMes < 0) colMes = c + 1;
        return { headerIdx: linhaArea, colMes };
      }
    }
    return { headerIdx: linhaArea, colMes: 2 };
  }
  const meses = cabecalhoMeses(rows);
  if (meses) return meses;
  throw new Error('Cabeçalho de meses não encontrado na aba Orçado.');
}

function tipoDaLinha(area, nome) {
  if (/^receita bruta$/i.test(nome)) return 'receitaBruta';
  if (/^receita l[ií]quida$/i.test(nome)) return 'receitaLiquida';
  if (/^lucro bruto$/i.test(nome)) return 'lucroBruto';
  if (/total despesas operacionais/i.test(nome)) return 'despesasOperacionais';
  if (/^ebitda$/i.test(nome)) return 'ebitda';
  if (/^margem ebitda/i.test(nome)) return 'margemEbitda';
  if (/resultado do m[eê]s/i.test(nome)) return 'resultadoMes';
  if (/caixa final/i.test(nome)) return 'caixaFinal';
  if (/^mrr total/i.test(nome)) return 'mrrTotal';
  if (/headcount/i.test(nome)) return 'headcount';
  if (/rendimento do caixa/i.test(nome)) return 'resultadoFinanceiro';
  if (/^total\s/i.test(nome)) return 'totalArea';
  return 'linha';
}

function chaveLinha(area, nome) {
  return normalizar(area) + '||' + normalizar(nome);
}

function anoDoTitulo(rows, opcoes) {
  const titulo = rows.slice(0, 8).map(r => r.join(' ')).join(' ');
  return Number(opcoes.ano) || Number((titulo.match(/20\d{2}/) || [])[0]) || 0;
}

function parseOrcadoCSV(texto, opcoes = {}) {
  const rows = parseCSV(texto);
  const cab = cabecalhoOrcado(rows);
  const ano = anoDoTitulo(rows, opcoes);
  if (!ano) throw new Error('Informe o ano do orçamento.');
  const meses = Array.from({ length: 12 }, (_, i) => `${ano}-${String(i + 1).padStart(2, '0')}`);
  const linhas = [];
  for (let i = cab.headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const area = limpar(row[0]);
    const nome = limpar(row[1]);
    if (!area || !nome) continue;
    if (/^(como usar|or[çc]ado\s+20\d{2}|realizado\s+20\d{2})/i.test(nome)) continue;
    if (/^(m[eê]s\s*n|área)$/i.test(area)) continue;
    const percentual = /margem|%/.test(nome);
    const valores = meses.map((_, m) => percentual ? numeroPct(row[cab.colMes + m]) : numeroBR(row[cab.colMes + m]));
    const totalRaw = row[cab.colMes + 12];
    const total = percentual
      ? valores.reduce((a, v) => a + Number(v || 0), 0) / 12
      : (limpar(totalRaw) ? numeroBR(totalRaw) : valores.reduce((a, v) => a + Number(v || 0), 0));
    linhas.push({ area, nome, tipo: tipoDaLinha(area, nome), percentual, valores, total, realizadoValores: null, realizadoTotal: null });
  }
  if (!linhas.length) throw new Error('Nenhuma linha de orçado encontrada na aba Orçado.');
  const titulo = rows.slice(0, 8).map(r => r.join(' ')).join(' ');
  const cen = (titulo.match(/Cen[aá]rio\s*:\s*([^|]+)/i) || [])[1];
  return {
    ano,
    cenario: (cen || opcoes.cenario || 'Plano base').trim(),
    origem: opcoes.origem || 'Google Sheets',
    fonteUrl: opcoes.url || undefined,
    importadoEm: new Date().toISOString(),
    meses,
    linhas,
  };
}

function parseRealizadoCSV(texto) {
  const rows = parseCSV(texto);
  const cab = cabecalhoMeses(rows);
  if (!cab) return [];
  const linhas = [];
  for (let i = cab.headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const area = limpar(row[0]);
    const nome = limpar(row[1]);
    if (!area || !nome) continue;
    const valores = Array.from({ length: 12 }, (_, m) => numeroBR(row[cab.colMes + m]));
    const totalRaw = row[cab.colMes + 12];
    const total = limpar(totalRaw) ? numeroBR(totalRaw) : valores.reduce((a, v) => a + v, 0);
    linhas.push({ area, nome, valores, total });
  }
  return linhas;
}

function parsePremissasCSV(texto) {
  return parseCSV(texto).slice(1).map(r => ({ nome: limpar(r[0]), valor: limpar(r[1]) })).filter(x => x.nome);
}

function parsePessoasCSV(texto) {
  const rows = parseCSV(texto);
  if (!rows.length) return [];
  const header = rows[0].map(limpar);
  return rows.slice(1).filter(r => limpar(r[0]) && !/linhas livres/i.test(limpar(r[0]))).map(r => {
    const item = {};
    header.forEach((h, i) => { if (h) item[h] = limpar(r[i]); });
    return item;
  });
}

function resumoDeLinhas(linhas, meses) {
  const acha = tipo => linhas.find(l => l.tipo === tipo);
  const rec = acha('receitaBruta'), liq = acha('receitaLiquida'), lucro = acha('lucroBruto');
  const desp = acha('despesasOperacionais'), eb = acha('ebitda'), rm = acha('resultadoMes');
  const caixa = acha('caixaFinal'), mrr = acha('mrrTotal'), head = acha('headcount'), fin = acha('resultadoFinanceiro');
  return meses.map((mes, i) => {
    const receita = Number(rec?.valores[i] || 0);
    const receitaLiquida = Number(liq?.valores[i] || 0);
    const lucroBruto = Number(lucro?.valores[i] || 0);
    const ebitda = Number(eb?.valores[i] || 0);
    return {
      mes,
      receita,
      receitaLiquida,
      custos: Math.max(0, receitaLiquida - lucroBruto),
      despesasOperacionais: Math.abs(Number(desp?.valores[i] || 0)),
      despesa: receita - ebitda,
      ebitda,
      margemEbitda: receita ? ebitda / receita : 0,
      resultadoFinanceiro: Number(fin?.valores[i] || 0),
      resultadoMes: Number(rm?.valores[i] || 0),
      caixaFinal: Number(caixa?.valores[i] || 0),
      mrrTotal: Number(mrr?.valores[i] || 0),
      headcount: Number(head?.valores[i] || 0),
    };
  });
}

function montarOrcamento(abas, opcoes = {}) {
  const base = parseOrcadoCSV(abas.orcado, opcoes);
  const realizado = abas.realizado ? parseRealizadoCSV(abas.realizado) : [];
  const mapa = new Map(realizado.map(l => [chaveLinha(l.area, l.nome), l]));
  const tipos = new Map(base.linhas.map(l => [chaveLinha(l.area, l.nome), l.tipo]));
  realizado.forEach(l => { l.tipo = tipos.get(chaveLinha(l.area, l.nome)) || tipoDaLinha(l.area, l.nome); });
  base.linhas.forEach(l => {
    const r = mapa.get(chaveLinha(l.area, l.nome));
    l.realizadoValores = r ? r.valores : null;
    l.realizadoTotal = r ? r.total : null;
  });
  base.realizadoLinhas = realizado;
  base.realizadoDisponivel = realizado.some(l => l.valores.some(v => Number(v) !== 0) || Number(l.total) !== 0);
  base.resumo = resumoDeLinhas(base.linhas, base.meses);
  base.resumoRealizado = resumoDeLinhas(realizado, base.meses);
  base.premissas = abas.premissas ? parsePremissasCSV(abas.premissas) : [];
  base.pessoas = abas.pessoas ? parsePessoasCSV(abas.pessoas) : [];
  return base;
}

function googleSheetGvizUrl(link, aba) {
  const texto = String(link || '').trim();
  const m = texto.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('Informe um link válido do Google Sheets.');
  return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(aba)}`;
}

module.exports = { numeroBR, numeroPct, parseCSV, parseOrcamentoCSV, googleSheetExportUrl, googleSheetGvizUrl, parseOrcadoCSV, parseRealizadoCSV, parsePremissasCSV, parsePessoasCSV, montarOrcamento };
