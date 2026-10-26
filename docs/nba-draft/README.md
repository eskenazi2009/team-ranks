# 🩹 Lesiones NBA · liga Benchwarmers (Sleeper)

Página estática (GitHub Pages, `main` / `/docs`) que muestra, para la liga **Benchwarmers**:

- **Se lesionó → quién gana minutos.** Lesiones nuevas o agravadas a Out/Doubtful en las últimas 24 h y,
  para cada una, los compañeros que suben en la rotación (primero el siguiente en su posición del depth
  chart, luego por techo), con su techo (promedio de sus 5 mejores juegos del año pasado y percentil 90,
  ambos con la puntuación de la liga), proyección por juego, últimos juegos con minutos y si están
  **libres en la liga** o quién los tiene.
- **Regresa → quién pierde minutos.** Jugadores que vuelven de Out/Doubtful y los compañeros que venían
  jugando en su posición, ordenados por minutos recientes.
- **Lesionados actuales** con rol relevante, fecha estimada de regreso y dueño en la liga.
- Historial de 30 días. Al tocar cualquier nombre se abre la **ficha del jugador** (proyección, temporada
  pasada, mejores 5 juegos, lesión actual y última ausencia, noticias, depth chart de su equipo NBA).

URL: `https://eskenazi2009.github.io/team-ranks/nba-draft/`

## Datos: relay en GitHub Actions

El navegador no llama a Sleeper ni a ESPN. El workflow `.github/workflows/nba-draft-relay.yml`
(`relay/relay.py`, solo librería estándar) corre a diario a las **21:00 UTC (4:00 PM de Panamá)** o
manualmente, y commitea en `data/`:

| Archivo | Contenido |
|---|---|
| `snapshot.json` | liga (puntuación, roster, settings), usuarios, rosters |
| `players.json` | jugadores de Sleeper (equipo, posiciones, lesión, depth chart, `espn_id` cruzado por nombre) |
| `stats.json`, `proj.json` | totales de la temporada pasada y proyección por juego de Sleeper |
| `espn.json` | lesiones, rosters NBA, noticias, historial y registro juego a juego de ESPN (top 350 por ADP) |
| `daily.json` | box scores de ESPN por fecha (últimos 7 días) y calendario (9 días), matchups de la semana |
| `injury_report.json` / `.md` | cambios de lesión vs. la línea base de 24 h, beneficiarios, perdedores al regresar, lesionados actuales |
| `injury_log.json` | historial de cambios (30 días) |
| `injury_baseline.json` | línea base del diff; solo la mueve la corrida programada (o si tiene 20+ h) |
| `injury_streaks.json` | desde cuándo cada jugador está en Out/Doubtful (se cierra al volver a sano o Probable); alimenta `recent_injuries` del reporte, las bajas de los últimos 3 días |

Una tarea programada de Claude (4:12 PM de Panamá) lee `injury_report.md/json` de `main` y notifica a
Raymond por push y correo con la recomendación de adds.

## Puntuación

Todo se calcula con `scoring_settings` de la liga en Sleeper (`snapshot.json`). Los puntos por partido
salen del box score de ESPN y coinciden con Sleeper salvo las faltas técnicas/flagrantes, que el box score
no incluye.

## Pruebas

- `node test/run_inj.js .` abre la página en Chromium con todo lo externo bloqueado y usa los datos de `data/`.
- Relay contra un mock: `python3 test/mock.py <fixtures.json> 8799` y luego
  `SLEEPER_BASE=http://127.0.0.1:8799/api.sleeper.app/v1 SLEEPER2_BASE=http://127.0.0.1:8799/api.sleeper.com ESPN_SITE=http://127.0.0.1:8799/site.api.espn.com/apis/site/v2/sports/basketball/nba ESPN_WEB=http://127.0.0.1:8799/site.web.api.espn.com/apis/common/v3/sports/basketball/nba python3 relay/relay.py snapshot --out data`.
