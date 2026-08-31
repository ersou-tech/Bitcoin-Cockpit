'use strict';
/*
 * Teste de fumaca: sobe o servidor de verdade e bate nas rotas principais.
 * Rodar com: npm test
 * As rotas /api/fng e /api/preditivo dependem de internet. Sem rede, rode com
 * BTCR_SEM_REDE=1 npm test para checar so o que e local.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

const RAIZ = path.join(__dirname, '..');
const SEM_REDE = process.env.BTCR_SEM_REDE === '1';

let processo = null;
let porta = 0;

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function esperarSubir(porta, tentativas = 60) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + porta + '/api/history?hours=1', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function pegar(rota, ms = 90000) {
  const resposta = await fetch('http://127.0.0.1:' + porta + rota, { signal: AbortSignal.timeout(ms) });
  const corpo = await resposta.json();
  return { status: resposta.status, corpo };
}

before(async () => {
  porta = await portaLivre();
  processo = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, { PORT: String(porta) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  processo.stderr.on('data', (d) => process.stderr.write('[servidor] ' + d));
  const subiu = await esperarSubir(porta);
  assert.ok(subiu, 'o servidor nao respondeu na porta ' + porta);
});

after(() => {
  if (processo) processo.kill('SIGTERM');
});

test('a pagina do painel e servida', async () => {
  const r = await fetch('http://127.0.0.1:' + porta + '/');
  assert.strictEqual(r.status, 200);
  const html = await r.text();
  assert.match(html, /BTC RADAR/);
});

test('/api/history responde com a lista de linhas', async () => {
  const { status, corpo } = await pegar('/api/history?hours=24');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(corpo.linhas), 'history deveria devolver um array em "linhas"');
  assert.ok(!corpo.erro, 'history devolveu erro: ' + corpo.erro);
});

test('/api/liq responde com a lista de linhas', async () => {
  const { status, corpo } = await pegar('/api/liq?hours=24');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(corpo.linhas));
});

test('/api/config nunca devolve a chave da IA', async () => {
  const { status, corpo } = await pegar('/api/config');
  assert.strictEqual(status, 200);
  assert.ok(!('geminiKey' in corpo), 'a chave nao pode sair do servidor');
  assert.strictEqual(typeof corpo.temChave, 'boolean');
});

test('/api/fng responde com o indice de medo e ganancia', { skip: SEM_REDE ? 'sem rede' : false }, async () => {
  const { status, corpo } = await pegar('/api/fng');
  assert.strictEqual(status, 200);
  assert.ok(!corpo.erro, 'fng devolveu erro: ' + corpo.erro);
  assert.ok(corpo.atual && Number.isFinite(corpo.atual.valor), 'fng sem valor atual');
});

test('/api/preditivo responde com nota e componentes', { skip: SEM_REDE ? 'sem rede' : false }, async () => {
  const { status, corpo } = await pegar('/api/preditivo');
  assert.strictEqual(status, 200);
  assert.ok(!corpo.erro, 'preditivo devolveu erro: ' + corpo.erro);
  assert.ok(Array.isArray(corpo.componentes) && corpo.componentes.length === 5, 'preditivo deveria trazer 5 componentes');
  assert.ok(Number.isFinite(corpo.nota), 'preditivo sem nota');
});
