# Notas para Claude

## Asistente de fantasy NBA de Raymond (docs/nba-draft)

- El sitio es SOLO de lesiones (desde el 26-oct-2026): tablas de quién gana minutos por cada baja, quién
  pierde al regresar otro, lesionados actuales y ficha por jugador. El draft ya pasó; no hay UI de draft.
- Al cambiar app.js o styles.css, subir el `?v=` de ambos en index.html; si no, el celular de Raymond
  mezcla HTML nuevo con JS viejo en caché y la página se rompe (pasó el 26-oct-2026).

- Usuario de Sleeper: raymondesk. Liga: Benchwarmers (puntos, 10 equipos, alineaciones diarias,
  FAAB de 100). Su roster es el roster_id 7, equipo "White". Llamarlo Raymond.
- Raymond pregunta durante la temporada a quién startear y a quién agregar de los libres.
- **Preferencia permanente para adds y starts: prioriza el techo, no el piso.** Quiere jugadores con
  posibilidad de anotar muchos puntos de fantasía aunque jueguen mal otras noches, porque puede
  decidir no lockear un juego si no le gusta el score. Mide techo con el promedio de sus 5 mejores
  juegos, el percentil 90 y la desviación de sus puntos de liga, no con el promedio.
- Puntuación y formato salen siempre de la liga en Sleeper (data/snapshot.json), nunca de supuestos.
- Datos: el relay de GitHub Actions (nba-draft-relay.yml) deja JSON en docs/nba-draft/data; el
  navegador de Raymond no alcanza Sleeper ni ESPN directo.
- Las semanas de la liga van de lunes a domingo (la semana 1 empezó el martes 20 de octubre de 2026 y
  cierra el domingo 25). Al contar juegos restantes, cortar siempre en el domingo.
- Regla de lock de la liga (explicada por Raymond el 22-oct-2026): cada slot titular fija UN juego por
  semana. Solo se puede fijar el juego de un jugador que estaba de titular cuando jugó; los puntos de la
  banca se pierden. Al fijarlo, el jugador queda en ese slot con ese puntaje toda la semana (no se puede
  cambiar de juego ni de posición). Un titular no fijado conserva como fijable solo su ÚLTIMO juego; si
  vuelve a jugar de titular, el fijable pasa a ser el nuevo juego. Si se le manda a la banca sin fijar,
  pierde la opción hasta que vuelva a ser titular y juegue otra vez. Sleeper no expone qué está fijado:
  Raymond lo dice. Verificado el 24-oct-2026: starters_points de los matchups de Sleeper NO refleja los
  locks (George estaba fijado en 62.5 y Sleeper mostraba 32.4), así que nunca inferir locks de ahí. Analizar cada slot abierto como parada óptima: fijar ahora vs EV de esperar los juegos
  restantes de la semana (hasta el domingo), incluyendo cambiar al jugador del slot.
- Raymond está en Panamá (UTC-5, sin horario de verano). El relay diario corre a las 4:00 PM de Panamá
  (21:00 UTC) y la tarea programada de lesiones le notifica a las 4:12 PM de Panamá por push y correo
  (trigger trig_01MFQi4UpVq8sQ4ANuJYMKbm).
