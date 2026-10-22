# Notas para Claude

## Asistente de fantasy NBA de Raymond (docs/nba-draft)

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
  Raymond lo dice. Analizar cada slot abierto como parada óptima: fijar ahora vs EV de esperar los juegos
  restantes de la semana (hasta el domingo), incluyendo cambiar al jugador del slot.
