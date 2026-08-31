'use strict';
/*
 * BTC RADAR - snapshots
 * Captura manual (config snapshotMin: 0). Serie de estudo so vale se toda linha
 * for medida do mesmo jeito, entao open interest, livro e liquidacoes vem SEMPRE
 * do servidor. O que o painel enxerga a mais fica separado em snap.painel.
 */

const fs = require('node:fs');
const path = require('node:path');

const sentimento = require('./sentiment.js');
const preditivo = require('./preditivo.js');

const DIR_DADOS = path.join(__dirname, 'data');
const ARQ_SNAPSHOTS = path.join(DIR_DADOS, 'snapshots.jsonl');
const ARQ_HISTORICO = path.join(DIR_DADOS, 'history.jsonl');
const ARQ_LIQUIDACOES = path.join(DIR_DADOS, 'liquidations.jsonl');

const BINANCE = 'https://fapi.binance.com';
const SPOT = 'https://api.binance.com';
const BYBIT = 'https://api.bybit.com';
const OKX = 'https://www.okx.com';
const HL = 'https://api.hyperliquid.xyz';

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function buscarJson(url, opcoes = {}, ms = 12000) {
  const resposta = await fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opcoes));
  if (!resposta.ok) throw new Error(url.split('?')[0] + ' respondeu ' + resposta.status);
  return resposta.json();
}

function lerLinhas(arquivo, desdeMs) {
  let bruto;
  try {
    bruto = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return [];
  }
  const saida = [];
  for (const linha of bruto.split('\n')) {
    if (!linha) continue;
    try {
      const obj = JSON.parse(linha);
      if (desdeMs && obj.t && obj.t < desdeMs) continue;
      saida.push(obj);
    } catch { /* linha truncada */ }
  }
  return saida;
}

// ------------------------------------------------------------------- coletas

async function mercado() {
  const [premio, spot] = await Promise.all([
    buscarJson(BINANCE + '/fapi/v1/premiumIndex?symbol=BTCUSDT').catch(() => null),
    buscarJson(SPOT + '/api/v3/ticker/24hr?symbol=BTCUSDT').catch(() => null)
  ]);
  let mark = premio ? numero(premio.markPrice) : null;
  let precoSpot = spot ? numero(spot.lastPrice) : null;
  let funding = premio ? numero(premio.lastFundingRate) : null;

  // Reserva pela OKX quando a Binance nao responde.
  if (!mark || !precoSpot || funding === null) {
    const [swap, avista, taxa] = await Promise.all([
      buscarJson(OKX + '/api/v5/market/ticker?instId=BTC-USDT-SWAP').catch(() => null),
      buscarJson(OKX + '/api/v5/market/ticker?instId=BTC-USDT').catch(() => null),
      buscarJson(OKX + '/api/v5/public/funding-rate?instId=BTC-USDT-SWAP').catch(() => null)
    ]);
    const pegar = (d, campo) => (d && d.data && d.data[0] ? numero(d.data[0][campo]) : null);
    mark = mark || pegar(swap, 'last');
    precoSpot = precoSpot || pegar(avista, 'last');
    funding = funding === null ? pegar(taxa, 'fundingRate') : funding;
  }

  return {
    mark,
    spot: precoSpot,
    funding,
    basisPct: (mark && precoSpot) ? ((mark - precoSpot) / precoSpot) * 100 : null,
    var24hPct: spot ? numero(spot.priceChangePercent) : null,
    volume24hUsd: spot ? numero(spot.quoteVolume) : null
  };
}

async function openInterest(mark) {
  const pegar = async (fn) => { try { return await fn(); } catch { return null; } };
  const [binance, bybit, okx, hyperliquid] = await Promise.all([
    pegar(async () => {
      const d = await buscarJson(BINANCE + '/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=1');
      const u = d[d.length - 1];
      return { btc: numero(u.sumOpenInterest), usd: numero(u.sumOpenInterestValue) };
    }),
    pegar(async () => {
      const d = await buscarJson(BYBIT + '/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=5min&limit=1');
      const btc = numero(d.result.list[0].openInterest);
      return { btc, usd: btc && mark ? btc * mark : null };
    }),
    pegar(async () => {
      const d = await buscarJson(OKX + '/api/v5/public/open-interest?instId=BTC-USDT-SWAP');
      const btc = numero(d.data[0].oiCcy);
      return { btc, usd: numero(d.data[0].oiUsd) || (btc && mark ? btc * mark : null) };
    }),
    pegar(async () => {
      const d = await buscarJson(HL + '/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      });
      const indice = d[0].universe.findIndex((a) => a.name === 'BTC');
      const ctx = d[1][indice];
      const btc = numero(ctx.openInterest);
      const preco = numero(ctx.markPx) || mark;
      return { btc, usd: btc && preco ? btc * preco : null };
    })
  ]);
  const total = [binance, bybit, okx, hyperliquid]
    .filter((x) => x && Number.isFinite(x.usd))
    .reduce((s, x) => s + x.usd, 0);
  return { binance, bybit, okx, hyperliquid, totalUsd: total || null };
}

async function longShort() {
  const pegar = async (rota) => {
    try {
      const d = await buscarJson(BINANCE + rota);
      return numero(d[d.length - 1].longShortRatio);
    } catch {
      return null;
    }
  };
  const [contas, posicoes, grandes] = await Promise.all([
    pegar('/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1'),
    pegar('/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=1'),
    pegar('/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1')
  ]);
  return { varejoContas: contas, grandesPosicoes: posicoes, grandesContas: grandes };
}

// Livro sempre da mesma fonte, para a serie de estudo ser comparavel linha a linha.
// A OKX so entra como reserva quando a Binance esta fora, e fica anotado em "fonte".
async function livroOkx() {
  const d = await buscarJson(OKX + '/api/v5/market/books?instId=BTC-USDT-SWAP&sz=400');
  const l = d.data[0];
  return {
    fonte: 'okx-swap',
    bids: (l.bids || []).map((n) => [n[0], Number(n[1]) * 0.01]),
    asks: (l.asks || []).map((n) => [n[0], Number(n[1]) * 0.01])
  };
}

async function livro(mark) {
  try {
    let fonte = 'binance-futuros';
    let d;
    try {
      d = await buscarJson(BINANCE + '/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
    } catch {
      const reserva = await livroOkx();
      fonte = reserva.fonte;
      d = { bids: reserva.bids, asks: reserva.asks };
    }
    const compras = (d.bids || []).map((n) => ({ px: Number(n[0]), qty: Number(n[1]) }));
    const vendas = (d.asks || []).map((n) => ({ px: Number(n[0]), qty: Number(n[1]) }));
    const dentro = (lista) => lista.filter((n) => mark && Math.abs(n.px - mark) / mark <= 0.02);
    const somar = (lista) => lista.reduce((s, n) => s + n.px * n.qty, 0);
    const compras2 = dentro(compras);
    const vendas2 = dentro(vendas);
    const muros = compras2.concat(vendas2)
      .map((n) => ({ px: n.px, usd: n.px * n.qty, lado: n.px < (mark || 0) ? 'compra' : 'venda' }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 8);
    const usdCompra = somar(compras2);
    const usdVenda = somar(vendas2);
    return {
      fonte,
      faixaPct: 2,
      compraUsd: usdCompra,
      vendaUsd: usdVenda,
      desequilibrio: (usdCompra + usdVenda) ? (usdCompra - usdVenda) / (usdCompra + usdVenda) : null,
      muros
    };
  } catch (e) {
    return { erro: String(e.message || e) };
  }
}

function liquidacoes() {
  const agora = Date.now();
  const janela = (horas) => {
    const linhas = lerLinhas(ARQ_LIQUIDACOES, agora - horas * 3600 * 1000);
    let longUsd = 0, shortUsd = 0;
    for (const l of linhas) {
      const usd = Number(l.usd) || (Number(l.px) * Number(l.qty)) || 0;
      if (l.side === 'long') longUsd += usd; else shortUsd += usd;
    }
    return { longUsd, shortUsd, eventos: linhas.length };
  };
  return {
    h1: janela(1),
    h24: janela(24),
    fontes: ['bybit', 'okx', 'gate'],
    nota: 'Binance fora: sem stream confiavel e sem REST publico de liquidacao agregada.'
  };
}

function deltas(oiAtualUsd, markAtual) {
  const linhas = lerLinhas(ARQ_HISTORICO, Date.now() - 26 * 3600 * 1000);
  const somaOi = (linha) => {
    if (!linha || !linha.oi) return null;
    const valores = Object.values(linha.oi).filter((x) => x && Number.isFinite(x.usd));
    return valores.length ? valores.reduce((s, x) => s + x.usd, 0) : null;
  };
  const buscar = (horas) => {
    const alvo = Date.now() - horas * 3600 * 1000;
    let melhor = null;
    for (const linha of linhas) {
      if (!melhor || Math.abs(linha.t - alvo) < Math.abs(melhor.t - alvo)) melhor = linha;
    }
    return melhor;
  };
  const calcular = (horas) => {
    const antigo = buscar(horas);
    if (!antigo) return { oiPct: null, precoPct: null, temDados: false };
    const oiAntigo = somaOi(antigo);
    return {
      oiPct: (oiAntigo && oiAtualUsd) ? ((oiAtualUsd - oiAntigo) / oiAntigo) * 100 : null,
      precoPct: (antigo.mark && markAtual) ? ((markAtual - antigo.mark) / antigo.mark) * 100 : null,
      temDados: true
    };
  };
  return { h1: calcular(1), h24: calcular(24), linhasNoHistorico: linhas.length };
}

// -------------------------------------------------------------------- captura

async function capturar(corpo = {}, cfg = {}) {
  const precos = await mercado();
  const [oi, lsr, livroAgora] = await Promise.all([
    openInterest(precos.mark),
    longShort(),
    livro(precos.mark)
  ]);

  let leituraPreditivo = null;
  try { leituraPreditivo = await preditivo.calcular(); } catch (e) { leituraPreditivo = { erro: String(e.message || e) }; }

  const fng = await sentimento.medoGanancia();

  const registro = {
    ts: Date.now(),
    nota: typeof corpo.nota === 'string' ? corpo.nota.slice(0, 2000) : '',
    etiquetas: Array.isArray(corpo.etiquetas) ? corpo.etiquetas.map((e) => String(e).slice(0, 40)).slice(0, 12) : [],
    preco: precos,
    oi,
    deltas: deltas(oi.totalUsd, precos.mark),
    lsr,
    livro: livroAgora,
    liquidacoes: liquidacoes(),
    sentimento: {
      fng: fng.atual,
      noticias: resumir(sentimento.ultimoDoTipo('noticias')),
      fed: resumir(sentimento.ultimoDoTipo('fed'))
    },
    preditivo: leituraPreditivo ? {
      nota: leituraPreditivo.nota,
      rotulo: leituraPreditivo.rotulo,
      componentes: leituraPreditivo.componentes,
      probCorte: leituraPreditivo.polymarket ? leituraPreditivo.polymarket.probCorte : null,
      probAlta: leituraPreditivo.polymarket ? leituraPreditivo.polymarket.probAlta : null,
      dvol: leituraPreditivo.dvol ? leituraPreditivo.dvol.atual : null,
      erro: leituraPreditivo.erro || null
    } : null,
    // O painel soma o livro de varias exchanges e enxerga muros que o servidor nao mede.
    // Fica aqui, separado, para nao contaminar a serie de estudo.
    painel: corpo.painel || null,
    metodo: {
      versao: 1,
      origem: 'servidor',
      snapshotMin: (cfg.snapshotMin === undefined || cfg.snapshotMin === null) ? 0 : cfg.snapshotMin
    }
  };

  fs.mkdirSync(DIR_DADOS, { recursive: true });
  fs.appendFileSync(ARQ_SNAPSHOTS, JSON.stringify(registro) + '\n');
  return registro;
}

function resumir(analise) {
  if (!analise) return null;
  return { t: analise.t, score: analise.score, label: analise.label, resumo: analise.resumo };
}

function listar() {
  return lerLinhas(ARQ_SNAPSHOTS).sort((a, b) => b.ts - a.ts);
}

function apagar(pedido = {}) {
  if (pedido.tudo) {
    try { fs.writeFileSync(ARQ_SNAPSHOTS, ''); } catch { /* nao existia */ }
    return { apagados: 'tudo' };
  }
  const alvos = new Set((pedido.ts || []).map(Number));
  if (!alvos.size) return { apagados: 0 };
  const mantidos = lerLinhas(ARQ_SNAPSHOTS).filter((s) => !alvos.has(Number(s.ts)));
  fs.writeFileSync(ARQ_SNAPSHOTS, mantidos.map((s) => JSON.stringify(s)).join('\n') + (mantidos.length ? '\n' : ''));
  return { apagados: alvos.size, restantes: mantidos.length };
}

const COLUNAS = [
  ['data', (s) => new Date(s.ts).toISOString()],
  ['mark', (s) => s.preco && s.preco.mark],
  ['spot', (s) => s.preco && s.preco.spot],
  ['var24h_pct', (s) => s.preco && s.preco.var24hPct],
  ['funding', (s) => s.preco && s.preco.funding],
  ['basis_pct', (s) => s.preco && s.preco.basisPct],
  ['oi_total_usd', (s) => s.oi && s.oi.totalUsd],
  ['oi_binance_btc', (s) => s.oi && s.oi.binance && s.oi.binance.btc],
  ['oi_bybit_btc', (s) => s.oi && s.oi.bybit && s.oi.bybit.btc],
  ['oi_okx_btc', (s) => s.oi && s.oi.okx && s.oi.okx.btc],
  ['oi_hyperliquid_btc', (s) => s.oi && s.oi.hyperliquid && s.oi.hyperliquid.btc],
  ['delta_oi_1h_pct', (s) => s.deltas && s.deltas.h1 && s.deltas.h1.oiPct],
  ['delta_oi_24h_pct', (s) => s.deltas && s.deltas.h24 && s.deltas.h24.oiPct],
  ['lsr_varejo', (s) => s.lsr && s.lsr.varejoContas],
  ['lsr_grandes_posicoes', (s) => s.lsr && s.lsr.grandesPosicoes],
  ['livro_compra_usd', (s) => s.livro && s.livro.compraUsd],
  ['livro_venda_usd', (s) => s.livro && s.livro.vendaUsd],
  ['livro_desequilibrio', (s) => s.livro && s.livro.desequilibrio],
  ['liq_long_1h_usd', (s) => s.liquidacoes && s.liquidacoes.h1 && s.liquidacoes.h1.longUsd],
  ['liq_short_1h_usd', (s) => s.liquidacoes && s.liquidacoes.h1 && s.liquidacoes.h1.shortUsd],
  ['fng', (s) => s.sentimento && s.sentimento.fng && s.sentimento.fng.valor],
  ['score_noticias', (s) => s.sentimento && s.sentimento.noticias && s.sentimento.noticias.score],
  ['score_fed', (s) => s.sentimento && s.sentimento.fed && s.sentimento.fed.score],
  ['preditivo_nota', (s) => s.preditivo && s.preditivo.nota],
  ['preditivo_rotulo', (s) => s.preditivo && s.preditivo.rotulo],
  ['preditivo_prob_corte', (s) => s.preditivo && s.preditivo.probCorte],
  ['preditivo_prob_alta', (s) => s.preditivo && s.preditivo.probAlta],
  ['dvol', (s) => s.preditivo && s.preditivo.dvol],
  ['etiquetas', (s) => (s.etiquetas || []).join(' ')],
  ['nota', (s) => s.nota]
];

function celula(valor) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor).replace(/[\r\n]+/g, ' ');
  return /[;"]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
}

function exportarCsv() {
  const linhas = [COLUNAS.map((c) => c[0]).join(';')];
  for (const snap of listar()) {
    linhas.push(COLUNAS.map((c) => {
      let v;
      try { v = c[1](snap); } catch { v = null; }
      return celula(v);
    }).join(';'));
  }
  return linhas.join('\n') + '\n';
}

module.exports = { capturar, listar, apagar, exportarCsv };
