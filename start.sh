#!/usr/bin/env bash
# BTC RADAR - sobe o servidor em segundo plano (se a porta estiver livre) e abre o navegador.
set -u

PASTA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTA="${PORT:-8899}"
LOG="$PASTA/btc-radar.log"

cd "$PASTA" || exit 1

# nvm, quando existir: o Node do apt do Mint costuma ser 18/20 e nao tem WebSocket global.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

VERSAO="$(node -v 2>/dev/null || echo nenhuma)"
case "$VERSAO" in
  v2[2-9]*|v[3-9][0-9]*) : ;;
  *)
    echo "Node 22 ou maior e necessario (encontrado: $VERSAO)."
    echo "Instale com nvm:  nvm install 22"
    exit 1
    ;;
esac

jaRodando() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q ":$PORTA "
  else
    node -e "const n=require('node:net');const s=n.createServer();s.once('error',()=>process.exit(0));s.once('listening',()=>{s.close();process.exit(1)});s.listen($PORTA,'127.0.0.1')"
  fi
}

if jaRodando; then
  echo "Ja tem alguem escutando na porta $PORTA. Nao subi outro servidor."
else
  echo "Subindo o BTC RADAR na porta $PORTA (log em $LOG)..."
  PORT="$PORTA" nohup node server.js >>"$LOG" 2>&1 &
  sleep 2
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:$PORTA" >/dev/null 2>&1 &
else
  echo "Abra no navegador: http://127.0.0.1:$PORTA"
fi
