#!/usr/bin/env bash
# BTC RADAR - sobe o servidor em segundo plano (se a porta estiver livre) e abre o navegador.
set -u

PASTA="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORTA="${PORT:-8899}"
LOG="$PASTA/btc-radar.log"

cd "$PASTA" || exit 1

# O Node do apt do Mint e 18 ou 20 e nao tem WebSocket global. Procuramos o 22
# em tres lugares, nesta ordem: o que ja esta no PATH, o nvm carregado como funcao
# e, se a funcao falhar (acontece em shell nao interativo), o binario direto na
# pasta do nvm.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

versaoServe() {
  case "${1:-}" in
    v2[2-9]*|v[3-9][0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

VERSAO="$(node -v 2>/dev/null || echo nenhuma)"

if ! versaoServe "$VERSAO" && [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
  VERSAO="$(node -v 2>/dev/null || echo nenhuma)"
fi

if ! versaoServe "$VERSAO" && [ -d "$NVM_DIR/versions/node" ]; then
  ULTIMO="$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null | grep -E '^v(2[2-9]|[3-9][0-9])\.' | sort -V | tail -1)"
  if [ -n "$ULTIMO" ] && [ -x "$NVM_DIR/versions/node/$ULTIMO/bin/node" ]; then
    PATH="$NVM_DIR/versions/node/$ULTIMO/bin:$PATH"
    export PATH
    VERSAO="$(node -v 2>/dev/null || echo nenhuma)"
  fi
fi

if ! versaoServe "$VERSAO"; then
  echo "Node 22 ou maior e necessario (encontrado: $VERSAO)."
  echo
  if [ ! -d "$NVM_DIR" ]; then
    echo "O nvm nao esta instalado em $NVM_DIR. Instale assim:"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
    echo "  source ~/.bashrc"
    echo "  nvm install 22"
  elif [ ! -d "$NVM_DIR/versions/node" ] || [ -z "$(ls -1 "$NVM_DIR/versions/node" 2>/dev/null)" ]; then
    echo "O nvm esta instalado, mas nenhuma versao do Node foi baixada ainda:"
    echo "  nvm install 22"
  else
    echo "O nvm tem estas versoes instaladas:"
    ls -1 "$NVM_DIR/versions/node" | sed 's/^/  /'
    echo "Nenhuma delas e 22 ou maior. Rode:"
    echo "  nvm install 22"
  fi
  echo
  echo "Depois disso rode ./start.sh de novo - ele acha o Node do nvm sozinho."
  exit 1
fi

echo "Usando $(command -v node) ($VERSAO)."

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
