/* Draft en vivo · Sleeper NBA
   App de una sola página, sin build. Todo corre en el navegador:
   - Sleeper API (pública, sin login): liga, draft, picks, jugadores, stats, proyecciones
   - ESPN API (pública): noticias, roster del equipo NBA, temporadas anteriores, lesiones
*/
'use strict';

const SLEEPER = 'https://api.sleeper.app/v1';
const SLEEPER2 = 'https://api.sleeper.com';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, d = 1) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d);
const fmt0 = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toString();

// ---------- estado global ----------
const S = {
  cfg: { user: 'raymondesk', league: 'Benchwarmers', season: '', poll: 15 },
  state: null, user: null, league: null, users: [], rosters: [], draft: null, picks: [], traded: [],
  players: {},          // player_id -> jugador (recortado)
  stats: {},            // player_id -> stats temporada pasada (totales)
  proj: {},             // player_id -> proyección temporada actual (totales)
  statsSeason: null, projSeason: null,
  mySlot: null, myRosterId: null,
  posFilterAvail: new Set(), posFilterPl: new Set(),
  sortPl: { key: 'fp', dir: -1 },
  timer: null, tick: null,
  espnTeams: null, espnInjuries: null,
  cache: {},
  lastPickCount: -1,
  diag: [],
};

// ---------- diagnóstico ----------
function diag(msg, ok = true) {
  const line = `${new Date().toLocaleTimeString()} ${ok ? '✓' : '✗'} ${msg}`;
  S.diag.unshift(line); S.diag = S.diag.slice(0, 60);
  const el = $('#diag'); if (el) el.textContent = S.diag.join('\n');
  if (!ok) console.warn(msg);
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function firstOk(label, urls, validate = (x) => x != null) {
  for (const u of urls) {
    try {
      const j = await getJSON(u);
      if (validate(j)) { diag(`${label}: ${u}`); return { url: u, data: j }; }
      diag(`${label}: respuesta vacía ${u}`, false);
    } catch (e) { diag(`${label}: ${e.message}`, false); }
  }
  return null;
}
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { diag(`localStorage lleno (${k})`, false); } }

// ---------- posiciones ----------
const BASE_POS = ['PG', 'SG', 'SF', 'PF', 'C'];
const SLOT_ELIG = { PG: ['PG'], SG: ['SG'], SF: ['SF'], PF: ['PF'], C: ['C'], G: ['PG', 'SG'], F: ['SF', 'PF'], UTIL: BASE_POS, BN: BASE_POS, IR: BASE_POS };
function playerPositions(p) {
  const fp = Array.isArray(p.fantasy_positions) && p.fantasy_positions.length ? p.fantasy_positions : [p.position];
  const out = new Set();
  for (const x of fp) {
    if (!x) continue;
    if (x === 'G') { out.add('PG'); out.add('SG'); }
    else if (x === 'F') { out.add('SF'); out.add('PF'); }
    else out.add(x);
  }
  return [...out].filter((x) => BASE_POS.includes(x));
}
function eligibleForSlot(p, slot) { const e = SLOT_ELIG[slot] || BASE_POS; return playerPositions(p).some((x) => e.includes(x)); }

// ---------- puntuación de la liga ----------
function statVal(st, key) {
  if (!st) return 0;
  if (st[key] != null) return Number(st[key]) || 0;
  switch (key) {
    case 'fgmi': return Math.max(0, (st.fga || 0) - (st.fgm || 0));
    case 'ftmi': return Math.max(0, (st.fta || 0) - (st.ftm || 0));
    case 'tpmi': return Math.max(0, (st.tpa || 0) - (st.tpm || 0));
    case 'reb': return (st.oreb || 0) + (st.dreb || 0);
    default: return 0;
  }
}
function fantasyPoints(st) {
  const sc = S.league?.scoring_settings || {};
  let t = 0;
  for (const [k, w] of Object.entries(sc)) { if (!w) continue; t += Number(w) * statVal(st, k); }
  return t;
}
const STAT_LABELS = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'ROB', blk: 'TAP', to: 'PÉRD', tpm: '3PM', tpa: '3PA', fgm: 'FGM', fga: 'FGA', fgmi: 'FG fall.', ftm: 'FTM', fta: 'FTA', ftmi: 'FT fall.', tpmi: '3P fall.', oreb: 'REB OF', dreb: 'REB DEF', dd: 'Doble-doble', td: 'Triple-doble', qd: 'Cuádruple', pf: 'Faltas', tf: 'Técnicas', ff: 'Flagrantes', ej: 'Expulsión', min: 'Minutos', gp: 'Juegos', gs: 'Titular', fg_pct: 'FG%', ft_pct: 'FT%', tp_pct: '3P%', pts_std: 'FP std' };

// ---------- carga Sleeper ----------
async function loadCore() {
  S.state = await getJSON(`${SLEEPER}/state/nba`).catch((e) => { diag('state/nba: ' + e.message, false); return null; });
  S.user = await getJSON(`${SLEEPER}/user/${encodeURIComponent(S.cfg.user)}`);
  diag(`usuario ${S.user.display_name} (${S.user.user_id})`);

  const y = new Date().getFullYear();
  const seasons = S.cfg.season ? [S.cfg.season] : [...new Set([S.state?.league_season, S.state?.season, String(y), String(y + 1), String(y - 1)].filter(Boolean))];
  let found = null;
  for (const se of seasons) {
    const lgs = await getJSON(`${SLEEPER}/user/${S.user.user_id}/leagues/nba/${se}`).catch(() => []);
    const hit = (lgs || []).find((l) => l.name.toLowerCase().trim() === S.cfg.league.toLowerCase().trim()) || (lgs || []).find((l) => l.name.toLowerCase().includes(S.cfg.league.toLowerCase()));
    if (hit) { found = hit; diag(`liga ${hit.name} (${hit.league_id}) temporada ${se}`); break; }
    if (lgs?.length) diag(`temporada ${se}: ligas ${lgs.map((l) => l.name).join(', ')} (ninguna coincide)`, false);
  }
  if (!found) throw new Error(`No encontré la liga "${S.cfg.league}" para ${S.cfg.user}. Revisa el nombre en ⚙.`);
  S.league = found;
  $('#leagueName').textContent = `${found.name} · ${found.season}`;
  document.title = `Draft NBA · ${found.name}`;

  const [users, rosters, drafts] = await Promise.all([
    getJSON(`${SLEEPER}/league/${found.league_id}/users`),
    getJSON(`${SLEEPER}/league/${found.league_id}/rosters`),
    getJSON(`${SLEEPER}/league/${found.league_id}/drafts`),
  ]);
  S.users = users; S.rosters = rosters;
  const draftMeta = (drafts || []).sort((a, b) => (b.start_time || 0) - (a.start_time || 0))[0];
  if (!draftMeta) throw new Error('La liga no tiene draft creado todavía.');
  S.draft = await getJSON(`${SLEEPER}/draft/${draftMeta.draft_id}`);
  S.traded = await getJSON(`${SLEEPER}/draft/${draftMeta.draft_id}/traded_picks`).catch(() => []);
  const myRoster = rosters.find((r) => r.owner_id === S.user.user_id || (r.co_owners || []).includes(S.user.user_id));
  S.myRosterId = myRoster?.roster_id ?? null;
  S.mySlot = S.draft.draft_order?.[S.user.user_id] ?? null;
  if (S.mySlot == null && S.myRosterId != null && S.draft.slot_to_roster_id) {
    const ent = Object.entries(S.draft.slot_to_roster_id).find(([, rid]) => rid === S.myRosterId);
    if (ent) S.mySlot = Number(ent[0]);
  }
  diag(`draft ${S.draft.draft_id} estado=${S.draft.status} tipo=${S.draft.type} rondas=${S.draft.settings?.rounds} equipos=${S.draft.settings?.teams} mi slot=${S.mySlot}`);
  renderLeague();
}

const KEEP = ['player_id', 'first_name', 'last_name', 'team', 'position', 'fantasy_positions', 'status', 'active', 'age', 'years_exp', 'injury_status', 'injury_body_part', 'injury_notes', 'injury_start_date', 'espn_id', 'search_rank', 'number', 'height', 'weight', 'college', 'news_updated', 'depth_chart_order', 'depth_chart_position', 'birth_date'];
async function loadPlayers() {
  const c = lsGet('nba_players_v1');
  if (c && Date.now() - c.ts < 12 * 3600e3 && c.data && Object.keys(c.data).length > 100) { S.players = c.data; diag(`jugadores desde caché (${Object.keys(c.data).length})`); return; }
  const all = await getJSON(`${SLEEPER}/players/nba`);
  const trimmed = {};
  for (const [id, p] of Object.entries(all)) {
    if (!p || !p.first_name) continue;
    const t = {}; for (const k of KEEP) if (p[k] != null) t[k] = p[k];
    trimmed[id] = t;
  }
  S.players = trimmed;
  lsSet('nba_players_v1', { ts: Date.now(), data: trimmed });
  diag(`jugadores descargados (${Object.keys(trimmed).length})`);
}

function parseSleeperStatsArray(arr) {
  const out = {};
  for (const row of arr) { if (row && row.player_id && row.stats) out[row.player_id] = row.stats; }
  return out;
}
const POS_Q = 'position[]=PG&position[]=SG&position[]=SF&position[]=PF&position[]=C&position[]=G&position[]=F';

async function loadStats() {
  const lgSeason = Number(S.league.season) || new Date().getFullYear();
  const prev = String(lgSeason - 1);
  S.statsSeason = prev; S.projSeason = String(lgSeason);
  const cs = lsGet('nba_stats_' + prev);
  if (cs && Date.now() - cs.ts < 7 * 86400e3 && Object.keys(cs.data).length > 10) { S.stats = cs.data; S.statsSrc = cs.src; diag(`stats ${prev} desde caché`); }
  else {
    const r = await firstOk('stats ' + prev, [
      `${SLEEPER2}/stats/nba/${prev}?season_type=regular&${POS_Q}&order_by=pts`,
      `${SLEEPER}/stats/nba/regular/${prev}`,
    ], (j) => (Array.isArray(j) ? j.length > 10 : j && Object.keys(j).length > 10));
    if (r) { S.stats = Array.isArray(r.data) ? parseSleeperStatsArray(r.data) : r.data; S.statsSrc = 'sleeper'; }
    else { S.stats = await loadEspnBulkStats(prev); S.statsSrc = 'espn'; }
    if (Object.keys(S.stats).length) lsSet('nba_stats_' + prev, { ts: Date.now(), data: S.stats, src: S.statsSrc });
  }
  const cp = lsGet('nba_proj_' + lgSeason);
  if (cp && Date.now() - cp.ts < 86400e3 && Object.keys(cp.data).length > 10) { S.proj = cp.data; diag(`proyecciones ${lgSeason} desde caché`); }
  else {
    const r = await firstOk('proyecciones ' + lgSeason, [
      `${SLEEPER2}/projections/nba/${lgSeason}?season_type=regular&${POS_Q}&order_by=pts`,
      `${SLEEPER}/projections/nba/regular/${lgSeason}`,
    ], (j) => (Array.isArray(j) ? j.length > 10 : j && Object.keys(j).length > 10));
    S.proj = r ? (Array.isArray(r.data) ? parseSleeperStatsArray(r.data) : r.data) : {};
    if (Object.keys(S.proj).length) lsSet('nba_proj_' + lgSeason, { ts: Date.now(), data: S.proj });
  }
  $('#statsSeasonLbl').textContent = `temporada ${prev}-${String(lgSeason).slice(2)}${S.statsSrc === 'espn' ? ' (ESPN)' : ''}`;
}

// ESPN bulk (respaldo si Sleeper no da stats): promedios por juego -> totales
const ESPN_MAP = { gp: 'gamesPlayed', gs: 'gamesStarted', min: 'avgMinutes', pts: 'avgPoints', reb: 'avgRebounds', oreb: 'avgOffensiveRebounds', dreb: 'avgDefensiveRebounds', ast: 'avgAssists', stl: 'avgSteals', blk: 'avgBlocks', to: 'avgTurnovers', fgm: 'avgFieldGoalsMade', fga: 'avgFieldGoalsAttempted', ftm: 'avgFreeThrowsMade', fta: 'avgFreeThrowsAttempted', tpm: 'avgThreePointFieldGoalsMade', tpa: 'avgThreePointFieldGoalsAttempted', dd: 'doubleDouble', td: 'tripleDouble', pf: 'avgFouls' };
async function loadEspnBulkStats(season) {
  const espnSeason = Number(season) + 1; // ESPN nombra la temporada por el año en que termina
  const byEspn = {};
  for (const p of Object.values(S.players)) if (p.espn_id) byEspn[String(p.espn_id)] = p.player_id;
  const out = {};
  for (let page = 1; page <= 3; page++) {
    let j;
    try { j = await getJSON(`${ESPN_WEB}/statistics/byathlete?region=us&lang=en&contentorigin=espn&isqualified=false&limit=350&page=${page}&season=${espnSeason}&seasontype=2`); }
    catch (e) { diag('ESPN byathlete: ' + e.message, false); break; }
    const cats = j.categories || [];
    for (const a of j.athletes || []) {
      const vals = {};
      (a.categories || []).forEach((c, i) => { const names = (cats[i] || {}).names || []; (c.values || []).forEach((v, k) => { vals[names[k]] = Number(v); }); });
      const pid = byEspn[String(a.athlete?.id)]; if (!pid) continue;
      const gp = vals.gamesPlayed || 0; const st = {};
      for (const [k, n] of Object.entries(ESPN_MAP)) { if (vals[n] == null) continue; st[k] = (k === 'gp' || k === 'gs' || k === 'dd' || k === 'td') ? vals[n] : vals[n] * gp; }
      out[pid] = st;
    }
    if (!j.athletes || j.athletes.length < 350) break;
  }
  diag(`ESPN stats ${espnSeason}: ${Object.keys(out).length} jugadores`, Object.keys(out).length > 0);
  return out;
}

async function loadPicks() {
  if (!S.draft) return;
  const [d, picks] = await Promise.all([
    getJSON(`${SLEEPER}/draft/${S.draft.draft_id}`).catch(() => null),
    getJSON(`${SLEEPER}/draft/${S.draft.draft_id}/picks`).catch(() => null),
  ]);
  if (d) S.draft = d;
  if (Array.isArray(picks)) S.picks = picks.sort((a, b) => a.pick_no - b.pick_no);
}

// ---------- lógica del draft ----------
function teams() { return S.draft?.settings?.teams || Object.keys(S.draft?.draft_order || {}).length || S.league?.total_rosters || 10; }
function rounds() { return S.draft?.settings?.rounds || (S.league?.roster_positions || []).filter((x) => x !== 'IR').length || 13; }
function slotOwnerRoster(slot, round) {
  // roster_id que tiene el pick de (slot, round) considerando picks intercambiados
  const orig = S.draft?.slot_to_roster_id?.[slot] ?? slot;
  const t = (S.traded || []).find((x) => Number(x.round) === round && Number(x.roster_id) === Number(orig) && String(x.season) === String(S.draft?.season || S.league.season));
  return t ? Number(t.owner_id) : Number(orig);
}
function pickOrder() {
  const T = teams(), R = rounds(), out = [];
  for (let r = 1; r <= R; r++) {
    const slots = Array.from({ length: T }, (_, i) => i + 1);
    const seq = (S.draft?.type === 'snake' && r % 2 === 0) ? slots.reverse() : slots;
    // Sleeper permite 3ra ronda invertida (settings.reversal_round)
    const rev = S.draft?.settings?.reversal_round;
    const seq2 = (rev && r >= rev && S.draft?.type === 'snake') ? ((r - rev) % 2 === 0 ? [...slots].reverse() : slots) : seq;
    for (const s of seq2) out.push({ round: r, slot: s, pick_no: out.length + 1, roster_id: slotOwnerRoster(s, r) });
  }
  return out;
}
function myPicks() { const order = pickOrder(); return order.filter((p) => (S.myRosterId != null && p.roster_id === S.myRosterId) || (S.myRosterId == null && p.slot === S.mySlot)); }
function nextMyPick() { const n = S.picks.length; return myPicks().find((p) => p.pick_no > n) || null; }
function currentPick() { const n = S.picks.length; return pickOrder()[n] || null; }
function userName(uid) { const u = S.users.find((x) => x.user_id === uid); return u?.metadata?.team_name || u?.display_name || uid; }
function rosterUser(rid) { const r = S.rosters.find((x) => x.roster_id === rid); return r ? userName(r.owner_id) : `Roster ${rid}`; }
function pickedIds() { return new Set(S.picks.map((p) => p.player_id)); }
function myPickedPlayers() { return S.picks.filter((p) => (S.myRosterId != null && p.roster_id === S.myRosterId) || p.picked_by === S.user?.user_id || (S.mySlot != null && p.draft_slot === S.mySlot)).map((p) => S.players[p.player_id] || { player_id: p.player_id, first_name: p.metadata?.first_name, last_name: p.metadata?.last_name, position: p.metadata?.position, fantasy_positions: [p.metadata?.position], team: p.metadata?.team }); }

function startingSlots() { return (S.league?.roster_positions || []).filter((x) => !['BN', 'IR'].includes(x)); }
function assignRoster(players) {
  // asigna jugadores a slots titulares (específicos primero) y devuelve {slots:[{slot,player}], bench:[...]}
  const slots = startingSlots().map((s) => ({ slot: s, player: null }));
  const prio = (s) => (BASE_POS.includes(s) ? 0 : (s === 'G' || s === 'F') ? 1 : 2);
  const order = [...slots].sort((a, b) => prio(a.slot) - prio(b.slot));
  const remaining = [...players].sort((a, b) => playerPositions(a).length - playerPositions(b).length);
  const bench = [];
  for (const p of remaining) {
    const slot = order.find((s) => !s.player && eligibleForSlot(p, s.slot));
    if (slot) slot.player = p; else bench.push(p);
  }
  return { slots, bench };
}

// ---------- valoración y recomendación ----------
function perGame(st) { const gp = st?.gp || 0; return gp ? fantasyPoints(st) / gp : 0; }
function playerValue(p) {
  const pr = S.proj[p.player_id], st = S.stats[p.player_id];
  const projTot = pr ? fantasyPoints(pr) : null;
  const lastTot = st ? fantasyPoints(st) : null;
  const projPG = pr && pr.gp ? projTot / pr.gp : (pr ? null : null);
  const lastPG = st && st.gp ? lastTot / st.gp : null;
  let V = projTot ?? lastTot ?? 0;
  if (!projTot && lastTot != null) {
    // sin proyección: ajusta por juegos jugados (regresa hacia 70 juegos)
    const gp = st.gp || 0; if (gp > 0 && gp < 65) V = lastPG * (gp * 0.5 + 65 * 0.5);
  }
  return { V, projTot, lastTot, projPG, lastPG, gpLast: st?.gp ?? null };
}
function injuryFactor(p) {
  const s = (p.injury_status || '').toLowerCase();
  if (!s) return { f: 1, txt: '' };
  if (/out|ir|season/.test(s)) return { f: 0.6, txt: `lesionado (${p.injury_status}${p.injury_body_part ? ', ' + p.injury_body_part : ''})` };
  if (/doubt/.test(s)) return { f: 0.85, txt: `dudoso (${p.injury_body_part || ''})` };
  if (/quest|gtd|dtd|day/.test(s)) return { f: 0.95, txt: `en duda (${p.injury_body_part || ''})` };
  return { f: 1, txt: '' };
}
function availablePlayers() {
  const picked = pickedIds();
  return Object.values(S.players).filter((p) => !picked.has(p.player_id) && p.team && (p.active !== false) && (p.status !== 'Inactive' || S.stats[p.player_id] || S.proj[p.player_id]));
}
function recommend(limit = 8) {
  const avail = availablePlayers().map((p) => ({ p, ...playerValue(p) })).filter((x) => x.V > 0);
  if (!avail.length) return [];
  const T = teams();
  // nivel de reemplazo por posición: el T-ésimo mejor disponible elegible (lo que habrá en una ronda)
  const repl = {};
  for (const pos of BASE_POS) {
    const list = avail.filter((x) => playerPositions(x.p).includes(pos)).sort((a, b) => b.V - a.V);
    repl[pos] = list[Math.min(T, list.length - 1)]?.V ?? 0;
  }
  const mine = myPickedPlayers();
  const { slots } = assignRoster(mine);
  const emptySlots = slots.filter((s) => !s.player).map((s) => s.slot);
  const nxt = nextMyPick(), cur = currentPick();
  const picksUntilMine = nxt && cur ? nxt.pick_no - cur.pick_no : null;
  const afterNext = myPicks().find((p) => nxt && p.pick_no > nxt.pick_no);
  const gapAfter = afterNext && nxt ? afterNext.pick_no - nxt.pick_no : 2 * T;
  const topV = Math.max(...avail.map((x) => x.V));

  const scored = avail.map((x) => {
    const pos = playerPositions(x.p);
    const vorp = Math.max(...pos.map((ps) => x.V - (repl[ps] || 0)));
    const inj = injuryFactor(x.p);
    const slotPrio = (s) => s === x.p.position ? 0 : BASE_POS.includes(s) ? 1 : (s === 'G' || s === 'F') ? 2 : 3;
    const fills = [...emptySlots].sort((a, b) => slotPrio(a) - slotPrio(b)).find((s) => eligibleForSlot(x.p, s));
    const why = [];
    let score = x.V * inj.f + Math.max(0, vorp) * 0.6;
    if (fills) { score += x.V * 0.08; why.push(`llena tu hueco en ${fills}`); }
    else if (emptySlots.length) { score -= x.V * 0.06; why.push(`solo iría a banca/UTIL (te faltan ${emptySlots.join(', ')})`); }
    // probabilidad de que siga disponible en tu siguiente turno (por ADP de Sleeper)
    const adp = x.p.search_rank && x.p.search_rank < 9000 ? x.p.search_rank : null;
    const n = S.picks.length;
    if (adp && picksUntilMine != null) {
      const margin = adp - (n + picksUntilMine + gapAfter);
      if (margin > T * 0.6) { score -= x.V * 0.07; why.push(`por ADP (#${adp}) probablemente sigue libre en tu próximo turno`); }
      else if (adp <= n + picksUntilMine + 2) why.push(`ADP #${adp}: si no lo tomas ahora, se va`);
    }
    if (inj.txt) why.push(inj.txt);
    if (x.gpLast != null) { if (x.gpLast < 50) why.push(`solo ${x.gpLast} juegos el año pasado`); else if (x.gpLast >= 70) why.push(`${x.gpLast} juegos el año pasado (durable)`); }
    if (vorp > 0 && topV) why.unshift(`+${fmt0(vorp)} FP sobre el reemplazo en ${pos.join('/')}`);
    return { ...x, score, vorp, why, fills };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ---------- render: cabecera / turno ----------
function renderStatus() {
  const st = S.draft?.status || '—';
  const el = $('#draftStatus');
  el.textContent = ({ pre_draft: 'Pre-draft', drafting: 'DRAFT EN CURSO', complete: 'Draft terminado', paused: 'Pausado' })[st] || st;
  el.className = 'pill ' + ({ pre_draft: 'pre', drafting: 'live', complete: 'done' })[st] || '';
  const cur = currentPick(), nxt = nextMyPick();
  const T = teams();
  const turn = $('#myTurn');
  if (!S.draft) { turn.textContent = '—'; return; }
  if (st === 'pre_draft') {
    const when = S.draft.start_time ? new Date(S.draft.start_time).toLocaleString() : 'sin hora';
    turn.innerHTML = `Empieza: <strong>${esc(when)}</strong><br>Tu posición: <strong>#${S.mySlot ?? '?'}</strong> de ${T}. Tus picks: ${myPicks().slice(0, 4).map((p) => '#' + p.pick_no).join(', ')}…`;
  } else if (st === 'complete' || !cur) {
    turn.innerHTML = `Draft completo. Tus jugadores: <strong>${myPickedPlayers().length}</strong>.`;
  } else {
    const onClock = rosterUser(cur.roster_id);
    const isMe = nxt && nxt.pick_no === cur.pick_no;
    turn.innerHTML = isMe
      ? `<strong>¡TE TOCA!</strong> Pick #${cur.pick_no} (ronda ${cur.round}). Revisa la pestaña <em>Picks sugeridos</em>.`
      : `En el reloj: <strong>${esc(onClock)}</strong> (pick #${cur.pick_no}, ronda ${cur.round}).<br>Tu próximo pick: <strong>#${nxt ? nxt.pick_no : '—'}</strong>${nxt ? ` · faltan ${nxt.pick_no - cur.pick_no} picks` : ''}`;
  }
}
function renderClock() {
  const d = S.draft; const el = $('#clock');
  if (!d) { el.textContent = '—'; return; }
  if (d.status === 'pre_draft' && d.start_time) {
    const ms = d.start_time - Date.now();
    if (ms > 0) { const h = Math.floor(ms / 3.6e6), m = Math.floor(ms % 3.6e6 / 6e4), s = Math.floor(ms % 6e4 / 1e3); el.textContent = `Empieza en ${h}h ${m}m ${s}s`; return; }
  }
  if (d.status === 'drafting' && d.settings?.pick_timer && d.last_picked) {
    const left = Math.max(0, Math.round((d.last_picked + d.settings.pick_timer * 1000 - Date.now()) / 1000));
    el.textContent = `Reloj del pick: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; return;
  }
  el.textContent = `Picks: ${S.picks.length}/${teams() * rounds()}`;
}

// ---------- render: tabla disponibles ----------
function posChips(container, set, onChange) {
  const slotsInLeague = [...new Set((S.league?.roster_positions || []).filter((x) => !['BN', 'IR'].includes(x)))];
  const list = slotsInLeague.length ? slotsInLeague : [...BASE_POS, 'G', 'F', 'UTIL'];
  container.innerHTML = list.map((p) => `<span class="chip ${set.has(p) ? 'on' : ''}" data-p="${p}">${p}</span>`).join('');
  container.querySelectorAll('.chip').forEach((c) => c.onclick = () => { const p = c.dataset.p; set.has(p) ? set.delete(p) : set.add(p); posChips(container, set, onChange); onChange(); });
}
function passesPos(p, set) { if (!set.size) return true; return [...set].some((slot) => eligibleForSlot(p, slot)); }
function injTag(p) { return p.injury_status ? `<span class="inj ${esc(p.injury_status.replace(/\s/g, ''))}">${esc(p.injury_status)}</span>` : ''; }
function posTags(p) { return playerPositions(p).map((x) => `<span class="pos">${x}</span>`).join(''); }
function nameCell(p) { return `<span class="name" data-pid="${p.player_id}">${esc(p.first_name)} ${esc(p.last_name)}</span>`; }

function renderAvail() {
  const q = $('#availSearch').value.trim().toLowerCase();
  const sort = $('#availSort').value;
  let rows = availablePlayers().map((p) => ({ p, ...playerValue(p) }));
  rows = rows.filter((x) => (x.V > 0 || (x.p.search_rank && x.p.search_rank < 600)) && passesPos(x.p, S.posFilterAvail) && (!q || `${x.p.first_name} ${x.p.last_name} ${x.p.team}`.toLowerCase().includes(q)));
  let recMap = null;
  if (sort === 'rec') { recMap = new Map(recommend(400).map((r, i) => [r.p.player_id, { i, s: r.score }])); rows.sort((a, b) => (recMap.get(b.p.player_id)?.s ?? -1) - (recMap.get(a.p.player_id)?.s ?? -1)); }
  else if (sort === 'adp') rows.sort((a, b) => (a.p.search_rank || 1e7) - (b.p.search_rank || 1e7));
  else if (sort === 'last') rows.sort((a, b) => (b.lastTot ?? -1) - (a.lastTot ?? -1));
  else rows.sort((a, b) => (b.projTot ?? b.V) - (a.projTot ?? a.V));
  rows = rows.slice(0, 300);
  $('#availCount').textContent = `(${rows.length})`;
  const nxt = nextMyPick(), n = S.picks.length;
  $('#availTable').innerHTML = `<thead><tr><th>#</th><th>Jugador</th><th>Eq</th><th>Pos</th><th class="num" title="Proyección temporada, puntos de la liga">Proy FP</th><th class="num">Proy/J</th><th class="num" title="Año pasado, puntos de la liga">FP ${S.statsSeason || ''}</th><th class="num">FP/J</th><th class="num">JJ</th><th class="num" title="ADP aprox. de Sleeper · 🔥 = por ADP no llegaría a tu próximo turno">ADP</th><th>Lesión</th></tr></thead><tbody>` +
    rows.map((x, i) => {
      const adp = x.p.search_rank && x.p.search_rank < 9000 ? x.p.search_rank : null;
      const risk = adp && nxt ? (adp <= nxt.pick_no ? '🔥' : '') : '';
      return `<tr><td class="muted">${i + 1}</td><td>${nameCell(x.p)} ${risk}</td><td>${esc(x.p.team)}</td><td>${posTags(x.p)}</td><td class="num">${fmt0(x.projTot)}</td><td class="num">${fmt(x.projPG)}</td><td class="num">${fmt0(x.lastTot)}</td><td class="num">${fmt(x.lastPG)}</td><td class="num">${x.gpLast ?? '—'}</td><td class="num">${adp ?? '—'}</td><td>${injTag(x.p)}</td></tr>`;
    }).join('') + '</tbody>';
  bindNames($('#availTable'));
}

// ---------- render: roster y feed ----------
function renderRoster() {
  const mine = myPickedPlayers();
  const { slots, bench } = assignRoster(mine);
  const bn = (S.league?.roster_positions || []).filter((x) => x === 'BN').length;
  let html = slots.map((s) => `<div class="slot">${s.slot}</div><div>${s.player ? `${nameCell(s.player)} <span class="muted small">${esc(s.player.team || '')}</span>` : '<span class="empty">vacío</span>'}</div>`).join('');
  for (let i = 0; i < Math.max(bn, bench.length); i++) html += `<div class="slot">BN</div><div>${bench[i] ? nameCell(bench[i]) : '<span class="empty">vacío</span>'}</div>`;
  $('#myRoster').innerHTML = html || '<span class="muted">Sin jugadores todavía</span>';
  bindNames($('#myRoster'));
  const feed = [...S.picks].reverse().slice(0, 40);
  $('#pickFeed').innerHTML = feed.map((p) => {
    const me = p.roster_id === S.myRosterId || p.picked_by === S.user?.user_id;
    const nm = p.metadata ? `${p.metadata.first_name} ${p.metadata.last_name}` : (S.players[p.player_id] ? `${S.players[p.player_id].first_name} ${S.players[p.player_id].last_name}` : p.player_id);
    return `<li class="${me ? 'me' : ''}" value="${p.pick_no}"><b>${esc(nm)}</b> <span class="muted">${esc(p.metadata?.position || '')} ${esc(p.metadata?.team || '')}</span> · ${esc(rosterUser(p.roster_id))} <span class="muted small">(R${p.round})</span></li>`;
  }).join('') || '<li class="muted">Aún no hay picks</li>';
}

// ---------- render: tabla de jugadores ----------
function renderPlayersTable() {
  const q = $('#plSearch').value.trim().toLowerCase();
  const onlyAvail = $('#plOnlyAvail').checked, pg = $('#plPerGame').checked;
  const picked = pickedIds();
  const cols = ['gp', 'min', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'tpm', 'fgm', 'fga', 'ftm', 'fta'];
  const scoringKeys = Object.keys(S.league?.scoring_settings || {}).filter((k) => S.league.scoring_settings[k]);
  for (const k of scoringKeys) if (!cols.includes(k) && !['fgmi', 'ftmi', 'tpmi'].includes(k)) cols.push(k);
  let rows = Object.values(S.players).filter((p) => S.stats[p.player_id]).map((p) => {
    const st = S.stats[p.player_id]; const gp = st.gp || 0; const fp = fantasyPoints(st); const pr = S.proj[p.player_id];
    return { p, st, gp, fp, fppg: gp ? fp / gp : 0, proj: pr ? fantasyPoints(pr) : null, picked: picked.has(p.player_id) };
  });
  rows = rows.filter((r) => (!onlyAvail || !r.picked) && passesPos(r.p, S.posFilterPl) && (!q || `${r.p.first_name} ${r.p.last_name} ${r.p.team}`.toLowerCase().includes(q)));
  const { key, dir } = S.sortPl;
  const val = (r) => key === 'fp' ? (pg ? r.fppg : r.fp) : key === 'proj' ? (r.proj ?? -1) : key === 'name' ? `${r.p.last_name}` : key === 'gp' ? r.gp : (pg && r.gp && key !== 'gp' ? statVal(r.st, key) / r.gp : statVal(r.st, key));
  rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string') ? dir * x.localeCompare(y) : dir * (x - y); });
  rows = rows.slice(0, 400);
  const th = (k, label, num = true) => `<th class="${num ? 'num' : ''} ${S.sortPl.key === k ? 'sorted' : ''}" data-k="${k}">${label}${S.sortPl.key === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  $('#plTable').innerHTML = `<thead><tr>${th('name', 'Jugador', false)}<th>Eq</th><th>Pos</th>${th('fp', `FP liga${pg ? '/J' : ''}`)}${th('proj', 'Proy FP')}${cols.map((c) => th(c, STAT_LABELS[c] || c.toUpperCase())).join('')}<th>Lesión</th></tr></thead><tbody>` +
    rows.map((r) => `<tr class="${r.picked ? 'muted' : ''}"><td>${nameCell(r.p)}${r.picked ? ' <span class="small muted">(tomado)</span>' : ''}</td><td>${esc(r.p.team)}</td><td>${posTags(r.p)}</td><td class="num"><b>${fmt(pg ? r.fppg : r.fp, pg ? 1 : 0)}</b></td><td class="num">${fmt0(r.proj)}</td>${cols.map((c) => `<td class="num">${c === 'gp' || !pg || !r.gp ? fmt(statVal(r.st, c), c === 'gp' || c === 'dd' || c === 'td' ? 0 : (pg ? 1 : 0)) : fmt(statVal(r.st, c) / r.gp)}</td>`).join('')}<td>${injTag(r.p)}</td></tr>`).join('') + '</tbody>';
  $('#plTable').querySelectorAll('th[data-k]').forEach((h) => h.onclick = () => { const k = h.dataset.k; S.sortPl = { key: k, dir: S.sortPl.key === k ? -S.sortPl.dir : (k === 'name' ? 1 : -1) }; renderPlayersTable(); });
  bindNames($('#plTable'));
}

// ---------- render: recomendaciones ----------
function renderReco() {
  const recs = recommend(8);
  const item = (r, i) => `<div class="item"><div class="rank">${i + 1}</div><div><div class="nm" data-pid="${r.p.player_id}">${esc(r.p.first_name)} ${esc(r.p.last_name)} <span class="muted small">${esc(r.p.team)} · ${playerPositions(r.p).join('/')}</span> ${injTag(r.p)}</div><div class="small">Proy ${fmt0(r.projTot)} FP (${fmt(r.projPG)}/J) · Año pasado ${fmt0(r.lastTot)} FP en ${r.gpLast ?? '—'} JJ · ADP ${r.p.search_rank && r.p.search_rank < 9000 ? '#' + r.p.search_rank : '—'}</div><div class="why">${r.why.map(esc).join(' · ')}</div></div></div>`;
  $('#recoList').innerHTML = recs.slice(0, 3).map(item).join('') || '<p class="muted">Sin datos suficientes todavía.</p>';
  $('#recoMore').innerHTML = recs.slice(3).map((r, i) => item(r, i + 3)).join('');
  document.querySelectorAll('#recoList .nm, #recoMore .nm').forEach((el) => el.onclick = () => openPlayer(el.dataset.pid));
}
async function loadClaudeLive() {
  try {
    const j = await getJSON(`live/claude.json?t=${Date.now()}`);
    const el = $('#claudeLive');
    const picks = (j.top3 || []).map((t, i) => `<div class="pick"><b>${i + 1}. ${esc(t.player)}</b>${t.reason ? ` — ${esc(t.reason)}` : ''}</div>`).join('');
    el.innerHTML = `<div class="ts">Actualizado: ${esc(j.updated || '—')}${j.pick ? ` · para el pick #${esc(j.pick)}` : ''}</div>${picks}${j.notes ? `<div>${esc(j.notes)}</div>` : ''}`;
  } catch { /* sin archivo todavía */ }
}

// ---------- render: liga ----------
function renderLeague() {
  const lg = S.league; if (!lg) return;
  const sc = lg.scoring_settings || {};
  const entries = Object.entries(sc).filter(([, v]) => v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  $('#lgScoring').innerHTML = `<div class="kv">${entries.map(([k, v]) => `<div class="k">${esc(STAT_LABELS[k] || k)}</div><div><b>${v > 0 ? '+' : ''}${v}</b></div>`).join('')}</div>
    <p class="small muted">Ejemplo: un jugador con 25 pts, 8 reb, 6 ast, 1 rob, 1 tap, 3 pérd, 2 triples, 9/18 FG, 5/6 FT vale <b>${fmt(fantasyPoints({ pts: 25, reb: 8, ast: 6, stl: 1, blk: 1, to: 3, tpm: 2, tpa: 5, fgm: 9, fga: 18, ftm: 5, fta: 6 }))}</b> FP por juego con esta configuración.</p>`;
  const rp = lg.roster_positions || [];
  const counts = rp.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
  const d = S.draft || {};
  const typeLbl = { snake: 'Serpiente', linear: 'Lineal', auction: 'Subasta' }[d.type] || d.type;
  $('#lgRoster').innerHTML = `<div class="kv">
    <div class="k">Equipos</div><div>${lg.total_rosters}</div>
    <div class="k">Roster</div><div>${Object.entries(counts).map(([k, v]) => `${v}× ${k}`).join(', ')}</div>
    <div class="k">Titulares</div><div>${startingSlots().length} · Banca ${counts.BN || 0} · IR ${counts.IR || 0}</div>
    <div class="k">Draft</div><div>${esc(typeLbl || '—')} · ${d.settings?.rounds || '—'} rondas · ${d.settings?.pick_timer ? d.settings.pick_timer + ' s por pick' : 'sin reloj'}${d.settings?.reversal_round ? ` · inversión en ronda ${d.settings.reversal_round}` : ''}</div>
    <div class="k">Inicio</div><div>${d.start_time ? new Date(d.start_time).toLocaleString() : '—'}</div>
    <div class="k">Mi posición</div><div>#${S.mySlot ?? '?'}</div>
    <div class="k">Formato</div><div>${esc(lg.settings?.type === 2 ? 'Dinastía/Keeper' : lg.settings?.type === 1 ? 'Keeper' : 'Redraft')} · playoffs ${lg.settings?.playoff_teams || '—'} equipos · semana ${lg.settings?.playoff_week_start || '—'}</div>
    <div class="k">Waivers</div><div>${esc(String(lg.settings?.waiver_type ?? '—'))} · presupuesto ${lg.settings?.waiver_budget ?? '—'}</div>
    <div class="k">Scoring</div><div>${esc(lg.scoring_type || d.metadata?.scoring_type || 'points')}</div>
  </div>`;
  const order = Object.entries(d.draft_order || {}).sort((a, b) => a[1] - b[1]);
  $('#lgTeams').innerHTML = `<table class="tbl mini"><thead><tr><th>Slot</th><th>Equipo</th><th>Usuario</th></tr></thead><tbody>${order.map(([uid, slot]) => { const u = S.users.find((x) => x.user_id === uid); return `<tr class="${uid === S.user?.user_id ? 'me' : ''}"><td>${slot}</td><td>${esc(u?.metadata?.team_name || '—')}</td><td>${esc(u?.display_name || uid)}</td></tr>`; }).join('')}</tbody></table>`;
}

// ---------- modal de jugador ----------
const TEAM_ALIAS = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN', CHO: 'CHA' };
async function espnTeams() {
  if (S.espnTeams) return S.espnTeams;
  try {
    const j = await getJSON(`${ESPN_SITE}/teams?limit=40`);
    const list = (j.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team);
    S.espnTeams = Object.fromEntries(list.map((t) => [t.abbreviation, t]));
  } catch (e) { diag('ESPN teams: ' + e.message, false); S.espnTeams = {}; }
  return S.espnTeams;
}
async function espnInjuries() {
  if (S.espnInjuries) return S.espnInjuries;
  const map = {};
  try {
    const j = await getJSON(`${ESPN_SITE}/injuries`);
    for (const t of j.injuries || []) for (const inj of t.injuries || []) if (inj.athlete?.id) map[String(inj.athlete.id)] = { status: inj.status, detail: inj.details?.detail || inj.shortComment || inj.longComment || '', type: inj.details?.type, returnDate: inj.details?.returnDate, date: inj.date, team: t.displayName };
  } catch (e) { diag('ESPN injuries: ' + e.message, false); }
  S.espnInjuries = map; return map;
}
async function cached(key, fn) { if (S.cache[key]) return S.cache[key]; const v = await fn().catch((e) => { diag(`${key}: ${e.message}`, false); return null; }); S.cache[key] = v; return v; }

function bindNames(root) { root.querySelectorAll('.name[data-pid]').forEach((el) => el.onclick = () => openPlayer(el.dataset.pid)); }

async function openPlayer(pid) {
  const p = S.players[pid]; if (!p) return;
  const st = S.stats[pid], pr = S.proj[pid];
  const box = $('#modalBody'); $('#modal').classList.remove('hidden');
  const img = p.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${p.espn_id}.png` : `https://sleepercdn.com/content/nba/players/thumb/${pid}.jpg`;
  const inj = p.injury_status ? `<div><span class="inj ${esc(p.injury_status)}">${esc(p.injury_status)}</span> ${esc(p.injury_body_part || '')} ${p.injury_notes ? '· ' + esc(p.injury_notes) : ''} ${p.injury_start_date ? '<span class="muted small">desde ' + esc(p.injury_start_date) + '</span>' : ''}</div>` : '<div class="muted small">Sin lesión reportada en Sleeper</div>';
  const sline = (s, lbl) => s ? `<div class="statline">${['gp', 'min', 'pts', 'reb', 'ast', 'stl', 'blk', 'to', 'tpm'].map((k) => `<div class="s"><b>${k === 'gp' ? fmt0(s.gp) : fmt(s.gp ? statVal(s, k) / s.gp : 0)}</b><span>${k === 'gp' ? 'JJ' : (STAT_LABELS[k] || k) + '/J'}</span></div>`).join('')}<div class="s"><b>${fmt(s.gp ? fantasyPoints(s) / s.gp : 0)}</b><span>FP/J</span></div><div class="s"><b>${fmt0(fantasyPoints(s))}</b><span>FP total</span></div></div>` : `<p class="muted small">Sin ${lbl}.</p>`;
  const picked = S.picks.find((x) => x.player_id === pid);
  box.innerHTML = `
    <div class="phead"><img src="${img}" onerror="this.style.display='none'" alt=""><div>
      <h2>${esc(p.first_name)} ${esc(p.last_name)} <span class="muted">#${esc(p.number ?? '')}</span></h2>
      <div>${posTags(p)} <b>${esc(p.team || 'Sin equipo')}</b> · ${p.age ? p.age + ' años' : ''} · ${p.years_exp != null ? (p.years_exp === 0 ? 'novato' : p.years_exp + ' temporadas') : ''} ${p.height ? '· ' + esc(p.height) : ''} ${p.college ? '· ' + esc(p.college) : ''}</div>
      ${inj}
      ${picked ? `<div class="small">Draftеado por <b>${esc(rosterUser(picked.roster_id))}</b> (pick #${picked.pick_no})</div>` : `<div class="small" style="color:var(--good)">Disponible · ADP Sleeper ${p.search_rank && p.search_rank < 9000 ? '#' + p.search_rank : '—'}</div>`}
    </div></div>
    <div class="pbox"><h3>Temporada pasada ${S.statsSeason || ''} (promedios por juego, puntos de esta liga)</h3>${sline(st, 'stats del año pasado')}</div>
    ${pr ? `<div class="pbox" style="margin-top:10px"><h3>Proyección ${S.projSeason || ''}</h3>${sline(pr, 'proyección')}</div>` : ''}
    <div class="pgrid" style="margin-top:10px">
      <div class="pbox"><h3>Noticias recientes</h3><div id="pNews" class="news loading">Cargando…</div></div>
      <div class="pbox"><h3>Lesiones (ESPN)</h3><div id="pInj" class="loading">Cargando…</div><h3 style="margin-top:12px">Temporadas anteriores</h3><div id="pSeasons" class="loading">Cargando…</div></div>
    </div>
    <div class="pbox" style="margin-top:10px"><h3>Roster de ${esc(p.team || '')}</h3><div id="pRoster" class="loading">Cargando…</div></div>`;

  // --- ESPN en paralelo ---
  const eid = p.espn_id ? String(p.espn_id) : null;
  const newsEl = $('#pNews'), injEl = $('#pInj'), seaEl = $('#pSeasons'), rosEl = $('#pRoster');
  const tasks = [];
  tasks.push((async () => {
    let news = [];
    if (eid) {
      const ov = await cached('ov' + eid, () => getJSON(`${ESPN_WEB}/athletes/${eid}/overview`));
      news = ov?.news || [];
      if (!news.length) { const nj = await cached('nw' + eid, () => getJSON(`${ESPN_SITE}/news?limit=12&athletes=${eid}`)); news = (nj?.articles || []).filter((a) => JSON.stringify(a.categories || []).includes(`"athleteId":${eid}`) || (a.headline || '').includes(p.last_name)); }
    }
    if (!news.length && p.team) {
      const teams = await espnTeams(); const t = teams[TEAM_ALIAS[p.team] || p.team];
      if (t) { const nj = await cached('tn' + t.id, () => getJSON(`${ESPN_SITE}/news?limit=25&team=${t.id}`)); news = (nj?.articles || []).filter((a) => `${a.headline} ${a.description}`.includes(p.last_name)).slice(0, 8); if (!news.length) news = (nj?.articles || []).slice(0, 5).map((a) => ({ ...a, headline: '[equipo] ' + a.headline })); }
    }
    newsEl.classList.remove('loading');
    newsEl.innerHTML = news.length ? news.slice(0, 10).map((n) => `<div class="n"><a href="${esc(n.links?.web?.href || n.links?.web?.short?.href || '#')}" target="_blank" rel="noopener">${esc(n.headline)}</a><div class="d">${n.published ? new Date(n.published).toLocaleDateString() : ''} ${n.description ? '· ' + esc(n.description) : ''}</div></div>`).join('') : '<span class="muted">Sin noticias disponibles. ' + (p.news_updated ? 'Última actualización en Sleeper: ' + new Date(p.news_updated).toLocaleString() : '') + '</span>';
  })());
  tasks.push((async () => {
    const m = await espnInjuries(); const i = eid ? m[eid] : null;
    injEl.classList.remove('loading');
    injEl.innerHTML = i ? `<b>${esc(i.status)}</b> ${i.type ? '· ' + esc(i.type) : ''}<div class="small">${esc(i.detail)}</div>${i.returnDate ? `<div class="small muted">Regreso estimado: ${esc(i.returnDate)}</div>` : ''}` : '<span class="muted small">No aparece en el reporte de lesiones de ESPN.</span>';
  })());
  tasks.push((async () => {
    seaEl.classList.remove('loading');
    if (!eid) { seaEl.innerHTML = '<span class="muted small">Sin id de ESPN.</span>'; return; }
    const sj = await cached('st' + eid, () => getJSON(`${ESPN_WEB}/athletes/${eid}/stats`));
    const cat = (sj?.categories || []).find((c) => /averag/i.test(c.name)) || sj?.categories?.[0];
    if (!cat) { seaEl.innerHTML = '<span class="muted small">Sin historial.</span>'; return; }
    const want = ['GP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', '3PM', 'FG%', 'FT%'];
    const idx = want.map((w) => cat.labels.indexOf(w));
    const rows = (cat.statistics || []).slice(-6).reverse();
    seaEl.innerHTML = `<table class="tbl mini"><thead><tr><th>Temp</th><th>Eq</th>${want.map((w) => `<th class="num">${w}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.season?.displayName || r.season?.year || '')}</td><td>${esc((r.teamSlug || '').toUpperCase().slice(0, 3))}</td>${idx.map((i) => `<td class="num">${i >= 0 ? esc(r.stats[i]) : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  })());
  tasks.push((async () => {
    rosEl.classList.remove('loading');
    if (!p.team) { rosEl.innerHTML = '<span class="muted small">Sin equipo.</span>'; return; }
    const teams = await espnTeams(); const t = teams[TEAM_ALIAS[p.team] || p.team];
    if (!t) { rosEl.innerHTML = '<span class="muted small">Equipo no encontrado en ESPN.</span>'; return; }
    const rj = await cached('ro' + t.id, () => getJSON(`${ESPN_SITE}/teams/${t.id}/roster`));
    const ath = (rj?.athletes || []).sort((a, b) => (a.position?.abbreviation || '').localeCompare(b.position?.abbreviation || ''));
    const picked = pickedIds();
    const byEspn = {}; for (const q of Object.values(S.players)) if (q.espn_id) byEspn[String(q.espn_id)] = q;
    rosEl.innerHTML = `<table class="tbl mini"><thead><tr><th>Jugador</th><th>Pos</th><th class="num">Edad</th><th class="num">Exp</th><th>Estado</th><th class="num">FP/J ${S.statsSeason || ''}</th><th>Draft</th></tr></thead><tbody>${ath.map((a) => { const sp = byEspn[String(a.id)]; const sst = sp ? S.stats[sp.player_id] : null; const injs = (a.injuries || []).map((x) => x.status).join(', '); return `<tr class="${sp && sp.player_id === pid ? 'me' : ''}"><td>${sp ? nameCell(sp) : esc(a.displayName)}</td><td>${esc(a.position?.abbreviation || '')}</td><td class="num">${a.age ?? '—'}</td><td class="num">${a.experience?.years ?? '—'}</td><td>${injs ? `<span class="inj ${esc(injs)}">${esc(injs)}</span>` : ''}</td><td class="num">${sst && sst.gp ? fmt(fantasyPoints(sst) / sst.gp) : '—'}</td><td class="small">${sp && picked.has(sp.player_id) ? esc(rosterUser(S.picks.find((x) => x.player_id === sp.player_id).roster_id)) : (sp ? '<span style="color:var(--good)">libre</span>' : '')}</td></tr>`; }).join('')}</tbody></table>`;
    bindNames(rosEl);
  })());
  await Promise.allSettled(tasks);
}

// ---------- ciclo principal ----------
function renderAll() {
  renderStatus(); renderClock(); renderAvail(); renderRoster(); renderReco();
  if (!$('#tab-players').classList.contains('hidden')) renderPlayersTable();
}
async function refresh() {
  try {
    await loadPicks();
    if (S.picks.length !== S.lastPickCount) {
      S.lastPickCount = S.picks.length; renderAll();
      const cur = currentPick(), nxt = nextMyPick();
      if (S.draft?.status === 'drafting' && cur && nxt && cur.pick_no === nxt.pick_no) notifyTurn(cur);
    } else { renderStatus(); renderClock(); }
    loadClaudeLive();
  } catch (e) { diag('refresh: ' + e.message, false); }
}
function notifyTurn(cur) {
  try { if (Notification?.permission === 'granted') new Notification('¡Te toca draftear!', { body: `Pick #${cur.pick_no}, ronda ${cur.round}` }); } catch {}
  try { const ctx = new (window.AudioContext || window.webkitAudioContext)(); const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination); o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 350); } catch {}
}
function schedule() {
  clearInterval(S.timer); clearInterval(S.tick);
  const ms = Math.max(5, Number(S.cfg.poll) || 15) * 1000;
  S.timer = setInterval(refresh, S.draft?.status === 'complete' ? ms * 8 : ms);
  S.tick = setInterval(renderClock, 1000);
}

async function boot() {
  const saved = lsGet('draft_cfg'); if (saved) Object.assign(S.cfg, saved);
  $('#inUser').value = S.cfg.user; $('#inLeague').value = S.cfg.league; $('#inSeason').value = S.cfg.season || ''; $('#inPoll').value = S.cfg.poll;
  $('#leagueName').textContent = 'cargando…';
  try {
    await loadCore();
    await loadPlayers();
    posChips($('#availPos'), S.posFilterAvail, renderAvail);
    posChips($('#plPos'), S.posFilterPl, renderPlayersTable);
    await loadPicks(); S.lastPickCount = S.picks.length;
    renderStatus(); renderClock(); renderRoster();
    await loadStats();
    renderAll(); loadClaudeLive(); schedule();
    try { if (Notification && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  } catch (e) {
    diag(e.message, false);
    $('#leagueName').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    $('#setup').classList.remove('hidden');
  }
}

// ---------- UI ----------
document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'players') renderPlayersTable();
  if (b.dataset.tab === 'picks') { renderReco(); loadClaudeLive(); }
});
$('#setupBtn').onclick = () => $('#setup').classList.toggle('hidden');
$('#applySetup').onclick = () => { S.cfg = { user: $('#inUser').value.trim(), league: $('#inLeague').value.trim(), season: $('#inSeason').value.trim(), poll: Number($('#inPoll').value) || 15 }; lsSet('draft_cfg', S.cfg); boot(); };
$('#refreshBtn').onclick = () => { S.lastPickCount = -1; refresh(); };
$('#availSearch').oninput = renderAvail; $('#availSort').onchange = renderAvail;
$('#plSearch').oninput = renderPlayersTable; $('#plOnlyAvail').onchange = renderPlayersTable; $('#plPerGame').onchange = renderPlayersTable;
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
$('#manualNote').value = lsGet('manual_note') || '';
$('#manualNote').oninput = () => lsSet('manual_note', $('#manualNote').value);

boot();
