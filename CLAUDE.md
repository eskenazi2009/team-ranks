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
