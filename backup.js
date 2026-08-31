'use strict';
/*
 * BTC RADAR - backup
 * Copia data/*.jsonl e config.json em .gz para backups/AAAA-MM-DD_HHMM/.
 * Roda no boot e a cada 6h, guardando as 14 copias mais novas.
 * ATENCAO: config.json carrega a chave da IA. As copias herdam esse segredo.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RAIZ = __dirname;
const DIR_DADOS = path.join(RAIZ, 'data');
const DIR_BACKUPS = path.join(RAIZ, 'backups');
const MANTER = 14;
const INTERVALO_MS = 6 * 3600 * 1000;

function carimbo(data = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return data.getFullYear() + '-' + p(data.getMonth() + 1) + '-' + p(data.getDate()) +
    '_' + p(data.getHours()) + p(data.getMinutes());
}

function arquivosParaCopiar() {
  let nomes = [];
  try {
    nomes = fs.readdirSync(DIR_DADOS);
  } catch {
    return [];
  }
  return nomes.filter((n) => n.endsWith('.jsonl') || n === 'config.json');
}

function pastas() {
  try {
    return fs.readdirSync(DIR_BACKUPS)
      .filter((n) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(n))
      .sort();
  } catch {
    return [];
  }
}

function rotacionar() {
  const lista = pastas();
  const apagadas = [];
  while (lista.length > MANTER) {
    const velha = lista.shift();
    try {
      fs.rmSync(path.join(DIR_BACKUPS, velha), { recursive: true, force: true });
      apagadas.push(velha);
    } catch { /* segue */ }
  }
  return apagadas;
}

function rodar() {
  try {
    fs.mkdirSync(DIR_BACKUPS, { recursive: true });
    const nome = carimbo();
    const destino = path.join(DIR_BACKUPS, nome);
    fs.mkdirSync(destino, { recursive: true });
    const copiados = [];
    for (const arquivo of arquivosParaCopiar()) {
      const bruto = fs.readFileSync(path.join(DIR_DADOS, arquivo));
      fs.writeFileSync(path.join(destino, arquivo + '.gz'), zlib.gzipSync(bruto));
      copiados.push({ arquivo, bytes: bruto.length });
    }
    const apagadas = rotacionar();
    return { ok: true, pasta: nome, copiados, apagadas };
  } catch (e) {
    return { ok: false, erro: String(e.message || e) };
  }
}

function status() {
  const lista = pastas();
  const detalhes = lista.slice(-MANTER).map((nome) => {
    const cheio = path.join(DIR_BACKUPS, nome);
    let bytes = 0;
    let arquivos = 0;
    try {
      for (const f of fs.readdirSync(cheio)) {
        bytes += fs.statSync(path.join(cheio, f)).size;
        arquivos++;
      }
    } catch { /* pasta sumiu */ }
    return { pasta: nome, arquivos, bytes };
  }).reverse();
  return {
    manter: MANTER,
    intervaloHoras: INTERVALO_MS / 3600000,
    total: lista.length,
    copias: detalhes,
    aviso: 'As copias incluem data/config.json, que guarda a chave da IA. Trate a pasta backups/ como material sigiloso.'
  };
}

let cronometro = null;

function agendar() {
  rodar();
  clearInterval(cronometro);
  cronometro = setInterval(rodar, INTERVALO_MS);
  if (cronometro.unref) cronometro.unref();
  return cronometro;
}

module.exports = { rodar, status, agendar, carimbo };
