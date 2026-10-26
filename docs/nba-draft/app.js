/* Lesiones NBA · liga Benchwarmers (Sleeper)
   Página estática: lee los JSON que deja el relay de GitHub Actions en data/ (lesiones, beneficiarios,
   jugadores, stats, proyecciones, box scores) y muestra quién gana minutos con cada baja y quién
   pierde cuando alguien vuelve. Al tocar un nombre se abre la ficha del jugador.
*/
'use strict';

const SLEEPER = 'https://api.sleeper.app/v1';
const SLEEPER2 = 'https://api.sleeper.com';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba';

// Datos estáticos que deja el relay (GitHub Actions) en el mismo origen de la página,
// y rama `nba-live` con los picks en vivo (leída desde raw.githubusercontent.com).
const DATA = 'data/';
const REPO = (() => {
  const m = location.host.match(/^([^.]+)\.github\.io$/); const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m ? m[1] : 'eskenazi2009', repo: (m && seg) ? seg : 'team-ranks' };
})();
const LIVE_RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/nba-live/`;

const $ = (s) => document.querySelector(s);
const setHTML = (s, html) => { const el = $(s); if (el) el.innerHTML = html; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, d = 1) => (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d);
const fmt0 = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toString();

// ---------- estado global ----------
const S = {
  cfg: { user: 'raymondesk', league: 'Benchwarmers', season: '', poll: 300 },
  snap: null, league: null, users: [], rosters: [],
  players: {}, stats: {}, proj: {}, statsSeason: null, projSeason: null,
  owner: {},            // player_id -> nombre del equipo de la liga que lo tiene
  espnData: undefined, cache: {}, diag: [], onlyFree: false, query: '',
};

// ---------- diagnóstico ----------
function diag(msg, ok = true) {
  const line = `${new Date().toLocaleTimeString()} ${ok ? '✓' : '✗'} ${msg}`;
  S.diag.unshift(line); S.diag = S.diag.slice(0, 60);
  const el = $('#diag'); if (el) el.textContent = S.diag.join('\n');
  if (!ok) console.warn(msg);
}

// Proxies CORS de respaldo: se usan solo si el navegador no puede llamar al host directamente
// (bloqueo de red, extensión, webview sin CORS…). El modo que funciona se recuerda por host.
const PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
];
const hostMode = {}; // host -> -1 directo | índice del proxy
const hostDead = {}; // host -> timestamp hasta el que no se reintenta
function hostOk(host) { return !(hostDead[host] && Date.now() < hostDead[host]); }
async function fetchJSON(url, opts) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getJSON(url, opts = {}) {
  const host = (() => { try { return new URL(url, location.href).host; } catch { return url; } })();
  const sameOrigin = host === location.host || !/^https?:/.test(url);
  if (sameOrigin) return fetchJSON(url, opts);
  if (!hostOk(host)) throw new Error(`${host} sin conexión (reintento en ${Math.ceil((hostDead[host] - Date.now()) / 1000)} s)`);
  const known = hostMode[host];
  if (known != null && known >= 0) return fetchJSON(PROXIES[known](url), opts);
  try { const j = await fetchJSON(url, opts); hostMode[host] = -1; return j; }
  catch (e) {
    if (!(e instanceof TypeError)) throw e; // 4xx/5xx reales: no insistir por proxy
    let last = e;
    for (let i = 0; i < PROXIES.length; i++) {
      try { const j = await fetchJSON(PROXIES[i](url), opts); hostMode[host] = i; diag(`${host}: bloqueado en directo, usando proxy ${new URL(PROXIES[i]('https://x')).host}`); return j; }
      catch (e2) { last = e2; }
    }
    // sonda de control para distinguir "sin internet" de "host bloqueado"
    let ctl = 'sin probar';
    try { const r = await fetch('https://api.github.com/zen', { cache: 'no-store' }); ctl = r.ok ? 'internet OK' : 'control ' + r.status; } catch { ctl = 'sin internet'; }
    diag(`${host}: directo=${e.message} · ${ctl} · online=${navigator.onLine}`, false);
    hostDead[host] = Date.now() + 3 * 60e3;
    throw new Error(`No se pudo conectar con ${host} (directo ni por proxy): ${last.message}`);
  }
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
    case 'min': return st.sp ? st.sp / 60 : 0;
    default: return 0;
  }
}
function fantasyPoints(st) {
  const sc = S.league?.scoring_settings || {};
  let t = 0;
  for (const [k, w] of Object.entries(sc)) { if (!w) continue; t += Number(w) * statVal(st, k); }
  return t;
}
const STAT_LABELS = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'ROB', blk: 'TAP', to: 'PÉRD', tpm: '3PM', tpa: '3PA', fgm: 'FGM', fga: 'FGA', fgmi: 'FG fall.', ftm: 'FTM', fta: 'FTA', ftmi: 'FT fall.', tpmi: '3P fall.', oreb: 'REB OF', dreb: 'REB DEF', dd: 'Doble-doble', td: 'Triple-doble', qd: 'Cuádruple', pf: 'Faltas', tf: 'Técnicas', ff: 'Flagrantes', ej: 'Expulsión', min: 'Minutos', gp: 'Juegos', gs: 'Titular', fg_pct: 'FG%', ft_pct: 'FT%', tp_pct: '3P%', pts_std: 'pts std' };

// ---------- carga Sleeper ----------
async function loadSnapshot() {
  try {
    const snap = await fetchJSON(`${DATA}snapshot.json?v=${Date.now()}`);
    if (!snap?.league || !snap?.user) return null;
    const sameUser = (snap.user.username || '').toLowerCase() === S.cfg.user.toLowerCase();
    const sameLeague = (snap.league.name || '').toLowerCase().includes(S.cfg.league.toLowerCase());
    if (!sameUser || !sameLeague) { diag(`snapshot es de ${snap.user.username}/${snap.league.name}; se usa la API`, false); return null; }
    return snap;
  } catch (e) { diag('sin snapshot del relay: ' + e.message, false); return null; }
}
function applyCore() {
  const lg = S.league;
  $('#leagueName').textContent = `${lg.name} · ${lg.season}`;
  document.title = `Lesiones NBA · ${lg.name}`;
  const users = Object.fromEntries((S.users || []).map((u) => [u.user_id, u]));
  S.owner = {};
  for (const r of S.rosters || []) {
    const u = users[r.owner_id] || {};
    const name = u.metadata?.team_name || u.display_name || `roster ${r.roster_id}`;
    for (const pid of r.players || []) S.owner[pid] = name;
  }
  diag(`liga ${lg.name}: ${(S.rosters || []).length} equipos, ${Object.keys(S.owner).length} jugadores con dueño`);
}
async function loadCore() {
  const snap = await loadSnapshot();
  if (!snap) throw new Error('No encontré los datos del relay (data/snapshot.json). Corre el workflow nba-draft-relay.yml.');
  S.snap = snap; S.league = snap.league; S.users = snap.users || []; S.rosters = snap.rosters || [];
  diag(`datos del relay generados ${snap.generated_at}`);
  applyCore();
}

const KEEP = ['player_id', 'first_name', 'last_name', 'team', 'position', 'fantasy_positions', 'status', 'active', 'age', 'years_exp', 'injury_status', 'injury_body_part', 'injury_notes', 'injury_start_date', 'espn_id', 'search_rank', 'number', 'height', 'weight', 'college', 'news_updated', 'depth_chart_order', 'depth_chart_position', 'birth_date'];
async function loadPlayers() {
  let all = null;
  try { all = await fetchJSON(`${DATA}players.json?v=${S.snap?.generated_at || Date.now()}`); diag(`jugadores del relay (${Object.keys(all).length})`); }
  catch (e) { diag('players.json del relay: ' + e.message, false); }
  if (!all) throw new Error('No encontré data/players.json del relay.');
  const trimmed = {};
  for (const [id, p] of Object.entries(all)) {
    if (!p || !p.first_name) continue;
    const t = {}; for (const k of KEEP) if (p[k] != null) t[k] = p[k];
    trimmed[id] = t;
  }
  S.players = trimmed;
  const withEspn = Object.values(trimmed).filter((x) => x.espn_id).length;
  diag(`jugadores listos (${Object.keys(trimmed).length}, ${withEspn} con id ESPN)`);
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
  if (S.snap) {
    const v = S.snap.generated_at || Date.now();
    const [st, pr] = await Promise.all([
      fetchJSON(`${DATA}stats.json?v=${v}`).catch((e) => { diag('stats.json del relay: ' + e.message, false); return null; }),
      fetchJSON(`${DATA}proj.json?v=${v}`).catch(() => null),
    ]);
    if (st && Object.keys(st).length > 10) {
      S.stats = st; S.statsSrc = S.snap.statsSrc || 'relay'; S.proj = pr || {};
      S.statsSeason = S.snap.statsSeason || prev; S.projSeason = S.snap.projSeason || String(lgSeason);
      diag(`stats ${S.statsSeason} (${Object.keys(st).length}) y proyecciones (${Object.keys(S.proj).length}) del relay`);
      const _lbl = $('#statsSeasonLbl'); if (_lbl) _lbl.textContent = `temporada ${S.statsSeason}-${String(Number(S.statsSeason) + 1).slice(2)}${S.statsSrc === 'espn' ? ' (ESPN)' : ''}`;
      return;
    }
  }
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
  const _lbl = $('#statsSeasonLbl'); if (_lbl) _lbl.textContent = `temporada ${prev}-${String(lgSeason).slice(2)}${S.statsSrc === 'espn' ? ' (ESPN)' : ''}`;
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

// ---------- valoración (para la ficha) ----------
// Las proyecciones de Sleeper vienen POR JUEGO (gp = 1); las stats de la temporada pasada son totales.
function perGameOf(st) {
  if (!st) return null;
  const gp = Number(st.gp) || 0;
  const fp = fantasyPoints(st);
  if (gp <= 1.5) return fp;          // ya es por juego
  return gp ? fp / gp : null;
}
function expectedGames(p, st) {
  let g = 72;
  const gpLast = st && Number(st.gp) > 1.5 ? Number(st.gp) : null;
  if (gpLast != null) g = 0.6 * gpLast + 0.4 * 72;
  const inj = (p.injury_status || '').toLowerCase();
  if (/out|ir|season/.test(inj)) g *= 0.8;
  else if (/doubt/.test(inj)) g *= 0.93;
  else if (/quest|gtd|dtd|day/.test(inj)) g *= 0.97;
  if (p.age && p.age >= 33) g *= 0.95;
  return Math.max(35, Math.min(80, Math.round(g)));
}
function adpOf(p) {
  const pr = S.proj[p.player_id];
  const a = pr && Number(pr.adp_std);
  if (a && a > 0 && a < 900) return a;
  return p.search_rank && p.search_rank < 9000 ? p.search_rank : null;
}
function playerValue(p) {
  const pr = S.proj[p.player_id], st = S.stats[p.player_id];
  const projPG = perGameOf(pr);
  const lastPG = perGameOf(st);
  const lastTot = st ? fantasyPoints(st) : null;
  const gpLast = st && Number(st.gp) > 1.5 ? Number(st.gp) : null;
  const games = expectedGames(p, st);
  const basePG = projPG ?? lastPG ?? 0;
  const V = basePG * games;                 // pts esperados en la temporada
  return { V, games, basePG, projPG, projTot: projPG != null ? projPG * games : null, lastTot, lastPG, gpLast, adp: adpOf(p) };
}
function injuryFactor(p) {
  const s = (p.injury_status || '').toLowerCase();
  if (!s) return { f: 1, txt: '' };
  if (/out|ir|season/.test(s)) return { f: 0.85, txt: `lesionado: ${p.injury_status}${p.injury_body_part ? ' (' + p.injury_body_part + ')' : ''}` };
  if (/doubt/.test(s)) return { f: 0.95, txt: `dudoso (${p.injury_body_part || ''})` };
  if (/quest|gtd|dtd|day/.test(s)) return { f: 0.98, txt: `día a día (${p.injury_body_part || ''})` };
  return { f: 1, txt: '' };
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
async function espnBundle() {
  if (S.espnData !== undefined) return S.espnData;
  try { S.espnData = await fetchJSON(`${DATA}espn.json?v=${S.snap?.generated_at || Date.now()}`); diag(`ESPN del relay (${S.espnData.generated_at})`); }
  catch (e) { S.espnData = null; diag('espn.json del relay: ' + e.message, false); }
  return S.espnData;
}
async function cached(key, fn) { if (S.cache[key]) return S.cache[key]; const v = await fn().catch((e) => { diag(`${key}: ${e.message}`, false); return null; }); S.cache[key] = v; return v; }

// Rango de fechas de la temporada pasada según todos los registros juego a juego del relay.
function seasonSpan(bundle) {
  if (bundle?._span) return bundle._span;
  let min = '9999', max = '0000';
  for (const a of Object.values(bundle?.athletes || {})) for (const g of a.games || []) { if (g[0] < min) min = g[0]; if (g[0] > max) max = g[0]; }
  return (bundle._span = { min, max });
}
// Ausencias largas: huecos de 10+ días entre juegos (se ignora el receso del Juego de Estrellas), más inicio y final de temporada.
function lastAbsence(eid, bundle) {
  const games = bundle?.athletes?.[eid]?.games;
  if (!games || games.length < 10) return undefined;
  const { min, max } = seasonSpan(bundle);
  const D = (x) => new Date(x + 'T12:00:00');
  const days = (a, b) => Math.round((D(b) - D(a)) / 864e5);
  const fd = (x) => D(x).toLocaleDateString('es', { day: 'numeric', month: 'short' });
  const list = [];
  if (days(min, games[0][0]) >= 10) list.push({ from: min, to: games[0][0], d: days(min, games[0][0]), kind: 'start' });
  for (let k = 1; k < games.length; k++) {
    const a = games[k - 1][0], b = games[k][0], d = days(a, b);
    const inBreak = a >= '2026-02-08' && b <= '2026-02-26' && d <= 11;
    if (d >= 10 && !inBreak) list.push({ from: a, to: b, d, kind: 'gap' });
  }
  const lastD = games[games.length - 1][0];
  if (days(lastD, max) >= 10) list.push({ from: lastD, to: max, d: days(lastD, max), kind: 'end' });
  if (!list.length) return null;
  const est = (d) => Math.max(1, Math.round(d / 2.2) - 1);
  list.sort((a, b) => b.to.localeCompare(a.to));
  const l = list[0];
  const text = l.kind === 'start' ? `se perdió el inicio de temporada hasta el ${fd(l.to)} (~${est(l.d)} juegos)`
    : l.kind === 'end' ? `no jugó desde el ${fd(l.from)} hasta el final de temporada (~${est(l.d)} juegos)`
    : `fuera del ${fd(l.from)} al ${fd(l.to)} (~${est(l.d)} juegos)`;
  return { text, total: list.length };
}
function injuryNews(n, p) {
  const t = `${n.headline || ''} ${n.description || ''}`;
  if (/highlights/i.test(n.headline || '')) return false;
  if (!t.includes(p.last_name)) return false;
  return /\b(injur\w*|sprain\w*|strain\w*|tweak\w*|surgery|torn|fractur\w*|sidelined|ruled out|day-to-day|knee|ankle|hamstring|calf|achilles|foot|shoulder|wrist|hip|groin|quad\w*|thigh|concussion|illness|soreness|lower back|back spasms?)\b/i.test(t);
}
function ownerOf(pid) { return S.owner[pid] || null; }
function ownerTag(pid) { const o = ownerOf(pid); return o ? `<span class="muted small">· ${esc(o)}</span>` : '<span class="small" style="color:var(--good)">· LIBRE</span>'; }
function depthChartHTML(p) {
  if (!p.team) return '<span class="muted small">Sin equipo.</span>';
  const team = Object.values(S.players).filter((q) => q.team === p.team && (q.active !== false));
  const byPos = {};
  for (const q of team) {
    const pos = q.depth_chart_position || null; const ord = q.depth_chart_order || null;
    if (!pos || !ord) continue;
    (byPos[pos] = byPos[pos] || []).push({ q, ord });
  }
  const cols = ['PG', 'SG', 'SF', 'PF', 'C'].filter((c) => byPos[c]);
  if (!cols.length) return '<span class="muted small">Sleeper no publica depth chart para este equipo todavía.</span>';
  const depth = Math.max(...cols.map((c) => byPos[c].length));
  const cell = (e) => {
    if (!e) return '<td></td>';
    const q = e.q; const st = S.stats[q.player_id]; const pv = playerValue(q);
    const own = ownerTag(q.player_id);
    return `<td class="${q.player_id === p.player_id ? 'me' : ''}">${nameCell(q)} ${injTag(q)}<div class="small muted">${fmt(pv.basePG)} pts/J${st?.gp ? ` · ${fmt0(st.gp)} JJ` : ''} ${own}</div></td>`;
  };
  let html = `<div class="table-wrap"><table class="tbl mini depth"><thead><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>`;
  for (let i = 1; i <= depth; i++) {
    html += `<tr><td class="muted">${i === 1 ? '<b>Titular</b>' : i === 2 ? 'Banca 1' : 'Banca ' + (i - 1)}</td>${cols.map((c) => cell(byPos[c].find((e) => e.ord === i))).join('')}</tr>`;
  }
  const rest = team.filter((q) => !q.depth_chart_position || !q.depth_chart_order).filter((q) => playerValue(q).basePG > 0).sort((a, b) => playerValue(b).basePG - playerValue(a).basePG);
  html += '</tbody></table></div>';
  if (rest.length) html += `<div class="small muted" style="margin-top:6px">Fuera del depth chart: ${rest.map((q) => `${esc(q.first_name)} ${esc(q.last_name)}`).join(', ')}</div>`;
  return html;
}
function bindNames(root) { root.querySelectorAll('.name[data-pid]').forEach((el) => el.onclick = () => openPlayer(el.dataset.pid)); }

async function openPlayer(pid) {
  const p = S.players[pid]; if (!p) return;
  const st = S.stats[pid], pr = S.proj[pid];
  const box = $('#modalBody'); $('#modal').classList.remove('hidden');
  const img = p.espn_id ? `https://a.espncdn.com/i/headshots/nba/players/full/${p.espn_id}.png` : `https://sleepercdn.com/content/nba/players/thumb/${pid}.jpg`;
  const inj = p.injury_status ? `<div><span class="inj ${esc(p.injury_status)}">${esc(p.injury_status)}</span> ${esc(p.injury_body_part || '')} ${p.injury_notes ? '· ' + esc(p.injury_notes) : ''} ${p.injury_start_date ? '<span class="muted small">desde ' + esc(p.injury_start_date) + '</span>' : ''}</div>` : '<div class="muted small">Sin lesión reportada en Sleeper</div>';
  const pv = playerValue(p);
  const sline = (s, lbl, perGame) => {
    if (!s) return `<p class="muted small">Sin ${lbl}.</p>`;
    const gp = perGame ? (Number(s.gp) > 1.5 ? Number(s.gp) : 1) : (Number(s.gp) || 1);
    const fppg = fantasyPoints(s) / gp;
    return `<div class="statline"><div class="s"><b>${perGame ? pv.games : fmt0(s.gp)}</b><span>${perGame ? 'JJ esp.' : 'JJ'}</span></div><div class="s"><b>${fmt(fppg)}</b><span>pts/J</span></div><div class="s"><b>${fmt0(perGame ? fppg * pv.games : fantasyPoints(s))}</b><span>${perGame ? 'pts esperados' : 'pts total'}</span></div></div>`;
  };
  box.innerHTML = `
    <div class="phead"><img src="${img}" onerror="this.style.display='none'" alt=""><div>
      <h2>${esc(p.first_name)} ${esc(p.last_name)} <span class="muted">#${esc(p.number ?? '')}</span></h2>
      <div>${posTags(p)} <b>${esc(p.team || 'Sin equipo')}</b> · ${p.age ? p.age + ' años' : ''} · ${p.years_exp != null ? (p.years_exp === 0 ? 'novato' : p.years_exp + ' temporadas') : ''} ${p.height ? '· ' + esc(p.height) : ''} ${p.college ? '· ' + esc(p.college) : ''}</div>
      ${inj}
      ${ownerOf(pid) ? `<div class="small">En la liga: <b>${esc(ownerOf(pid))}</b></div>` : `<div class="small" style="color:var(--good)">LIBRE en la liga · ADP Sleeper ${pv.adp != null ? fmt(pv.adp, 1) : '—'}</div>`}
    </div></div>
    ${pr ? `<div class="pbox"><h3>Proyección ${S.projSeason || ''}-${String(Number(S.projSeason) + 1).slice(2)} por juego (pts de esta liga)</h3>${sline(pr, 'proyección', true)}</div>` : ''}
    <div class="pbox" style="margin-top:10px"><h3>Temporada pasada ${S.statsSeason || ''}-${String(Number(S.statsSeason) + 1).slice(2)} (promedios por juego, puntos de esta liga)</h3>${sline(st, 'stats del año pasado', false)}</div>
    <div class="pbox" style="margin-top:10px"><h3 id="pBestTitle">Mejores 5 juegos ${S.statsSeason || ''}-${String(Number(S.statsSeason) + 1).slice(2)} (pts de esta liga)</h3><div id="pBest" class="loading">Cargando…</div></div>
    <div class="pgrid" style="margin-top:10px">
      <div class="pbox"><h3>Noticias recientes</h3><div id="pNews" class="news loading">Cargando…</div></div>
      <div class="pbox"><h3>Lesiones (ESPN)</h3><div id="pInj" class="loading">Cargando…</div><h3 style="margin-top:12px">Temporadas anteriores</h3><div id="pSeasons" class="loading">Cargando…</div></div>
    </div>
    <div class="pbox" style="margin-top:10px"><h3>Depth chart de ${esc(p.team || '')} <span class="muted" style="text-transform:none">(titulares y banca según Sleeper)</span></h3><div id="pDepth">${depthChartHTML(p)}</div></div>`;
  bindNames($('#pDepth'));

  // --- ESPN en paralelo ---
  const eid = p.espn_id ? String(p.espn_id) : null;
  const newsEl = $('#pNews'), injEl = $('#pInj'), seaEl = $('#pSeasons');
  const tasks = [];
  const bundle = await espnBundle();
  tasks.push((async () => {
    const bestEl = $('#pBest'); bestEl.classList.remove('loading');
    const games = eid ? bundle?.athletes?.[eid]?.games : null;
    const gs = eid ? bundle?.athletes?.[eid]?.games_season : null;
    if (gs && games?.length) { const yr = Number(gs) - 1; $('#pBestTitle').textContent = `Mejores 5 juegos ${yr}-${String(yr + 1).slice(2)}${String(yr + 1) !== String(Number(S.statsSeason) + 1) ? ' (su última temporada con juegos)' : ''} (pts de esta liga)`; }
    if (!games || !games.length) { bestEl.innerHTML = `<span class="muted small">${bundle ? 'Sin registro juego a juego para este jugador (se baja para los ~350 mejores por ADP).' : 'Registro no disponible.'}</span>`; return; }
    const rows = games.map((g) => {
      const [date, opp, min, pts, reb, ast, stl, blk, to, tpm, fgm, fga, ftm, fta, res] = g;
      const cats = [pts, reb, ast, stl, blk].filter((v) => (v || 0) >= 10).length;
      const line = { pts: pts || 0, reb: reb || 0, ast: ast || 0, stl: stl || 0, blk: blk || 0, to: to || 0, tpm: tpm || 0, fgm: fgm || 0, fga: fga || 0, ftm: ftm || 0, fta: fta || 0, dd: cats >= 2 ? 1 : 0, td: cats >= 3 ? 1 : 0 };
      return { date, opp, min, res, ...line, fp: fantasyPoints(line) };
    });
    const sorted = [...rows].sort((a, b) => b.fp - a.fp);
    const top = sorted.slice(0, 5);
    const avg = rows.reduce((a, r) => a + r.fp, 0) / rows.length;
    const over = (n) => rows.filter((r) => r.fp >= n).length;
    bestEl.innerHTML = `<div class="statline">${top.map((r, i) => `<div class="s" title="${esc(r.date)} ${esc(r.opp)}"><b>${fmt(r.fp)}</b><span>#${i + 1} · ${esc(r.date.slice(5))} ${esc(r.opp)}</span></div>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">${rows.length} juegos registrados · promedio ${fmt(avg)} pts · top 5 promedio ${fmt(top.reduce((a, r) => a + r.fp, 0) / top.length)} pts · juegos de 50+ pts: ${over(50)} · 40+: ${over(40)} · menos de 20: ${rows.filter((r) => r.fp < 20).length}</div>`;
  })());
  tasks.push((async () => {
    let news = [];
    if (bundle && eid) {
      news = bundle.athletes?.[eid]?.news || [];
      if (!news.length) news = (bundle.news || []).filter((a) => (a.athletes || []).includes(eid) || `${a.headline} ${a.description}`.includes(p.last_name)).slice(0, 8);
      if (!news.length && p.team) { const t = bundle.teams?.[TEAM_ALIAS[p.team] || p.team]; if (t) news = (bundle.news || []).filter((a) => (a.teams || []).includes(String(t.id))).slice(0, 5).map((a) => ({ ...a, headline: '[equipo] ' + a.headline })); }
      news = news.map((n) => ({ ...n, links: { web: { href: n.href } } }));
    }
    if (!news.length && eid && hostOk('site.web.api.espn.com')) {
      const ov = await cached('ov' + eid, () => getJSON(`${ESPN_WEB}/athletes/${eid}/overview`));
      news = ov?.news || [];
      if (!news.length) { const nj = await cached('nw' + eid, () => getJSON(`${ESPN_SITE}/news?limit=12&athletes=${eid}`)); news = (nj?.articles || []).filter((a) => JSON.stringify(a.categories || []).includes(`"athleteId":${eid}`) || (a.headline || '').includes(p.last_name)); }
    }
    if (!news.length && p.team && hostOk('site.api.espn.com')) {
      const teams = await espnTeams(); const t = teams[TEAM_ALIAS[p.team] || p.team];
      if (t) { const nj = await cached('tn' + t.id, () => getJSON(`${ESPN_SITE}/news?limit=25&team=${t.id}`)); news = (nj?.articles || []).filter((a) => `${a.headline} ${a.description}`.includes(p.last_name)).slice(0, 8); if (!news.length) news = (nj?.articles || []).slice(0, 5).map((a) => ({ ...a, headline: '[equipo] ' + a.headline })); }
    }
    newsEl.classList.remove('loading');
    newsEl.innerHTML = news.length ? news.slice(0, 10).map((n) => `<div class="n"><a href="${esc(n.links?.web?.href || n.links?.web?.short?.href || '#')}" target="_blank" rel="noopener">${esc(n.headline)}</a><div class="d">${n.published ? new Date(n.published).toLocaleDateString() : ''} ${n.description ? '· ' + esc(n.description) : ''}</div></div>`).join('') : '<span class="muted">Sin noticias disponibles. ' + (p.news_updated ? 'Última actualización en Sleeper: ' + new Date(p.news_updated).toLocaleString() : '') + '</span>';
  })());
  tasks.push((async () => {
    let i = bundle && eid ? bundle.injuries?.[eid] : null;
    if (!i && !bundle && hostOk('site.api.espn.com')) { const m = await espnInjuries(); i = eid ? m[eid] : null; }
    injEl.classList.remove('loading');
    const fdate = (d) => { try { return new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return d; } };
    const nowInj = i || p.injury_status;
    let html = '';
    if (nowInj) {
      const status = i?.status || p.injury_status;
      const part = i?.type || p.injury_body_part;
      html += `<div><span class="inj ${esc(String(status).replace(/\s/g, ''))}">${esc(status)}</span> <b>Lesionado ahora</b>${part ? ' · ' + esc(part) : ''}</div>`;
      const since = i?.date || p.injury_start_date;
      if (since) html += `<div class="small">Desde: ${esc(fdate(since))}</div>`;
      const det = i?.detail || p.injury_notes;
      if (det) html += `<div class="small muted">${esc(det)}</div>`;
      if (i?.returnDate) html += `<div class="small muted">Regreso estimado: ${esc(fdate(i.returnDate))}</div>`;
    } else {
      html += '<div style="color:var(--good)"><b>Sin lesión actual</b></div>';
    }
    // última ausencia del año pasado, calculada del registro juego a juego (ESPN no da el historial de lesiones)
    const ab = lastAbsence(eid, bundle);
    html += `<div style="margin-top:8px"><b>Última ausencia ${S.statsSeason || ''}-${String(Number(S.statsSeason) + 1).slice(2)}:</b> ` + (ab === undefined
      ? '<span class="muted small">sin registro juego a juego</span>'
      : ab ? `${esc(ab.text)}<div class="small muted">Motivo no disponible en las fuentes (puede ser lesión, descanso o traspaso).${ab.total > 1 ? (ab.total === 2 ? ' Hubo otra ausencia larga ese año.' : ` Hubo otras ${ab.total - 1} ausencias largas ese año.`) : ''}</div>` : '<span class="muted small">no se perdió más de unos pocos juegos seguidos</span>') + '</div>';
    // noticia reciente de lesión (solo si nombra al jugador y una parte del cuerpo)
    const nws = (bundle?.athletes?.[eid]?.news || []).concat(bundle?.news || []).filter((n) => injuryNews(n, p)).sort((a, b) => String(b.published).localeCompare(String(a.published)))[0];
    if (nws) html += `<div style="margin-top:8px"><b>Noticia reciente:</b> <a href="${esc(nws.href || '#')}" target="_blank" rel="noopener">${esc(nws.headline)}</a> <span class="muted small">${nws.published ? esc(fdate(nws.published.slice(0, 10))) : ''}</span></div>`;
    injEl.innerHTML = html;
  })());
  tasks.push((async () => {
    seaEl.classList.remove('loading');
    if (!eid) { seaEl.innerHTML = '<span class="muted small">Sin id de ESPN.</span>'; return; }
    let labels = null, rows = null;
    const bs = bundle?.athletes?.[eid]?.seasons;
    if (bs?.labels) { labels = bs.labels; rows = (bs.rows || []).map((r) => ({ season: r.season, team: r.team, stats: r.stats })); }
    else if (hostOk('site.web.api.espn.com')) {
      const sj = await cached('st' + eid, () => getJSON(`${ESPN_WEB}/athletes/${eid}/stats`));
      const cat = (sj?.categories || []).find((c) => /averag/i.test(c.name)) || sj?.categories?.[0];
      if (cat) { labels = cat.labels; rows = (cat.statistics || []).map((r) => ({ season: r.season?.displayName || r.season?.year, team: (r.teamSlug || '').toUpperCase().slice(0, 3), stats: r.stats })); }
    }
    if (!labels) { seaEl.innerHTML = '<span class="muted small">Sin historial.</span>'; return; }
    const want = ['GP', 'MIN', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', '3PM', 'FG%', 'FT%'];
    const idx = want.map((w) => labels.indexOf(w));
    rows = rows.slice(-6).reverse();
    seaEl.innerHTML = `<table class="tbl mini"><thead><tr><th>Temp</th><th>Eq</th>${want.map((w) => `<th class="num">${w}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.season || '')}</td><td>${esc(r.team || '')}</td>${idx.map((i) => `<td class="num">${i >= 0 ? esc(r.stats?.[i]) : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  })());
  await Promise.allSettled(tasks);
}


// ---------- celdas reutilizables ----------
function injTag(p) { return p.injury_status ? `<span class="inj ${esc(p.injury_status.replace(/\s/g, ''))}">${esc(p.injury_status)}</span>` : ''; }
function posTags(p) { return playerPositions(p).map((x) => `<span class="pos">${x}</span>`).join(''); }
function nameCell(p) { return `<span class="name" data-pid="${p.player_id}">${esc(p.first_name)} ${esc(p.last_name)}</span>`; }

// ---------- lesiones: tablas ----------
function sevTag(s) { return s ? `<span class="inj ${esc(String(s).replace(/\s/g, ''))}">${esc(s)}</span>` : '<span class="muted small">sano</span>'; }
function nm(pid, fallback) { const p = S.players[pid]; return p ? nameCell(p) : esc(fallback || pid); }
function ownerCell(owner, free) { return free || !owner ? '<span style="color:var(--good)"><b>LIBRE</b></span>' : esc(owner); }
function recentCell(rec) { return (rec || []).map((r) => `<span title="${esc(r.date)} vs ${esc(r.opp)}">${fmt(r.fp)} <span class="muted">(${r.min}m)</span></span>`).join(', ') || '<span class="muted">sin juegos</span>'; }
function passes(name, owner, free) { if (S.onlyFree && !(free || !owner)) return false; if (S.query && !String(name).toLowerCase().includes(S.query)) return false; return true; }
function changeCell(c) { return `${sevTag(c.from)} → ${sevTag(c.to)}${c.part ? ' · ' + esc(c.part) : ''}${c.return ? '<div class="small muted">regreso est. ' + esc(c.return) + '</div>' : ''}${c.detail ? `<div class="small muted" title="${esc(c.detail)}">${esc(c.detail.slice(0, 70))}${c.detail.length > 70 ? '…' : ''}</div>` : ''}`; }
function whoCell(c) { return `<b>${nm(c.pid, c.name)}</b> <span class="muted small">${esc(c.team)} · ${(c.pos || []).filter(Boolean).join('/')}</span>`; }

async function renderInjuries() {
  let rep = null, log = null;
  try { rep = await fetchJSON(`${DATA}injury_report.json?v=${Date.now()}`); } catch (e) { setHTML('#gainList', `<p class="muted">Sin reporte todavía (${esc(e.message)}).</p>`); return; }
  try { log = await fetchJSON(`${DATA}injury_log.json?v=${Date.now()}`); } catch {}
  S.report = rep;
  const since = rep.since ? new Date(rep.since).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'el reporte anterior';
  $('#repMeta').textContent = `Cambios desde ${since} · actualizado ${rep.generated_at ? new Date(rep.generated_at).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`;
  const worse = (rep.changes || []).filter((c) => c.kind === 'peor');
  const better = (rep.changes || []).filter((c) => c.kind === 'mejor');

  const mateRows = (list, gain) => `<table class="tbl mini mates"><thead><tr><th>${gain ? 'Gana minutos' : 'Pierde minutos'}</th><th>Dueño</th><th class="num" title="Promedio de sus 5 mejores juegos del año pasado, puntos de la liga">Techo</th><th class="num hm">Proy/J</th><th>Últimos juegos</th></tr></thead><tbody>${list.map((m) => `<tr><td>${nm(m.pid, m.name)}<div class="small muted">${(m.pos || []).join('/')} · ${esc((m.depth || []).join(''))}</div></td><td>${ownerCell(m.owner, m.free)}</td><td class="num">${m.top5 ?? '—'}</td><td class="num hm">${m.proj ?? '—'}</td><td class="small">${recentCell(m.recent)}</td></tr>`).join('')}</tbody></table>`;
  const card = (c, list, gain, emptyMsg) => `<div class="icard"><div class="ihead"><div>${whoCell(c)}</div><div>${gain ? changeCell(c) : `${sevTag(c.from)} → ${sevTag(c.to)}`}</div><div class="small">Dueño: ${ownerCell(c.owner)}</div></div>${list.length ? mateRows(list, gain) : `<div class="small muted" style="padding:6px 0">${emptyMsg}</div>`}</div>`;

  const cards1 = [];
  for (const c of worse) {
    const bens = (c.beneficiaries || []).filter((m) => passes(m.name, m.owner, m.free));
    if (!bens.length && !passes(c.name, c.owner, !c.owner)) continue;
    cards1.push(card(c, bens, true, (c.beneficiaries || []).length ? 'sin beneficiarios que pasen el filtro' : 'baja sin impacto claro en la rotación'));
  }
  setHTML('#gainList', cards1.join('') || '<p class="muted">Sin lesiones nuevas o agravadas en el período.</p>');

  const cards2 = [];
  for (const c of better) {
    const los = (c.losers || []).filter((m) => passes(m.name, m.owner, m.free));
    if (!los.length && !passes(c.name, c.owner, !c.owner)) continue;
    cards2.push(card(c, los, false, c.losers ? 'nadie pierde minutos claros' : 'mejora leve, sin cambio de rotación'));
  }
  setHTML('#loseList', cards2.join('') || '<p class="muted">Sin regresos en el período.</p>');

  const cur = (rep.current_out || []).filter((c) => passes(c.name, c.owner, !c.owner));
  setHTML('#outTable', cur.length
    ? `<table class="tbl"><thead><tr><th>Jugador</th><th class="hm">Pos</th><th>Estado</th><th class="hm">Parte</th><th>Regreso</th><th class="num hm">Proy/J</th><th>Dueño</th></tr></thead><tbody>${cur.map((c) => `<tr><td>${nm(c.pid, c.name)}<div class="small muted">${esc(c.team)}${c.part ? ' · ' + esc(c.part) : ''}</div></td><td class="hm">${(c.pos || []).join('/')}</td><td>${sevTag(c.status)}</td><td class="hm">${esc(c.part || '')}</td><td class="small">${esc(c.return || '—')}</td><td class="num hm">${c.proj}</td><td>${ownerCell(c.owner)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nadie relevante en Out.</p>');
  { const oc = $('#outCount'); if (oc) oc.textContent = `(${cur.length})`; }

  if (log) setHTML('#injLog', Object.keys(log).sort().reverse().slice(0, 10).map((k) => `<div style="margin-bottom:6px"><b>${esc(k)}</b>: ${(log[k] || []).map((c) => `${esc(c.name)} <span class="muted">(${esc(c.team)})</span> ${esc(c.from || 'sano')}→${esc(c.to || 'sano')}`).join(' · ') || 'sin cambios'}</div>`).join(''));
  ['#gainList', '#loseList', '#outTable'].forEach((sel) => bindNames($(sel)));
}

// ---------- arranque ----------
async function boot() {
  $('#leagueName').textContent = 'cargando…';
  try {
    await loadCore();
    await loadPlayers();
    await loadStats();
    await renderInjuries();
    setInterval(renderInjuries, 5 * 60e3);
  } catch (e) {
    diag(e.message, false);
    $('#leagueName').innerHTML = `<span class="err">${esc(e.message)}</span>`;
    const d = document.querySelector('.diag'); if (d) d.open = true;
  }
}
$('#refreshBtn').onclick = () => renderInjuries();
$('#onlyFree').onchange = (e) => { S.onlyFree = e.target.checked; renderInjuries(); };
$('#search').oninput = (e) => { S.query = e.target.value.trim().toLowerCase(); renderInjuries(); };
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
boot();
