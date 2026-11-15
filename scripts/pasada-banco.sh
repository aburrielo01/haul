#!/bin/zsh
# Lanza una pasada completa del banco en Render y la vigila hasta que acabe.
#   scripts/pasada-banco.sh <n.º de pasada> [nueva|continuar] [lectores]
# El token sale del .env del proyecto y nunca se imprime. Con un solo lector
# (por defecto): con dos, la instancia de Render se reinicia.
set -e
cd "$(dirname "$0")/.."
set -a; source .env; set +a
B=${HAUL_URL:-https://haul-o6sv.onrender.com}
PASADA=${1:-1}
MODO=${2:-nueva}
CONC=${3:-1}
FRESH=1; [ "$MODO" = "continuar" ] && FRESH=0
echo "== pasada $PASADA · $MODO · $CONC lector(es) · $(date '+%d/%m %H:%M')"
curl -s -m 60 "$B/api/bench/run?key=$DIAG_TOKEN&fresh=$FRESH&concurrency=$CONC" | python3 -c "import json,sys; d=json.load(sys.stdin); print('  lanzada:', d.get('started'), '· total', d.get('total'), d.get('reason') or '')"
for i in {1..120}; do
  sleep 60
  st=$(curl -s -m 60 "$B/api/bench/report?key=$DIAG_TOKEN" | python3 -c "
import json,sys
d=json.load(sys.stdin); s=d.get('summary') or d.get('partial') or {}
print(d.get('status'), d.get('done'), '/', d.get('total'), '·', s.get('pctOk'), '%')" 2>/dev/null || echo "sin respuesta")
  echo "  $(date +%H:%M) $st"
  case "$st" in done*) break;; interrupted*) echo "  interrumpida: relanzar con 'continuar'"; exit 2;; esac
done
echo "== resultado"
curl -s -m 60 "$B/api/bench/report?key=$DIAG_TOKEN" | python3 -c "
import json,sys
d=json.load(sys.stdin); s=d.get('summary') or {}; c=d.get('consistency') or {}
print('  ', s.get('ok'), '/', s.get('total'), '=', s.get('pctOk'), '% · objetivo', s.get('target'), '✓' if s.get('onTarget') else '✗')
print('   fallos:', [(r['id'], r['shop'], ' '.join(k for k in ('title','price','image') if not r['grade'].get(k)) or '-') for r in d.get('rows',[]) if not r['grade']['ok']])
print('   consistencia:', {k:c.get(k) for k in ('enough','consistent','minPct','maxPct','unstable','failing')})
print('   pasadas completas:', [(x['pctOk'], x['onTarget']) for x in c.get('runs',[])])
"
