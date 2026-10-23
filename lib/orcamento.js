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

module.exports = { numeroBR, numeroPct, parseCSV, parseOrcamentoCSV, googleSheetExportUrl };
