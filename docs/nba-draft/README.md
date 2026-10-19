# 🏀 Fantasy NBA · Draft en vivo (Sleeper)

Sitio estático que acompaña el draft de la liga **Benchwarmers** en Sleeper.
Corre 100% en el navegador, sin servidor ni claves: usa la API pública de Sleeper
y los endpoints públicos de ESPN.

## Qué hace

- **Draft en vivo**: jugadores disponibles (se actualiza cada 15 s), tu roster por
  slot, quién está en el reloj, cuántos picks faltan para tu turno, reloj del pick,
  aviso sonoro y notificación cuando te toca.
- **Ficha de jugador** (clic en cualquier nombre): stats del año pasado y proyección
  con los puntos de la liga, juegos jugados, lesión actual (Sleeper + ESPN), noticias
  recientes, temporadas anteriores y el roster de su equipo NBA con quién está libre.
- **Jugadores**: tabla con los stats de la temporada pasada y los **puntos de fantasía
  calculados con la configuración exacta de la liga**, totales o por juego, filtrable
  por los slots del roster (PG, SG, SF, PF, C, G, F, UTIL) y ordenable por columna.
- **Picks sugeridos**: top 3 para tu equipo en este momento, en orden, con la razón
  (valor sobre el reemplazo, huecos del roster, lesiones, ADP y si llegaría a tu
  siguiente turno). Al lado, el panel **Claude en vivo** lee `live/claude.json`,
  que Claude actualiza durante el draft, más un cuadro para pegar notas.
- **Liga**: puntuación, roster, formato del draft y orden de los equipos.

## Publicación

Vive en `docs/nba-draft/` del repo `team-ranks`, que ya publica GitHub Pages desde
`main` / `/docs`. URL: `https://eskenazi2009.github.io/team-ranks/nba-draft/`.

También funciona abriendo `index.html` desde un servidor local, por ejemplo
`python3 -m http.server` dentro de la carpeta.

## Configuración

Botón ⚙ arriba a la derecha: usuario de Sleeper, nombre de la liga, temporada (auto)
y segundos entre refrescos. El panel *Diagnóstico de fuentes* muestra qué endpoint
respondió y cuál falló.

## Fuentes de datos

| Dato | Endpoint |
|---|---|
| Usuario, ligas, draft, picks, jugadores | `api.sleeper.app/v1/...` |
| Stats temporada pasada / proyecciones | `api.sleeper.com/stats|projections/nba/<temporada>` (respaldo: ESPN `statistics/byathlete`) |
| Noticias, temporadas anteriores | `site.web.api.espn.com/.../athletes/<espn_id>/overview` y `/stats` |
| Roster del equipo NBA, lesiones | `site.api.espn.com/.../teams/<id>/roster` y `/injuries` |

Los jugadores, stats y proyecciones se guardan en `localStorage` (12 h / 7 d / 1 d).

Si el navegador no puede llamar a un host directamente, el sitio reintenta por un
servicio CORS público de respaldo y lo indica en el diagnóstico.

## Notas de Claude en vivo

`live/claude.json` tiene esta forma; el sitio lo relee cada refresco:

```json
{ "updated": "2026-10-20 20:15", "pick": 21,
  "top3": [ { "player": "Victor Wembanyama", "reason": "mejor valor en C y te falta el slot" } ],
  "notes": "texto libre" }
```

## Prueba local con datos simulados

`node test/run.js .` abre el sitio (con `BLOCK_DIRECT=1` simula Sleeper bloqueado) en Chromium (Playwright) interceptando Sleeper y
ESPN con `test/fixtures.js`, imprime las vistas y guarda capturas.
