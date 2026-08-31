'use strict';
/*
 * BTC RADAR - servidor local
 * HTTP: arquivos estaticos + proxy com cache + rotas /api + coletores de fundo.
 * Sem dependencias externas. Exige Node >= 22 (fetch e WebSocket globais).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const sentimento = require('./sentiment.js');
const preditivo = require('./preditivo.js');
const snapshots = require('./snapshots.js');
const backup = require('./backup.js');

const RAIZ = __dirname;
const DIR_DADOS = path.join(RAIZ, 'data');
const DIR_BACKUPS = path.join(RAIZ, 'backups');
const ARQ_HISTORICO = path.join(DIR_DADOS, 'history.jsonl');
const ARQ_LIQUIDACOES = path.join(DIR_DADOS, 'liquidations.jsonl');
const ARQ_CONFIG = path.join(DIR_DADOS, 'config.json');

const PORTA = Number(process.env.PORT) || 8899;
const ENDERECO = process.env.HOST || '127.0.0.1';

// ---------------------------------------------------------------- utilidades

function garantirPastas() {
  fs.mkdirSync(DIR_DADOS, { recursive: true });
  fs.mkdirSync(DIR_BACKUPS, { recursive: true });
}

function lerConfigArquivo() {
  try {
    return JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

// A chave do ambiente vence a do arquivo: da pra rodar sem gravar segredo em disco.
function configEfetiva() {
  const cfg = lerConfigArquivo();
  const chaveAmbiente = process.env.GEMINI_KEY || '';
  return {
    geminiKey: chaveAmbiente || cfg.geminiKey || '',
    geminiModel: cfg.geminiModel || 'gemini-3.6-flash',
    // Cuidado: snapshotMin 0 e falsy. Testar undefined/null, nunca usar || 15.
    snapshotMin: (cfg.snapshotMin === undefined || cfg.snapshotMin === null) ? 0 : Number(cfg.snapshotMin),
    chaveVemDoAmbiente: Boolean(chaveAmbiente)
  };
}

function salvarConfig(parcial) {
  const atual = lerConfigArquivo();
  const novo = Object.assign(
    { geminiKey: '', geminiModel: 'gemini-3.6-flash', snapshotMin: 0 },
    atual,
    parcial
  );
  fs.writeFileSync(ARQ_CONFIG, JSON.stringify(novo, null, 2));
  return novo;
}

function anexarLinha(arquivo, objeto) {
  try {
    fs.appendFileSync(arquivo, JSON.stringify(objeto) + '\n');
  } catch (e) {
    console.error('[dados] falha ao gravar', path.basename(arquivo), e.message);
  }
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
    } catch { /* linha truncada: ignora */ }
  }
  return saida;
}

async function buscarJson(url, opcoes = {}, ms = 12000) {
  const resposta = await fetch(url, Object.assign({ signal: AbortSignal.timeout(ms) }, opcoes));
  if (!resposta.ok) throw new Error(url.split('?')[0] + ' respondeu ' + resposta.status);
  return resposta.json();
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function enviarJson(res, dados, status = 200) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(corpo);
}

function lerCorpo(req, limite = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (pedaco) => {
      dados += pedaco;
      if (dados.length > limite) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

// -------------------------------------------------------------------- proxy

const ALVOS = {
  binance: 'https://fapi.binance.com',
  spot: 'https://api.binance.com',
  bybit: 'https://api.bybit.com',
  okx: 'https://www.okx.com',
  hl: 'https://api.hyperliquid.xyz'
};

const cacheProxy = new Map();

function ttlDe(caminho) {
  const c = caminho.toLowerCase();
  if (c.includes('depth') || c.includes('orderbook') || c.includes('l2book') || c.includes('livro')) return 3000;
  if (c.includes('openinterest') || c.includes('rubik') || c.includes('account-ratio')) return 25000;
  if (c.includes('liquidation-orders')) return 15000;
  if (c.includes('klines') || c.includes('ticker') || c.includes('premiumindex')) return 10000;
  return 8000;
}

async function tratarProxy(req, res, caminhoCompleto) {
  const resto = caminhoCompleto.slice('/px/'.length);
  const barra = resto.indexOf('/');
  if (barra < 0) return enviarJson(res, { erro: 'rota de proxy invalida' }, 400);
  const alvo = resto.slice(0, barra);
  const caminho = resto.slice(barra);
  const base = ALVOS[alvo];
  if (!base) return enviarJson(res, { erro: 'alvo desconhecido: ' + alvo }, 400);

  const corpo = req.method === 'POST' ? await lerCorpo(req) : '';
  const chave = req.method + ' ' + alvo + caminho + ' ' + corpo;
  const agora = Date.now();
  const guardado = cacheProxy.get(chave);
  if (guardado && agora - guardado.ts < ttlDe(caminho)) {
    res.writeHead(200, { 'content-type': guardado.tipo, 'cache-control': 'no-store', 'x-btcr-cache': 'quente' });
    return res.end(guardado.corpo);
  }

  try {
    const opcoes = { method: req.method, headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) };
    if (req.method === 'POST') {
      opcoes.body = corpo;
      opcoes.headers['content-type'] = 'application/json';
    }
    const resposta = await fetch(base + caminho, opcoes);
    const texto = await resposta.text();
    const tipo = resposta.headers.get('content-type') || 'application/json; charset=utf-8';
    if (resposta.ok) {
      cacheProxy.set(chave, { ts: agora, corpo: texto, tipo });
      if (cacheProxy.size > 400) cacheProxy.delete(cacheProxy.keys().next().value);
    }
    res.writeHead(resposta.status, { 'content-type': tipo, 'cache-control': 'no-store' });
    return res.end(texto);
  } catch (e) {
    // Upstream oscilou: devolve a resposta velha em vez de zerar o painel.
    if (guardado) {
      res.writeHead(200, { 'content-type': guardado.tipo, 'cache-control': 'no-store', 'x-btcr-cache': 'velho' });
      return res.end(guardado.corpo);
    }
    return enviarJson(res, { erro: String(e.message || e) }, 502);
  }
}

// ------------------------------------------------------- coletor de historico

// Quando a Binance nao responde (bloqueio regional, instabilidade), a OKX cobre
// preco e funding para o painel nao ficar zerado.
async function precoEFundingOkx() {
  const [swap, avista, taxa] = await Promise.all([
    buscarJson(ALVOS.okx + '/api/v5/market/ticker?instId=BTC-USDT-SWAP').catch(() => null),
    buscarJson(ALVOS.okx + '/api/v5/market/ticker?instId=BTC-USDT').catch(() => null),
    buscarJson(ALVOS.okx + '/api/v5/public/funding-rate?instId=BTC-USDT-SWAP').catch(() => null)
  ]);
  return {
    mark: swap && swap.data && swap.data[0] ? numero(swap.data[0].last) : null,
    spot: avista && avista.data && avista.data[0] ? numero(avista.data[0].last) : null,
    funding: taxa && taxa.data && taxa.data[0] ? numero(taxa.data[0].fundingRate) : null
  };
}

async function precoEFunding() {
  const [premio, spot] = await Promise.all([
    buscarJson(ALVOS.binance + '/fapi/v1/premiumIndex?symbol=BTCUSDT').catch(() => null),
    buscarJson(ALVOS.spot + '/api/v3/ticker/price?symbol=BTCUSDT').catch(() => null)
  ]);
  let mark = premio ? numero(premio.markPrice) : null;
  let precoSpot = spot ? numero(spot.price) : (premio ? numero(premio.indexPrice) : null);
  let funding = premio ? numero(premio.lastFundingRate) : null;

  if (!mark || !precoSpot || funding === null) {
    const reserva = await precoEFundingOkx();
    mark = mark || reserva.mark;
    precoSpot = precoSpot || reserva.spot;
    funding = funding === null ? reserva.funding : funding;
  }

  const basisPct = (mark && precoSpot) ? ((mark - precoSpot) / precoSpot) * 100 : null;
  return { mark, spot: precoSpot, funding, basisPct };
}

async function openInterestBinance(mark) {
  const dados = await buscarJson(ALVOS.binance + '/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=1');
  const ultimo = Array.isArray(dados) ? dados[dados.length - 1] : null;
  if (!ultimo) return null;
  const btc = numero(ultimo.sumOpenInterest);
  const usd = numero(ultimo.sumOpenInterestValue) || (btc && mark ? btc * mark : null);
  return { btc, usd };
}

async function openInterestBybit(mark) {
  const dados = await buscarJson(ALVOS.bybit + '/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=5min&limit=1');
  const item = dados && dados.result && Array.isArray(dados.result.list) ? dados.result.list[0] : null;
  if (!item) return null;
  const btc = numero(item.openInterest);
  return { btc, usd: btc && mark ? btc * mark : null };
}

async function openInterestOkx(mark) {
  const dados = await buscarJson(ALVOS.okx + '/api/v5/public/open-interest?instId=BTC-USDT-SWAP');
  const item = dados && Array.isArray(dados.data) ? dados.data[0] : null;
  if (!item) return null;
  const btc = numero(item.oiCcy); // oiCcy ja vem em BTC; oi vem em contratos
  return { btc, usd: numero(item.oiUsd) || (btc && mark ? btc * mark : null) };
}

async function openInterestHyperliquid(mark) {
  const dados = await buscarJson(ALVOS.hl + '/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' })
  });
  if (!Array.isArray(dados) || dados.length < 2) return null;
  const universo = dados[0] && dados[0].universe ? dados[0].universe : [];
  const contextos = dados[1] || [];
  const indice = universo.findIndex((a) => a && a.name === 'BTC');
  if (indice < 0 || !contextos[indice]) return null;
  const ctx = contextos[indice];
  const btc = numero(ctx.openInterest);
  const preco = numero(ctx.markPx) || mark;
  return { btc, usd: btc && preco ? btc * preco : null };
}

async function coletarHistorico() {
  try {
    const precos = await precoEFunding();
    const [binance, bybit, okx, hyperliquid] = await Promise.all([
      openInterestBinance(precos.mark).catch(() => null),
      openInterestBybit(precos.mark).catch(() => null),
      openInterestOkx(precos.mark).catch(() => null),
      openInterestHyperliquid(precos.mark).catch(() => null)
    ]);
    if (!precos.mark && !binance && !bybit && !okx && !hyperliquid) return;
    anexarLinha(ARQ_HISTORICO, {
      t: Date.now(),
      mark: precos.mark,
      spot: precos.spot,
      funding: precos.funding,
      basisPct: precos.basisPct,
      oi: { binance, bybit, okx, hyperliquid }
    });
  } catch (e) {
    console.error('[historico] ' + (e.message || e));
  }
}

// ----------------------------------------------------- coletor de liquidacoes

const vistasLiquidacao = new Set();

function chaveLiquidacao(l) {
  return l.src + '|' + l.t + '|' + l.px + '|' + l.qty;
}

function gravarLiquidacao(l) {
  if (!l || !l.t || !Number.isFinite(l.px) || !Number.isFinite(l.qty)) return false;
  const chave = chaveLiquidacao(l);
  if (vistasLiquidacao.has(chave)) return false;
  vistasLiquidacao.add(chave);
  if (vistasLiquidacao.size > 20000) {
    // Set mantem ordem de insercao: descarta as mais velhas.
    const iterador = vistasLiquidacao.values();
    for (let i = 0; i < 5000; i++) vistasLiquidacao.delete(iterador.next().value);
  }
  anexarLinha(ARQ_LIQUIDACOES, l);
  return true;
}

function carregarChavesRecentes() {
  const desde = Date.now() - 6 * 3600 * 1000;
  for (const l of lerLinhas(ARQ_LIQUIDACOES, desde)) vistasLiquidacao.add(chaveLiquidacao(l));
}

// Bybit ao vivo por WebSocket no proprio servidor.
function iniciarBybitWebSocket() {
  if (typeof WebSocket === 'undefined') {
    console.warn('[liquidacoes] WebSocket global ausente (Node < 22): coletor da Bybit desligado. O resto segue funcionando.');
    return;
  }
  let ws = null;
  let ping = null;

  const conectar = () => {
    try {
      ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    } catch (e) {
      console.error('[bybit] ' + (e.message || e));
      return setTimeout(conectar, 4000);
    }
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }));
      clearInterval(ping);
      ping = setInterval(() => {
        try { ws.send(JSON.stringify({ op: 'ping' })); } catch { /* fecha sozinho */ }
      }, 20000);
      console.log('[bybit] stream de liquidacoes conectado');
    });
    ws.addEventListener('message', (evento) => {
      let msg;
      try { msg = JSON.parse(evento.data); } catch { return; }
      if (!msg || !Array.isArray(msg.data)) return;
      for (const item of msg.data) {
        const px = numero(item.p);
        const qty = numero(item.v);
        if (!px || !qty) continue;
        // S === 'Sell' significa que uma posicao comprada (long) foi liquidada.
        gravarLiquidacao({
          t: Number(item.T) || Date.now(),
          src: 'bybit',
          side: item.S === 'Sell' ? 'long' : 'short',
          px,
          qty,
          usd: px * qty
        });
      }
    });
    const reconectar = () => {
      clearInterval(ping);
      try { ws.close(); } catch { /* ja fechado */ }
      setTimeout(conectar, 4000);
    };
    ws.addEventListener('close', reconectar);
    ws.addEventListener('error', () => { /* o close cuida da reconexao */ });
  };

  conectar();
}

let ctValOkx = 0.01;

async function lerCtValOkx() {
  try {
    const dados = await buscarJson(ALVOS.okx + '/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP');
    const item = dados && Array.isArray(dados.data) ? dados.data[0] : null;
    const v = item ? numero(item.ctVal) : null;
    if (v) ctValOkx = v;
  } catch { /* mantem 0,01 */ }
}

async function coletarLiquidacoesOkx() {
  try {
    // instFamily e obrigatorio nesta rota; sem ele a OKX devolve erro de parametro.
    const dados = await buscarJson(ALVOS.okx + '/api/v5/public/liquidation-orders?instType=SWAP&instFamily=BTC-USDT&state=filled&limit=100');
    const blocos = dados && Array.isArray(dados.data) ? dados.data : [];
    for (const bloco of blocos) {
      for (const d of (bloco.details || [])) {
        const px = numero(d.bkPx);
        const contratos = numero(d.sz);
        if (!px || !contratos) continue;
        gravarLiquidacao({
          t: Number(d.ts) || Date.now(),
          src: 'okx',
          side: d.side === 'sell' ? 'long' : 'short',
          px,
          qty: contratos * ctValOkx,
          usd: px * contratos * ctValOkx
        });
      }
    }
  } catch (e) {
    console.error('[okx] liquidacoes: ' + (e.message || e));
  }
}

async function coletarLiquidacoesGate() {
  try {
    const dados = await buscarJson('https://api.gateio.ws/api/v4/futures/usdt/liq_orders?contract=BTC_USDT&limit=100');
    if (!Array.isArray(dados)) return;
    for (const d of dados) {
      const px = numero(d.price) || numero(d.fill_price);
      const tamanho = numero(d.size);
      if (!px || !tamanho) continue;
      const qty = Math.abs(tamanho) * 0.0001; // quanto_multiplier do BTC_USDT
      gravarLiquidacao({
        t: (Number(d.time) || Math.floor(Date.now() / 1000)) * 1000,
        src: 'gate',
        side: tamanho < 0 ? 'long' : 'short', // size negativo = long estourado
        px,
        qty,
        usd: px * qty
      });
    }
  } catch (e) {
    console.error('[gate] liquidacoes: ' + (e.message || e));
  }
}

/*
 * A Binance nao entra nas liquidacoes de proposito:
 * o stream de futuros nao entrega mensagem em varias regioes, nao existe REST
 * publico de liquidacao agregada e o arquivo liquidationSnapshot saiu do ar.
 * Preferimos deixar isso escrito na interface a inventar numero.
 */

// -------------------------------------------------------------------- rotas

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function servirEstatico(res, caminho) {
  const arquivo = path.join(RAIZ, caminho === '/' ? 'index.html' : caminho.replace(/^\/+/, ''));
  if (!arquivo.startsWith(RAIZ)) return enviarJson(res, { erro: 'caminho invalido' }, 400);
  fs.readFile(arquivo, (erro, conteudo) => {
    if (erro) return enviarJson(res, { erro: 'nao encontrado' }, 404);
    res.writeHead(200, { 'content-type': TIPOS[path.extname(arquivo)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(conteudo);
  });
}

async function tratarApi(req, res, url) {
  const rota = url.pathname;
  const horas = Number(url.searchParams.get('hours')) || 24;
  const desde = Date.now() - horas * 3600 * 1000;

  if (rota === '/api/history' && req.method === 'GET') {
    return enviarJson(res, { horas, linhas: lerLinhas(ARQ_HISTORICO, desde) });
  }

  if (rota === '/api/liq' && req.method === 'GET') {
    return enviarJson(res, { horas, linhas: lerLinhas(ARQ_LIQUIDACOES, desde) });
  }

  if (rota === '/api/liq' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req)) || '{}');
    const lista = Array.isArray(corpo) ? corpo : (corpo.linhas || []);
    let gravadas = 0;
    for (const item of lista) {
      const ok = gravarLiquidacao({
        t: Number(item.t) || Date.now(),
        src: String(item.src || 'navegador'),
        side: item.side === 'long' ? 'long' : 'short',
        px: numero(item.px),
        qty: numero(item.qty),
        usd: numero(item.usd) || (numero(item.px) * numero(item.qty))
      });
      if (ok) gravadas++;
    }
    return enviarJson(res, { gravadas, recebidas: lista.length });
  }

  if (rota === '/api/fng') {
    return enviarJson(res, await sentimento.medoGanancia());
  }

  if (rota === '/api/sentiment') {
    return enviarJson(res, await sentimento.estado(configEfetiva()));
  }

  if (rota === '/api/sentiment/analise') {
    const tipo = url.searchParams.get('kind') === 'fed' ? 'fed' : 'noticias';
    const resultado = await sentimento.analisar(tipo, configEfetiva());
    return enviarJson(res, resultado, resultado && resultado.erro ? 502 : 200);
  }

  if (rota === '/api/preditivo') {
    return enviarJson(res, await preditivo.calcular());
  }

  if (rota === '/api/snapshot' && req.method === 'GET') {
    if (url.searchParams.get('formato') === 'csv') {
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="btc-radar-snapshots.csv"'
      });
      return res.end(snapshots.exportarCsv());
    }
    return enviarJson(res, { linhas: snapshots.listar() });
  }

  if (rota === '/api/snapshot' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req)) || '{}');
    const salvo = await snapshots.capturar(corpo, configEfetiva());
    return enviarJson(res, salvo);
  }

  if (rota === '/api/snapshot/apagar' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req)) || '{}');
    return enviarJson(res, snapshots.apagar(corpo));
  }

  if (rota === '/api/backup' && req.method === 'GET') {
    return enviarJson(res, backup.status());
  }

  if (rota === '/api/backup' && req.method === 'POST') {
    return enviarJson(res, backup.rodar());
  }

  if (rota === '/api/config' && req.method === 'GET') {
    const cfg = configEfetiva();
    // Nunca devolve a chave para o navegador, so diz se existe.
    return enviarJson(res, {
      temChave: Boolean(cfg.geminiKey),
      chaveVemDoAmbiente: cfg.chaveVemDoAmbiente,
      geminiModel: cfg.geminiModel,
      snapshotMin: cfg.snapshotMin
    });
  }

  if (rota === '/api/config' && req.method === 'POST') {
    const corpo = JSON.parse((await lerCorpo(req)) || '{}');
    const parcial = {};
    if (typeof corpo.geminiKey === 'string') parcial.geminiKey = corpo.geminiKey.trim();
    if (typeof corpo.geminiModel === 'string' && corpo.geminiModel.trim()) parcial.geminiModel = corpo.geminiModel.trim();
    if (corpo.snapshotMin !== undefined) parcial.snapshotMin = Number(corpo.snapshotMin) || 0;
    salvarConfig(parcial);
    const cfg = configEfetiva();
    return enviarJson(res, { ok: true, temChave: Boolean(cfg.geminiKey), geminiModel: cfg.geminiModel });
  }

  return enviarJson(res, { erro: 'rota desconhecida' }, 404);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + ENDERECO + ':' + PORTA);
  try {
    if (url.pathname.startsWith('/px/')) return await tratarProxy(req, res, url.pathname + url.search);
    if (url.pathname.startsWith('/api/')) return await tratarApi(req, res, url);
    return servirEstatico(res, url.pathname);
  } catch (e) {
    console.error('[http] ' + (e.stack || e));
    if (!res.headersSent) enviarJson(res, { erro: String(e.message || e) }, 500);
  }
});

// ------------------------------------------------------------------- partida

function iniciar() {
  garantirPastas();
  carregarChavesRecentes();

  servidor.listen(PORTA, ENDERECO, () => {
    console.log('BTC RADAR no ar em http://' + ENDERECO + ':' + PORTA);
    const cfg = configEfetiva();
    if (!cfg.geminiKey) {
      console.log('[config] sem chave da IA: o painel pede a chave na primeira abertura (ou use GEMINI_KEY no ambiente).');
    }
  });

  coletarHistorico();
  setInterval(coletarHistorico, 60 * 1000);

  iniciarBybitWebSocket();
  lerCtValOkx();
  coletarLiquidacoesOkx();
  coletarLiquidacoesGate();
  setInterval(coletarLiquidacoesOkx, 20 * 1000);
  setInterval(coletarLiquidacoesGate, 20 * 1000);

  backup.agendar();
}

if (require.main === module) iniciar();

module.exports = { servidor, iniciar, configEfetiva, PORTA };
