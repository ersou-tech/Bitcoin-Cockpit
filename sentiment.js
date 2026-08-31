'use strict';
/*
 * BTC RADAR - sentimento
 * Medo & Ganancia, manchetes por RSS, documentos do Fed e a leitura da IA.
 * A chave da IA vive so aqui no servidor; o navegador nunca ve.
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR_DADOS = path.join(__dirname, 'data');
const ARQ_SENTIMENTO = path.join(DIR_DADOS, 'sentiment.jsonl');

const JANELA_NOTICIAS_MS = 36 * 3600 * 1000;

// Reuters e AP bloqueiam robo (403): ficam fora de proposito.
const FONTES_RSS = [
  { nome: 'CNBC Economia', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', grupo: 'macro' },
  { nome: 'CNBC Financas', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', grupo: 'macro' },
  { nome: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', grupo: 'macro' },
  { nome: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', grupo: 'macro' },
  { nome: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', grupo: 'macro' },
  { nome: 'InfoMoney', url: 'https://www.infomoney.com.br/feed/', grupo: 'macro' },
  { nome: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', grupo: 'cripto' },
  { nome: 'Cointelegraph', url: 'https://cointelegraph.com/rss', grupo: 'cripto' },
  { nome: 'The Block', url: 'https://www.theblock.co/rss.xml', grupo: 'cripto' },
  { nome: 'Decrypt', url: 'https://decrypt.co/feed', grupo: 'cripto' },
  { nome: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed', grupo: 'cripto' }
];

const PALAVRAS_CHAVE = [
  'fed', 'federal reserve', 'fomc', 'powell', 'inflacao', 'inflação', 'inflation', 'cpi', 'pce',
  'juro', 'juros', 'interest rate', 'rate cut', 'rate hike', 'yield', 'treasury',
  'emprego', 'payroll', 'jobs', 'unemployment', 'desemprego',
  'dolar', 'dólar', 'dollar', 'dxy', 'bolsa', 'stocks', 's&p', 'nasdaq', 'recessao', 'recession',
  'tarifa', 'tariff', 'china', 'liquidez', 'liquidity', 'qt', 'quantitative',
  'bitcoin', 'btc', 'ether', 'ethereum', 'crypto', 'cripto', 'etf', 'stablecoin', 'sec', 'halving'
];

const FEEDS_FED = [
  { nome: 'Comunicados de politica monetaria', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
  { nome: 'Discursos', url: 'https://www.federalreserve.gov/feeds/speeches.xml' }
];

const TERMOS_FED = [
  'federal funds', 'interest rate', 'inflation', 'price stability', 'balance sheet',
  'reserve', 'securities holdings', 'dollar', 'financial conditions', 'labor market',
  'monetary policy', 'target range', 'runoff', 'tightening', 'easing'
];

// ---------------------------------------------------------------- utilidades

async function buscarTexto(url, ms = 15000) {
  const resposta = await fetch(url, {
    signal: AbortSignal.timeout(ms),
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) BTC-RADAR/1.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  if (!resposta.ok) throw new Error(url.split('?')[0] + ' respondeu ' + resposta.status);
  return resposta.text();
}

function semTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function pegarTag(bloco, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const achado = bloco.match(re);
  if (!achado) return '';
  return semTags(achado[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
}

function pegarLink(bloco) {
  const direto = pegarTag(bloco, 'link');
  if (direto) return direto;
  const href = bloco.match(/<link[^>]*href="([^"]+)"/i);
  return href ? href[1] : '';
}

function lerRss(xml) {
  const itens = [];
  const blocos = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const bloco of blocos) {
    const titulo = pegarTag(bloco, 'title');
    if (!titulo) continue;
    const data = pegarTag(bloco, 'pubDate') || pegarTag(bloco, 'published') || pegarTag(bloco, 'updated') || pegarTag(bloco, 'dc:date');
    const quando = data ? Date.parse(data) : NaN;
    itens.push({
      titulo,
      link: pegarLink(bloco),
      resumo: (pegarTag(bloco, 'description') || pegarTag(bloco, 'summary')).slice(0, 400),
      t: Number.isFinite(quando) ? quando : Date.now()
    });
  }
  return itens;
}

function anexar(objeto) {
  try {
    fs.mkdirSync(DIR_DADOS, { recursive: true });
    fs.appendFileSync(ARQ_SENTIMENTO, JSON.stringify(objeto) + '\n');
  } catch (e) {
    console.error('[sentimento] gravacao: ' + e.message);
  }
}

function ultimoDoTipo(tipo) {
  let bruto;
  try {
    bruto = fs.readFileSync(ARQ_SENTIMENTO, 'utf8');
  } catch {
    return null;
  }
  const linhas = bruto.split('\n').filter(Boolean);
  for (let i = linhas.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(linhas[i]);
      if (obj.tipo === tipo) return obj;
    } catch { /* linha truncada */ }
  }
  return null;
}

// ------------------------------------------------------------ medo e ganancia

async function medoGanancia() {
  try {
    const resposta = await fetch('https://api.alternative.me/fng/?limit=60', { signal: AbortSignal.timeout(12000) });
    if (!resposta.ok) throw new Error('alternative.me respondeu ' + resposta.status);
    const dados = await resposta.json();
    const serie = (dados.data || []).map((d) => ({
      valor: Number(d.value),
      rotulo: d.value_classification,
      t: Number(d.timestamp) * 1000
    })).sort((a, b) => a.t - b.t);
    const atual = serie[serie.length - 1] || null;
    return { atual, serie };
  } catch (e) {
    return { erro: String(e.message || e), atual: null, serie: [] };
  }
}

// -------------------------------------------------------------------- noticias

function relevante(titulo) {
  const t = titulo.toLowerCase();
  return PALAVRAS_CHAVE.some((p) => t.includes(p));
}

async function noticias() {
  const limite = Date.now() - JANELA_NOTICIAS_MS;
  const resultados = await Promise.all(FONTES_RSS.map(async (fonte) => {
    try {
      const xml = await buscarTexto(fonte.url);
      return lerRss(xml)
        .filter((i) => i.t >= limite && relevante(i.titulo))
        .slice(0, 12)
        .map((i) => Object.assign({ fonte: fonte.nome, grupo: fonte.grupo }, i));
    } catch (e) {
      return [{ fonte: fonte.nome, grupo: fonte.grupo, falha: String(e.message || e) }];
    }
  }));

  const itens = [];
  const falhas = [];
  for (const lista of resultados) {
    for (const item of lista) {
      if (item.falha) falhas.push({ fonte: item.fonte, motivo: item.falha });
      else itens.push(item);
    }
  }
  itens.sort((a, b) => b.t - a.t);
  return { itens: itens.slice(0, 60), falhas, janelaHoras: JANELA_NOTICIAS_MS / 3600000 };
}

// ------------------------------------------------------------------------ fed

function prioridadeFed(titulo) {
  const t = titulo.toLowerCase();
  if (t.includes('federal open market committee') && (t.includes('statement') || t.includes('decision'))) return 4;
  if (t.includes('fomc') && t.includes('statement')) return 4;
  if (t.includes('minutes')) return 3;
  if (t.includes('powell') || t.includes('chair')) return 2;
  if (t.includes('speech') || t.includes('remarks')) return 1;
  return 0;
}

function administrativo(titulo) {
  const t = titulo.toLowerCase();
  return t.includes('personnel') || t.includes('appoint') || t.includes('agenda') ||
    t.includes('conference') || t.includes('enforcement') || t.includes('order against');
}

function extrairArtigo(html) {
  // A pagina do release traz o menu inteiro. So o bloco id="article" tem o texto.
  const marca = html.indexOf('id="article"');
  if (marca < 0) return '';
  const recorte = html.slice(marca, marca + 90000);
  return semTags(recorte);
}

function linksInternos(html) {
  const achados = html.match(/href="(\/(?:monetarypolicy|newsevents)\/[^"']+\.htm)"/gi) || [];
  return achados.map((a) => a.replace(/^href="/i, '').replace(/"$/, ''));
}

async function textoDoDocumento(url) {
  const html = await buscarTexto(url);
  let texto = extrairArtigo(html);
  if (texto.length < 900) {
    // O aviso de imprensa e curto: o documento de verdade esta num link interno.
    for (const caminho of linksInternos(html).slice(0, 3)) {
      try {
        const interno = await buscarTexto('https://www.federalreserve.gov' + caminho);
        const textoInterno = extrairArtigo(interno);
        if (textoInterno.length > texto.length) {
          texto = textoInterno;
          if (texto.length > 2000) break;
        }
      } catch { /* tenta o proximo */ }
    }
  }
  return texto;
}

function trechosRelevantes(texto) {
  const frases = texto.split(/(?<=[.;])\s+/);
  const guardadas = [];
  for (const frase of frases) {
    const f = frase.toLowerCase();
    if (TERMOS_FED.some((termo) => f.includes(termo))) guardadas.push(frase.trim());
    if (guardadas.length >= 40) break;
  }
  return guardadas;
}

async function documentosFed() {
  const candidatos = [];
  for (const feed of FEEDS_FED) {
    try {
      const xml = await buscarTexto(feed.url);
      for (const item of lerRss(xml).slice(0, 15)) {
        if (administrativo(item.titulo)) continue;
        candidatos.push(Object.assign({ feed: feed.nome, prioridade: prioridadeFed(item.titulo) }, item));
      }
    } catch (e) {
      candidatos.push({ feed: feed.nome, falha: String(e.message || e), prioridade: -1, titulo: feed.nome, t: 0 });
    }
  }
  const validos = candidatos.filter((c) => !c.falha);
  validos.sort((a, b) => (b.prioridade - a.prioridade) || (b.t - a.t));

  const escolhidos = [];
  for (const item of validos.slice(0, 3)) {
    try {
      const texto = await textoDoDocumento(item.link);
      const trechos = trechosRelevantes(texto);
      if (!trechos.length) continue;
      escolhidos.push({ titulo: item.titulo, link: item.link, t: item.t, prioridade: item.prioridade, trechos });
    } catch (e) {
      escolhidos.push({ titulo: item.titulo, link: item.link, t: item.t, prioridade: item.prioridade, falha: String(e.message || e) });
    }
  }
  return {
    documentos: escolhidos,
    falhas: candidatos.filter((c) => c.falha).map((c) => ({ fonte: c.feed, motivo: c.falha }))
  };
}

// ------------------------------------------------------------------------- ia

const ESPERAS = [2000, 6000, 14000];

async function chamarGemini(prompt, cfg) {
  if (!cfg.geminiKey) throw new Error('sem chave da IA: cadastre em AJUSTES ou use a variavel GEMINI_KEY');
  const modelo = cfg.geminiModel || 'gemini-3.6-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent';
  const corpo = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // A ferramenta google_search devolve 429 em chave gratuita: nao usar aqui.
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
  };

  let ultimoErro = null;
  for (let tentativa = 0; tentativa <= ESPERAS.length; tentativa++) {
    try {
      const resposta = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.geminiKey },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(60000)
      });
      if (resposta.status === 503 || resposta.status === 429) {
        ultimoErro = new Error('modelo ocupado (' + resposta.status + ')');
        if (tentativa < ESPERAS.length) {
          await new Promise((r) => setTimeout(r, ESPERAS[tentativa]));
          continue;
        }
        throw ultimoErro;
      }
      if (!resposta.ok) throw new Error('Gemini respondeu ' + resposta.status + ': ' + (await resposta.text()).slice(0, 300));
      const dados = await resposta.json();
      const texto = dados && dados.candidates && dados.candidates[0] &&
        dados.candidates[0].content && dados.candidates[0].content.parts
        ? dados.candidates[0].content.parts.map((p) => p.text || '').join('')
        : '';
      if (!texto) throw new Error('resposta da IA veio vazia');
      return JSON.parse(texto);
    } catch (e) {
      ultimoErro = e;
      const recuperavel = /ocupado|fetch failed|timeout|abort/i.test(String(e.message || e));
      if (recuperavel && tentativa < ESPERAS.length) {
        await new Promise((r) => setTimeout(r, ESPERAS[tentativa]));
        continue;
      }
      throw e;
    }
  }
  throw ultimoErro || new Error('falha na IA');
}

const FORMA = [
  'Responda SOMENTE com JSON valido neste formato:',
  '{"score": numero de -100 a 100, "label": "texto curto", "resumo": "2 a 4 frases",',
  ' "pontos": [{"titulo": "curto", "texto": "1 a 2 frases", "tom": "positivo|neutro|negativo"}],',
  ' "destaques": ["frase curta", "frase curta"]}',
  'Escreva em portugues simples, como quem explica para alguem que nao e do mercado.',
  'Descreva o que o mercado esta vivendo. NUNCA recomende comprar, vender ou segurar.',
  'score negativo = ambiente ruim para ativos de risco; positivo = ambiente favoravel.'
].join('\n');

function promptNoticias(pacote) {
  const lista = pacote.itens.slice(0, 45)
    .map((i) => '- [' + i.fonte + '] ' + i.titulo)
    .join('\n');
  return [
    'Voce le manchetes de economia e cripto das ultimas ' + pacote.janelaHoras + ' horas e resume o clima do mercado.',
    '',
    'MANCHETES:',
    lista,
    '',
    FORMA,
    'Use de 4 a 6 itens em "pontos", agrupando assuntos parecidos em vez de repetir manchete por manchete.'
  ].join('\n');
}

function promptFed(pacote) {
  const corpo = pacote.documentos.map((d) => {
    if (d.falha) return '- ' + d.titulo + ' (nao foi possivel ler: ' + d.falha + ')';
    return '### ' + d.titulo + '\n' + d.trechos.slice(0, 25).join('\n');
  }).join('\n\n');
  return [
    'Voce le documentos do Federal Reserve e explica o que eles significam para o mercado de cripto.',
    '',
    'O que FAVORECE cripto: corte de juro, sinal de corte a caminho, fim ou reducao do QT,',
    'mais liquidez no sistema, crescimento das reservas bancarias, dolar mais fraco, tom suave.',
    'O que DESFAVORECE cripto: juro alto ou subindo, QT rodando, retirada de liquidez,',
    'reservas caindo, dolar forte, discurso duro contra inflacao.',
    '',
    'DOCUMENTOS:',
    corpo,
    '',
    FORMA,
    'Em "destaques", cite trechos curtos do proprio documento que sustentam a leitura.'
  ].join('\n');
}

async function analisar(tipo, cfg) {
  try {
    if (tipo === 'fed') {
      const pacote = await documentosFed();
      if (!pacote.documentos.length) {
        return { erro: 'nenhum documento do Fed pode ser lido agora', falhas: pacote.falhas };
      }
      const leitura = await chamarGemini(promptFed(pacote), cfg);
      const registro = Object.assign({ tipo: 'fed', t: Date.now(), fontes: pacote.documentos.map((d) => ({ titulo: d.titulo, link: d.link })) }, leitura);
      anexar(registro);
      return registro;
    }
    const pacote = await noticias();
    if (!pacote.itens.length) return { erro: 'nenhuma manchete relevante nas ultimas 36h', falhas: pacote.falhas };
    const leitura = await chamarGemini(promptNoticias(pacote), cfg);
    const registro = Object.assign({ tipo: 'noticias', t: Date.now(), quantidade: pacote.itens.length, falhas: pacote.falhas }, leitura);
    anexar(registro);
    return registro;
  } catch (e) {
    return { erro: String(e.message || e), tipo };
  }
}

async function estado(cfg) {
  const [fng, pacoteNoticias] = await Promise.all([medoGanancia(), noticias()]);
  return {
    t: Date.now(),
    temChave: Boolean(cfg && cfg.geminiKey),
    fng,
    noticias: pacoteNoticias,
    analises: {
      noticias: ultimoDoTipo('noticias'),
      fed: ultimoDoTipo('fed')
    }
  };
}

module.exports = { medoGanancia, noticias, documentosFed, analisar, estado, ultimoDoTipo };
