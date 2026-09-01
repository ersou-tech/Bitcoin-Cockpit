'use strict';
/*
 * BTC RADAR - preditivo
 * Sem IA. Le apostas do Polymarket, macro do Yahoo Finance e volatilidade da Deribit,
 * e monta uma nota por formula. Os coeficientes sao julgamento, nao backtest.
 */

async function buscarJson(url, ms = 15000) {
  const resposta = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) BTC-RADAR/1.0' }
  });
  if (!resposta.ok) throw new Error(url.split('?')[0] + ' respondeu ' + resposta.status);
  return resposta.json();
}

function limitar(valor, teto) {
  if (!Number.isFinite(valor)) return 0;
  return Math.max(-teto, Math.min(teto, valor));
}

function arredondar(v, casas = 2) {
  return Number.isFinite(v) ? Number(v.toFixed(casas)) : null;
}

// ------------------------------------------------------------------ polymarket

const RE_FOMC = /\b(fomc|federal reserve)\b|\bfed\b|interest rate/i;
const RE_MANTER = /no change/i;
const RE_ALTA = /\b(increase|hike)\b/i;
const RE_CORTE = /\b(decrease|cut)\b/i;

function precosDoMercado(m) {
  let precos = m.outcomePrices;
  if (typeof precos === 'string') {
    try { precos = JSON.parse(precos); } catch { precos = null; }
  }
  if (!Array.isArray(precos)) return null;
  return precos.map(Number);
}

function probabilidadeSim(m) {
  const precos = precosDoMercado(m);
  if (!precos || !precos.length) return null;
  // O primeiro resultado e sempre o "Yes" nos mercados binarios da Polymarket.
  return Number.isFinite(precos[0]) ? precos[0] : null;
}

async function polymarket() {
  try {
    const dados = await buscarJson('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=200&order=volume24hr&ascending=false');
    const mercados = Array.isArray(dados) ? dados : (dados.data || []);
    const candidatos = [];
    const btc = [];
    for (const m of mercados) {
      const pergunta = String(m.question || m.title || '');
      if (!pergunta) continue;
      const prob = probabilidadeSim(m);
      if (prob === null) continue;
      const ehAcao = RE_MANTER.test(pergunta) || RE_ALTA.test(pergunta) || RE_CORTE.test(pergunta);
      if (RE_FOMC.test(pergunta) && ehAcao) {
        let acao = 'manter';
        if (RE_CORTE.test(pergunta)) acao = 'corte';
        else if (RE_ALTA.test(pergunta)) acao = 'alta';
        candidatos.push({
          pergunta,
          acao,
          prob,
          volume24h: Number(m.volume24hr) || 0,
          fim: Date.parse(m.endDate || m.end_date_iso || '') || null
        });
      } else if (/\b(bitcoin|btc)\b/i.test(pergunta)) {
        btc.push({ pergunta, prob, volume24h: Number(m.volume24hr) || 0 });
      }
    }

    // So a proxima reuniao interessa. Sem esse corte, apostas de reunioes
    // diferentes se somam e a probabilidade estoura de 100%.
    const agora = Date.now();
    const datas = candidatos.map((c) => c.fim).filter((t) => t && t > agora).sort((a, b) => a - b);
    const proxima = datas.length ? datas[0] : null;
    const doEvento = proxima
      ? candidatos.filter((c) => c.fim && Math.abs(c.fim - proxima) <= 3 * 24 * 3600 * 1000)
      : candidatos;

    const soma = (acao) => doEvento.filter((f) => f.acao === acao).reduce((s, f) => s + f.prob, 0);
    let corte = soma('corte');
    let alta = soma('alta');
    let manter = soma('manter');
    const total = corte + alta + manter;
    // Os tres caminhos sao excludentes: normaliza para somarem 1.
    if (total > 0) { corte /= total; alta /= total; manter /= total; }

    doEvento.sort((a, b) => b.volume24h - a.volume24h);
    btc.sort((a, b) => b.volume24h - a.volume24h);
    return {
      reuniao: proxima ? new Date(proxima).toISOString().slice(0, 10) : null,
      fomc: doEvento.slice(0, 12),
      btc: btc.slice(0, 10),
      probCorte: total > 0 ? corte : null,
      probAlta: total > 0 ? alta : null,
      probManter: total > 0 ? manter : null
    };
  } catch (e) {
    return { erro: String(e.message || e), fomc: [], btc: [], probCorte: null, probAlta: null, probManter: null };
  }
}

// ------------------------------------------------------------------ yahoo/macro

const SIMBOLOS = [
  { chave: 'juro10a', simbolo: '^TNX', nome: 'Juro 10 anos EUA' },
  { chave: 'dolar', simbolo: 'DX-Y.NYB', nome: 'Indice do dolar (DXY)' },
  { chave: 'nasdaq', simbolo: '^IXIC', nome: 'Nasdaq' },
  { chave: 'ouro', simbolo: 'GC=F', nome: 'Ouro' },
  { chave: 'btc', simbolo: 'BTC-USD', nome: 'Bitcoin' }
];

async function serieYahoo(simbolo) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(simbolo) + '?range=3mo&interval=1d';
  const dados = await buscarJson(url);
  const r = dados && dados.chart && dados.chart.result ? dados.chart.result[0] : null;
  if (!r) throw new Error('serie vazia para ' + simbolo);
  const tempos = r.timestamp || [];
  const fechamentos = (r.indicators.quote[0].close || []).map(Number);
  const pontos = [];
  for (let i = 0; i < tempos.length; i++) {
    if (Number.isFinite(fechamentos[i])) pontos.push({ t: tempos[i] * 1000, v: fechamentos[i] });
  }
  return pontos;
}

function variacao(pontos, dias) {
  if (pontos.length < 2) return null;
  const fim = pontos[pontos.length - 1].v;
  const indice = Math.max(0, pontos.length - 1 - dias);
  const inicio = pontos[indice].v;
  if (!inicio) return null;
  return ((fim - inicio) / inicio) * 100;
}

function retornosDiarios(pontos, quantos) {
  const cortados = pontos.slice(-(quantos + 1));
  const saida = [];
  for (let i = 1; i < cortados.length; i++) {
    const anterior = cortados[i - 1].v;
    if (anterior) saida.push((cortados[i].v - anterior) / anterior);
  }
  return saida;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mediaX = x.reduce((s, v) => s + v, 0) / n;
  const mediaY = y.reduce((s, v) => s + v, 0) / n;
  let cima = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mediaX;
    const dy = y[i] - mediaY;
    cima += dx * dy;
    sx += dx * dx;
    sy += dy * dy;
  }
  const baixo = Math.sqrt(sx * sy);
  return baixo ? cima / baixo : null;
}

async function macro() {
  const series = {};
  const falhas = [];
  await Promise.all(SIMBOLOS.map(async (s) => {
    try {
      series[s.chave] = await serieYahoo(s.simbolo);
    } catch (e) {
      falhas.push({ simbolo: s.simbolo, motivo: String(e.message || e) });
      series[s.chave] = [];
    }
  }));

  const retornosBtc = retornosDiarios(series.btc || [], 30);
  const ativos = SIMBOLOS.map((s) => {
    const pontos = series[s.chave] || [];
    const ultimo = pontos.length ? pontos[pontos.length - 1].v : null;
    const correlacao = s.chave === 'btc' ? 1 : pearson(retornosDiarios(pontos, 30), retornosBtc);
    return {
      chave: s.chave,
      simbolo: s.simbolo,
      nome: s.nome,
      ultimo: arredondar(ultimo, 4),
      var1d: arredondar(variacao(pontos, 1)),
      var30d: arredondar(variacao(pontos, 30)),
      correlacao30d: arredondar(correlacao, 3)
    };
  });
  return { ativos, falhas };
}

// --------------------------------------------------------------------- deribit

async function dvol() {
  try {
    const fim = Date.now();
    const inicio = fim - 10 * 24 * 3600 * 1000;
    const url = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC' +
      '&start_timestamp=' + inicio + '&end_timestamp=' + fim + '&resolution=43200';
    const dados = await buscarJson(url);
    const linhas = dados && dados.result && Array.isArray(dados.result.data) ? dados.result.data : [];
    if (!linhas.length) throw new Error('DVOL sem dados');
    const pontos = linhas.map((l) => ({ t: l[0], v: Number(l[4]) })).filter((p) => Number.isFinite(p.v));
    const atual = pontos[pontos.length - 1].v;
    const um = pontos[Math.max(0, pontos.length - 3)].v;   // 2 pontos por dia
    const sete = pontos[Math.max(0, pontos.length - 15)].v;
    return {
      atual: arredondar(atual),
      var1d: arredondar(um ? ((atual - um) / um) * 100 : null),
      var7d: arredondar(sete ? ((atual - sete) / sete) * 100 : null)
    };
  } catch (e) {
    return { erro: String(e.message || e), atual: null, var1d: null, var7d: null };
  }
}

// ------------------------------------------------------------------- nota final

function acharAtivo(lista, chave) {
  return lista.find((a) => a.chave === chave) || {};
}

async function calcular() {
  const [apostas, dadosMacro, volatilidade] = await Promise.all([polymarket(), macro(), dvol()]);
  const dolar = acharAtivo(dadosMacro.ativos, 'dolar');
  const juro = acharAtivo(dadosMacro.ativos, 'juro10a');
  const nasdaq = acharAtivo(dadosMacro.ativos, 'nasdaq');

  const diferencaFomc = (apostas.probCorte !== null && apostas.probAlta !== null)
    ? apostas.probCorte - apostas.probAlta
    : null;

  const componentes = [
    {
      nome: 'Aposta de juro no próximo FOMC',
      entrada: diferencaFomc === null ? null : arredondar(diferencaFomc * 100) + '% líquido a favor de corte',
      contribuicao: arredondar(limitar((diferencaFomc || 0) * 80, 32)),
      teto: 32,
      explicacao: 'Probabilidade de corte menos a de alta, pelo dinheiro apostado na Polymarket. Corte tende a soltar liquidez.'
    },
    {
      nome: 'Dólar (DXY) em 30 dias',
      entrada: juro && dolar.var30d !== null ? dolar.var30d + '%' : null,
      contribuicao: arredondar(limitar(-(dolar.var30d || 0) * 8, 20)),
      teto: 20,
      explicacao: 'Dólar caindo costuma acompanhar apetite por risco; dólar subindo aperta.'
    },
    {
      nome: 'Juro de 10 anos em 30 dias',
      entrada: juro.var30d !== null ? juro.var30d + '%' : null,
      contribuicao: arredondar(limitar(-(juro.var30d || 0) * 2.5, 20)),
      teto: 20,
      explicacao: 'Juro longo subindo encarece o dinheiro e pesa sobre ativos de risco.'
    },
    {
      nome: 'Nasdaq em 30 dias',
      entrada: nasdaq.var30d !== null ? nasdaq.var30d + '%' : null,
      contribuicao: arredondar(limitar((nasdaq.var30d || 0) * 1.5, 18)),
      teto: 18,
      explicacao: 'Bolsa de tecnologia é o par de risco mais próximo do bitcoin.'
    },
    {
      nome: 'Volatilidade DVOL em 7 dias',
      entrada: volatilidade.var7d !== null ? volatilidade.var7d + '%' : null,
      contribuicao: arredondar(limitar(-(volatilidade.var7d || 0) * 0.6, 15)),
      teto: 15,
      explicacao: 'Volatilidade implícita caindo costuma indicar mercado mais calmo.'
    }
  ];

  const nota = arredondar(limitar(componentes.reduce((s, c) => s + (c.contribuicao || 0), 0), 100), 1);
  let rotulo = 'neutro';
  if (nota >= 35) rotulo = 'vento a favor';
  else if (nota >= 12) rotulo = 'levemente favorável';
  else if (nota <= -35) rotulo = 'vento contra';
  else if (nota <= -12) rotulo = 'levemente contrário';

  return {
    t: Date.now(),
    nota,
    rotulo,
    componentes,
    polymarket: apostas,
    macro: dadosMacro,
    dvol: volatilidade,
    aviso: 'Fórmula fechada, sem IA. Os coeficientes são julgamento do autor, não resultado de backtest.'
  };
}

module.exports = { calcular, polymarket, macro, dvol, pearson };
