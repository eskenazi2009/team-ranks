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
  locks (George estaba fijado en 62.5 y Sleeper mostraba 32.4), así que nunca inferir locks de ahí. Tampoco
  sirven los totales de la API (`points` de /matchups): el 28-oct-2026 la semana 1 de White salía 388.5
  y el real era 414.7 (la API mostraba el último juego de Randle, 27.9, en vez de su lock de 54.1), y
  Magic Wonder Year salía 267.3 contra 307.3 real. Los marcadores oficiales (con locks) están en
  los rosters: `settings.fpts` + `fpts_decimal`/100 es el acumulado de la temporada por equipo (y
  `fpts_against` el del rival); el total de una semana es la diferencia contra la semana anterior.
  Verificado con Raymond: White 414.7 y Magic Wonder Year 307.3 en la semana 1. Analizar cada slot abierto como parada óptima: fijar ahora vs EV de esperar los juegos
  restantes de la semana (hasta el domingo), incluyendo cambiar al jugador del slot.
- Regla de Raymond (28-oct-2026): un fijable que no se va a fijar no vale nada. Si el plan es esperar otro
  juego de un titular, no tiene sentido dejarlo en el slot los días que no juega para "conservar" su score:
  esos días se mete a otro jugador elegible que sí juegue, y si hace muchos puntos se fija; si no, el titular
  vuelve al slot (o a otro slot elegible) para su próximo juego. Mandar a la banca solo cuesta si ese score
  se iba a fijar. Planear cada slot abierto como una secuencia de juegos de distintos jugadores, día por día.
- Raymond dice qué jugadores fijó cada semana; esos quedan inmóviles en su slot hasta el domingo y no se
  tocan en ninguna recomendación.
- Raymond está en Panamá (UTC-5, sin horario de verano). El relay corre dos veces al día: 8:00 AM y 5:30 PM de
  Panamá. Los crons de GitHub (13:00 y 22:30 UTC) llegan con horas de retraso (verificado 27-30 oct: 3 a 5.5 h),
  así que el disparo puntual lo hacen dos tareas programadas de Claude a las 7:57 AM y 5:27 PM con
  workflow_dispatch (la de la tarde con baseline=true, que cierra el reporte de 24 h); los crons quedan de
  respaldo y no mueven la línea base si tiene menos de 6 h. La tarea programada de
  lesiones le notifica a las 5:42 PM de Panamá por push y correo
  (trigger trig_01MFQi4UpVq8sQ4ANuJYMKbm).
