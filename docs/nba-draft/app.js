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

// Datos estáticos que deja el relay (GitHub Actions) en el mismo origen de la página,
// y rama `nba-live` con los picks en vivo (leída desde raw.githubusercontent.com).
const DATA = 'data/';
const REPO = (() => {
  const m = location.host.match(/^([^.]+)\.github\.io$/); const seg = location.pathname.split('/').filter(Boolean)[0];
  return { owner: m ? m[1] : 'eskenazi2009', repo: (m && seg) ? seg : 'team-ranks' };
})();
const LIVE_RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/nba-live/`;

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
  sortAvail: { key: 'V', dir: -1 },
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
const STAT_LABELS = { pts: 'PTS', reb: 'REB', ast: 'AST', stl: 'ROB', blk: 'TAP', to: 'PÉRD', tpm: '3PM', tpa: '3PA', fgm: 'FGM', fga: 'FGA', fgmi: 'FG fall.', ftm: 'FTM', fta: 'FTA', ftmi: 'FT fall.', tpmi: '3P fall.', oreb: 'REB OF', dreb: 'REB DEF', dd: 'Doble-doble', td: 'Triple-doble', qd: 'Cuádruple', pf: 'Faltas', tf: 'Técnicas', ff: 'Flagrantes', ej: 'Expulsión', min: 'Minutos', gp: 'Juegos', gs: 'Titular', fg_pct: 'FG%', ft_pct: 'FT%', tp_pct: '3P%', pts_std: 'FP std' };

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
  const found = S.league;
  $('#leagueName').textContent = `${found.name} · ${found.season}`;
  document.title = `Draft NBA · ${found.name}`;
  const myRoster = S.rosters.find((r) => r.owner_id === S.user.user_id || (r.co_owners || []).includes(S.user.user_id));
  S.myRosterId = myRoster?.roster_id ?? null;
  S.mySlot = S.draft.draft_order?.[S.user.user_id] ?? null;
  if (S.mySlot == null && S.myRosterId != null && S.draft.slot_to_roster_id) {
    const ent = Object.entries(S.draft.slot_to_roster_id).find(([, rid]) => rid === S.myRosterId);
    if (ent) S.mySlot = Number(ent[0]);
  }
  diag(`draft ${S.draft.draft_id} estado=${S.draft.status} tipo=${S.draft.type} rondas=${S.draft.settings?.rounds} equipos=${S.draft.settings?.teams} mi slot=${S.mySlot}`);
  renderLeague();
}
async function loadCore() {
  const snap = await loadSnapshot();
  if (snap) {
    S.snap = snap; S.state = snap.state; S.user = snap.user; S.league = snap.league; S.users = snap.users || []; S.rosters = snap.rosters || [];
    S.draft = snap.draft; S.traded = snap.traded || []; S.picks = (snap.picks || []).slice().sort((a, b) => a.pick_no - b.pick_no);
    diag(`datos del relay generados ${snap.generated_at} (${S.league.name})`);
    applyCore(); return;
  }
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
  applyCore();
}

const KEEP = ['player_id', 'first_name', 'last_name', 'team', 'position', 'fantasy_positions', 'status', 'active', 'age', 'years_exp', 'injury_status', 'injury_body_part', 'injury_notes', 'injury_start_date', 'espn_id', 'search_rank', 'number', 'height', 'weight', 'college', 'news_updated', 'depth_chart_order', 'depth_chart_position', 'birth_date'];
async function loadPlayers() {
  let all = null;
  try { all = await fetchJSON(`${DATA}players.json?v=${S.snap?.generated_at || Date.now()}`); diag(`jugadores del relay (${Object.keys(all).length})`); }
  catch (e) { diag('players.json del relay: ' + e.message, false); }
  if (!all) {
    const c = lsGet('nba_players_v1');
    if (c && Date.now() - c.ts < 12 * 3600e3 && c.data && Object.keys(c.data).length > 100) { S.players = c.data; diag(`jugadores desde caché (${Object.keys(c.data).length})`); return; }
    all = await getJSON(`${SLEEPER}/players/nba`);
  }
  const trimmed = {};
  for (const [id, p] of Object.entries(all)) {
    if (!p || !p.first_name) continue;
    const t = {}; for (const k of KEEP) if (p[k] != null) t[k] = p[k];
    trimmed[id] = t;
  }
  S.players = trimmed;
  if (!S.snap) lsSet('nba_players_v1', { ts: Date.now(), data: trimmed });
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
      $('#statsSeasonLbl').textContent = `temporada ${S.statsSeason}-${String(Number(S.statsSeason) + 1).slice(2)}${S.statsSrc === 'espn' ? ' (ESPN)' : ''}`;
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
  const did = S.draft.draft_id;
  const cands = [];
  const tasks = [
    fetchJSON(`${LIVE_RAW}live.json?t=${Date.now()}`).then((j) => { if (j?.picks && j?.draft?.draft_id === did) cands.push({ src: 'relay en vivo', ...j }); }).catch(() => {}),
    hostOk('api.sleeper.app')
      ? Promise.all([getJSON(`${SLEEPER}/draft/${did}`), getJSON(`${SLEEPER}/draft/${did}/picks`)]).then(([d, p]) => { if (Array.isArray(p)) cands.push({ src: 'Sleeper directo', draft: d, picks: p, fetched_at: new Date().toISOString() }); }).catch(() => {})
      : Promise.resolve(),
  ];
  await Promise.all(tasks);
  if (!cands.length && !S.picksLoadedOnce) {
    try { const j = await fetchJSON(`${DATA}live.json?v=${Date.now()}`); if (j?.picks) cands.push({ src: 'snapshot', ...j }); } catch {}
  }
  if (!cands.length) { if (!S.picksLoadedOnce) diag('picks: ninguna fuente respondió', false); return; }
  cands.sort((a, b) => (b.picks.length - a.picks.length) || ((b.fetched_at || '') > (a.fetched_at || '') ? 1 : -1));
  const best = cands[0];
  if (best.draft) S.draft = best.draft;
  S.picks = best.picks.slice().sort((a, b) => a.pick_no - b.pick_no);
  if (S.liveSrc !== best.src) { S.liveSrc = best.src; diag(`picks vía ${best.src}` + (best.fetched_at ? ` (${best.fetched_at})` : '')); }
  S.picksLoadedOnce = true;
  S.liveFetchedAt = best.fetched_at || null;
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
  const V = basePG * games;                 // FP esperados en la temporada
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
function availablePlayers() {
  const picked = pickedIds();
  return Object.values(S.players).filter((p) => !picked.has(p.player_id) && p.team && (p.active !== false) && (p.status !== 'Inactive' || S.stats[p.player_id] || S.proj[p.player_id]));
}
function allSlots() { return (S.league?.roster_positions || []).filter((x) => x !== 'IR'); }
function recommend(limit = 8) {
  const avail = availablePlayers().map((p) => ({ p, ...playerValue(p) })).filter((x) => x.V > 0);
  if (!avail.length) return [];
  const T = teams();
  const mine = myPickedPlayers();
  const { slots } = assignRoster(mine);
  const emptyStart = slots.filter((s) => !s.player).map((s) => s.slot);
  const bnTotal = allSlots().filter((x) => x === 'BN').length;
  const bnUsed = Math.max(0, mine.length - (slots.length - emptyStart.length));
  const bnFree = bnTotal - bnUsed;
  const nxt = nextMyPick(), cur = currentPick();
  const n = S.picks.length;
  const nextPickNo = nxt ? nxt.pick_no : n + 1;
  const after = myPicks().find((q) => q.pick_no > nextPickNo);
  const afterNo = after ? after.pick_no : nextPickNo + 2 * T;
  // ¿Quién estará disponible probablemente en mi SIGUIENTE turno? (ADP > ese pick, con margen)
  const likelyLater = avail.filter((x) => x.adp == null ? x.V < 1500 : x.adp > afterNo + 1);
  const bestLaterByPos = {};
  for (const pos of BASE_POS) bestLaterByPos[pos] = Math.max(0, ...likelyLater.filter((x) => playerPositions(x.p).includes(pos)).map((x) => x.V * injuryFactor(x.p).f));
  const bestLaterAny = Math.max(0, ...likelyLater.map((x) => x.V * injuryFactor(x.p).f));

  const scored = avail.map((x) => {
    const pos = playerPositions(x.p);
    const inj = injuryFactor(x.p);
    const Vadj = x.V * inj.f;
    const why = [];
    // encaje en el roster
    const slotPrio = (s) => s === x.p.position ? 0 : BASE_POS.includes(s) ? 1 : (s === 'G' || s === 'F') ? 2 : 3;
    const fills = [...emptyStart].sort((a, b) => slotPrio(a) - slotPrio(b)).find((s) => eligibleForSlot(x.p, s));
    let fit = 1;
    if (fills) why.push(`entra de titular en ${fills}`);
    else if (bnFree > 0) { fit = 0.88; why.push(`iría a la banca (titulares llenos para ${pos.join('/')})`); }
    else { fit = 0.3; why.push('no cabe en tu roster'); }
    // ganancia sobre lo que podrías tomar en tu siguiente turno en esas posiciones
    const later = Math.min(...pos.map((ps) => bestLaterByPos[ps] || bestLaterAny));
    const gain = Vadj - later;
    const score = Vadj * fit + Math.max(0, gain) * 0.5;
    if (gain > 0) why.unshift(`+${fmt0(gain)} FP sobre el mejor ${pos.join('/')} que te esperaría en el pick #${afterNo}`);
    else why.unshift(`un ${pos.join('/')} parecido seguiría libre en tu siguiente turno`);
    if (x.adp != null) {
      if (x.adp <= nextPickNo + 1) why.push(`ADP ${fmt(x.adp, 1)}: hay que tomarlo ahora`);
      else if (x.adp > afterNo + 3) why.push(`ADP ${fmt(x.adp, 1)}: probablemente llega a tu próximo turno`);
    }
    if (inj.txt) why.push(inj.txt);
    if (x.gpLast != null) { if (x.gpLast < 55) why.push(`solo ${x.gpLast} juegos la temporada pasada`); else if (x.gpLast >= 72) why.push(`${x.gpLast} juegos la temporada pasada (durable)`); }
    else if (x.p.years_exp === 0) why.push('novato: sin historial NBA');
    return { ...x, Vadj, score, gain, why, fills, fit };
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
  if (S.liveSrc && S.liveSrc !== 'Sleeper directo') el.title = `Fuente: ${S.liveSrc} ${S.liveFetchedAt || ''}`;
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
  let rows = availablePlayers().map((p) => ({ p, ...playerValue(p) }));
  rows = rows.filter((x) => (x.V > 0 || (x.adp != null && x.adp < 600)) && passesPos(x.p, S.posFilterAvail) && (!q || `${x.p.first_name} ${x.p.last_name} ${x.p.team}`.toLowerCase().includes(q)));
  const { key, dir } = S.sortAvail;
  let recMap = null;
  if (key === 'rec') recMap = new Map(recommend(500).map((r) => [r.p.player_id, r.score]));
  const val = (x) => {
    switch (key) {
      case 'name': return `${x.p.last_name} ${x.p.first_name}`;
      case 'team': return x.p.team || '';
      case 'pos': return playerPositions(x.p).join('/');
      case 'inj': return x.p.injury_status || '';
      case 'rec': return recMap.get(x.p.player_id) ?? -1;
      case 'adp': return x.adp ?? 1e7;
      default: return x[key] ?? (dir < 0 ? -1e9 : 1e9);
    }
  };
  rows.sort((a, b) => { const va = val(a), vb = val(b); return typeof va === 'string' ? dir * va.localeCompare(vb) : dir * (va - vb); });
  rows = rows.slice(0, 300);
  $('#availCount').textContent = `(${rows.length})`;
  const nxt = nextMyPick();
  const th = (k, label, num = true, title = '') => `<th class="${num ? 'num' : ''}" data-k="${k}" title="${esc(title)}">${label}${S.sortAvail.key === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  $('#availTable').innerHTML = `<thead><tr><th>#</th>${th('name', 'Jugador', false)}${th('team', 'Eq', false)}${th('pos', 'Pos', false)}${th('V', '<b>FP esp.</b>', true, 'Puntos de la liga esperados esta temporada = proyección por juego × juegos esperados')}${th('projPG', 'Proy/J', true, 'Proyección de Sleeper por juego con la puntuación de la liga')}${th('games', 'JJ esp.', true, 'Juegos esperados')}${th('lastTot', `FP ${S.statsSeason || ''}`, true, 'Temporada pasada, puntos de la liga')}${th('lastPG', 'FP/J')}${th('gpLast', 'JJ')}${th('adp', 'ADP', true, 'ADP de Sleeper · 🔥 = por ADP no llegaría a tu próximo turno')}${th('rec', 'Rec.', true, 'Puntuación de la recomendación para tu equipo')}${th('inj', 'Lesión', false)}</tr></thead><tbody>` +
    rows.map((x, i) => {
      const risk = x.adp != null && nxt ? (x.adp <= nxt.pick_no + 1 ? '🔥' : '') : '';
      return `<tr><td class="muted">${i + 1}</td><td>${nameCell(x.p)} ${risk}</td><td>${esc(x.p.team)}</td><td>${posTags(x.p)}</td><td class="num"><b>${fmt0(x.V)}</b></td><td class="num">${fmt(x.projPG)}</td><td class="num">${x.games}</td><td class="num">${fmt0(x.lastTot)}</td><td class="num">${fmt(x.lastPG)}</td><td class="num">${x.gpLast ?? '—'}</td><td class="num">${x.adp != null ? fmt(x.adp, 1) : '—'}</td><td class="num">${recMap ? fmt0(recMap.get(x.p.player_id)) : ''}</td><td>${injTag(x.p)}</td></tr>`;
    }).join('') + '</tbody>';
  $('#availTable').querySelectorAll('th[data-k]').forEach((h) => h.onclick = () => { const k = h.dataset.k; const strCol = ['name', 'team', 'pos', 'inj', 'adp'].includes(k); S.sortAvail = { key: k, dir: S.sortAvail.key === k ? -S.sortAvail.dir : (strCol ? 1 : -1) }; renderAvail(); });
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
    const pv = playerValue(p);
    return { p, st, gp, fp, fppg: gp ? fp / gp : 0, proj: pv.V || null, projPG: pv.projPG, picked: picked.has(p.player_id) };
  });
  rows = rows.filter((r) => (!onlyAvail || !r.picked) && passesPos(r.p, S.posFilterPl) && (!q || `${r.p.first_name} ${r.p.last_name} ${r.p.team}`.toLowerCase().includes(q)));
  const { key, dir } = S.sortPl;
  const val = (r) => key === 'fp' ? (pg ? r.fppg : r.fp) : key === 'fppg' ? r.fppg : key === 'proj' ? (pg ? (r.projPG ?? -1) : (r.proj ?? -1)) : key === 'name' ? `${r.p.last_name} ${r.p.first_name}` : key === 'team' ? (r.p.team || '') : key === 'pos' ? playerPositions(r.p).join('/') : key === 'inj' ? (r.p.injury_status || '') : key === 'gp' ? r.gp : (pg && r.gp && key !== 'gp' ? statVal(r.st, key) / r.gp : statVal(r.st, key));
  rows.sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string') ? dir * x.localeCompare(y) : dir * (x - y); });
  rows = rows.slice(0, 400);
  const titles = { fp: 'Puntos de la liga en la temporada pasada', fppg: 'Puntos de la liga por juego en la temporada pasada', proj: 'Puntos esperados esta temporada (proyección × juegos esperados)' };
  const th = (k, label, num = true) => `<th class="${num ? 'num' : ''} ${S.sortPl.key === k ? 'sorted' : ''}" data-k="${k}" title="${esc(titles[k] || '')}">${label}${S.sortPl.key === k ? (dir < 0 ? ' ▼' : ' ▲') : ''}</th>`;
  $('#plTable').innerHTML = `<thead><tr>${th('name', 'Jugador', false)}${th('team', 'Eq', false)}${th('pos', 'Pos', false)}${th('fp', `FP liga${pg ? '/J' : ''}`)}${th('fppg', 'FP/J', true)}${th('proj', pg ? 'Proy/J' : 'FP esp.')}${cols.map((c) => th(c, STAT_LABELS[c] || c.toUpperCase())).join('')}${th('inj', 'Lesión', false)}</tr></thead><tbody>` +
    rows.map((r) => `<tr class="${r.picked ? 'muted' : ''}"><td>${nameCell(r.p)}${r.picked ? ' <span class="small muted">(tomado)</span>' : ''}</td><td>${esc(r.p.team)}</td><td>${posTags(r.p)}</td><td class="num"><b>${fmt(pg ? r.fppg : r.fp, pg ? 1 : 0)}</b></td><td class="num"><b>${fmt(r.fppg)}</b></td><td class="num">${pg ? fmt(r.projPG) : fmt0(r.proj)}</td>${cols.map((c) => `<td class="num">${c === 'gp' || !pg || !r.gp ? fmt(statVal(r.st, c), c === 'gp' || c === 'dd' || c === 'td' ? 0 : (pg ? 1 : 0)) : fmt(statVal(r.st, c) / r.gp)}</td>`).join('')}<td>${injTag(r.p)}</td></tr>`).join('') + '</tbody>';
  $('#plTable').querySelectorAll('th[data-k]').forEach((h) => h.onclick = () => { const k = h.dataset.k; S.sortPl = { key: k, dir: S.sortPl.key === k ? -S.sortPl.dir : (['name', 'team', 'pos', 'inj'].includes(k) ? 1 : -1) }; renderPlayersTable(); });
  bindNames($('#plTable'));
}

// ---------- render: recomendaciones ----------
function renderReco() {
  const recs = recommend(8);
  const item = (r, i) => `<div class="item"><div class="rank">${i + 1}</div><div><div class="nm" data-pid="${r.p.player_id}">${esc(r.p.first_name)} ${esc(r.p.last_name)} <span class="muted small">${esc(r.p.team)} · ${playerPositions(r.p).join('/')}</span> ${injTag(r.p)}</div><div class="small"><b>${fmt0(r.V)} FP esperados</b> (${fmt(r.basePG)}/J × ${r.games} JJ) · temporada pasada ${fmt0(r.lastTot)} FP en ${r.gpLast ?? '—'} JJ · ADP ${r.adp != null ? fmt(r.adp, 1) : '—'}</div><div class="why">${r.why.map(esc).join(' · ')}</div></div></div>`;
  $('#recoList').innerHTML = recs.slice(0, 3).map(item).join('') || '<p class="muted">Sin datos suficientes todavía.</p>';
  $('#recoMore').innerHTML = recs.slice(3).map((r, i) => item(r, i + 3)).join('');
  document.querySelectorAll('#recoList .nm, #recoMore .nm').forEach((el) => el.onclick = () => openPlayer(el.dataset.pid));
}
async function loadClaudeLive() {
  try {
    let j;
    try { j = await fetchJSON(`${LIVE_RAW}claude.json?t=${Date.now()}`); }
    catch { j = await fetchJSON(`live/claude.json?t=${Date.now()}`); }
    const el = $('#claudeLive');
    const picks = (j.top3 || []).map((t, i) => `<div class="pick"><b>${i + 1}. ${esc(t.player)}</b>${t.reason ? ` — ${esc(t.reason)}` : ''}</div>`).join('');
    el.innerHTML = `<div class="ts">Actualizado: ${esc(j.updated || '—')}${j.pick ? ` · para el pick #${esc(j.pick)}` : ''}</div>${picks}${j.notes ? `<div>${esc(j.notes)}</div>` : ''}`;
  } catch { /* sin archivo todavía */ }
}

// ---------- render: lesiones ----------
async function renderInjuries() {
  const el = $('#injList'), lg = $('#injLog');
  let rep = null, log = null;
  try { rep = await fetchJSON(`${DATA}injury_report.json?v=${Date.now()}`); } catch (e) { el.innerHTML = `<p class="muted">Sin reporte todavía (${esc(e.message)}).</p>`; return; }
  try { log = await fetchJSON(`${DATA}injury_log.json?v=${Date.now()}`); } catch {}
  $('#injDate').textContent = `· ${rep.today || ''} · generado ${rep.generated_at || ''}`;
  const sevTag = (s) => s ? `<span class="inj ${esc(String(s).replace(/\s/g, ''))}">${esc(s)}</span>` : '<span class="muted small">sano</span>';
  const worse = (rep.changes || []).filter((c) => c.kind === 'peor'), better = (rep.changes || []).filter((c) => c.kind === 'mejor');
  const pl = (c) => S.players[c.pid] ? nameCell(S.players[c.pid]) : esc(c.name);
  let html = '';
  if (!rep.changes?.length) html += '<p class="muted">Sin cambios de lesión relevantes desde el último reporte.</p>';
  if (worse.length) {
    html += '<h3>Nuevas o agravadas</h3>' + worse.map((c) => `<div class="item" style="display:block;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px">
      <div><b>${pl(c)}</b> <span class="muted">${esc(c.team)} · ${(c.pos || []).filter(Boolean).join('/')}</span> · ${sevTag(c.from)} → ${sevTag(c.to)} ${c.part ? '· ' + esc(c.part) : ''} ${c.return ? '· regreso est. ' + esc(c.return) : ''} · <span class="small ${c.owner ? 'muted' : ''}" style="${c.owner ? '' : 'color:var(--good)'}">${c.owner ? 'de ' + esc(c.owner) : 'LIBRE'}</span></div>
      ${c.detail ? `<div class="small muted">${esc(c.detail)}</div>` : ''}
      ${(c.beneficiaries || []).length ? `<table class="tbl mini" style="margin-top:6px"><thead><tr><th>Se beneficia</th><th>Pos</th><th>Depth</th><th>Dueño</th><th class="num">Techo top5</th><th class="num">P90</th><th class="num">Proy/J</th><th>Últimos juegos (FP, min)</th></tr></thead><tbody>${c.beneficiaries.map((m) => `<tr><td>${S.players[m.pid] ? nameCell(S.players[m.pid]) : esc(m.name)}</td><td>${(m.pos || []).join('/')}</td><td>${esc((m.depth || []).join(''))}</td><td style="${m.free ? 'color:var(--good)' : ''}">${m.free ? 'LIBRE' : esc(m.owner || '')}</td><td class="num">${m.top5 ?? '—'}</td><td class="num">${m.p90 ?? '—'}</td><td class="num">${m.proj ?? '—'}</td><td class="small">${(m.recent || []).map((r) => `${r.fp} (${r.min}m)`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>`).join('');
  }
  if (better.length) html += '<h3>Mejoran o regresan</h3>' + better.map((c) => `<div class="small" style="padding:4px 0">${pl(c)} <span class="muted">${esc(c.team)}</span> · ${sevTag(c.from)} → ${sevTag(c.to)} · ${c.owner ? 'de ' + esc(c.owner) : '<span style="color:var(--good)">LIBRE</span>'}</div>`).join('');
  el.innerHTML = html; bindNames(el);
  if (log) lg.innerHTML = Object.keys(log).sort().reverse().slice(0, 7).map((k) => `<div style="margin-bottom:6px"><b>${esc(k)}</b>: ${(log[k] || []).map((c) => `${esc(c.name)} (${esc(c.team)}) ${esc(c.from || 'sano')}→${esc(c.to || 'sano')}`).join(' · ') || 'sin cambios'}</div>`).join('');
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
    <div class="k">Titulares</div><div>${startingSlots().length} · Banca ${counts.BN || 0} · IR ${lg.settings?.reserve_slots ?? counts.IR ?? 0}</div>
    <div class="k">Alineaciones</div><div>${lg.settings?.daily_waivers ? 'diarias' : 'semanales'}${lg.settings?.bench_lock ? ' · banca se bloquea al iniciar cada juego' : ''}${lg.settings?.league_average_match ? ' · además juegas contra el promedio de la liga' : ''}</div>
    <div class="k">Keepers</div><div>${lg.settings?.max_keepers ? `hasta ${lg.settings.max_keepers}` : 'no'} · deadline de cambios semana ${lg.settings?.trade_deadline ?? '—'}</div>
    <div class="k">Draft</div><div>${esc(typeLbl || '—')} · ${d.settings?.rounds || '—'} rondas · ${d.settings?.pick_timer ? d.settings.pick_timer + ' s por pick' : 'sin reloj'}${d.settings?.reversal_round ? ` · inversión en ronda ${d.settings.reversal_round}` : ''}</div>
    <div class="k">Inicio</div><div>${d.start_time ? new Date(d.start_time).toLocaleString() : '—'}</div>
    <div class="k">Mi posición</div><div>#${S.mySlot ?? '?'}</div>
    <div class="k">Formato</div><div>${esc(lg.settings?.type === 2 ? 'Dinastía/Keeper' : lg.settings?.type === 1 ? 'Keeper' : 'Redraft')} · playoffs ${lg.settings?.playoff_teams || '—'} equipos · semana ${lg.settings?.playoff_week_start || '—'}</div>
    <div class="k">Waivers</div><div>${esc(String(lg.settings?.waiver_type ?? '—'))} · presupuesto ${lg.settings?.waiver_budget ?? '—'}</div>
    <div class="k">Scoring</div><div>${esc(lg.scoring_type || d.metadata?.scoring_type || 'points')} · liga de puntos${d.settings?.enforce_position_limits ? ' · Sleeper exige que cada pick quepa en un slot' : ''}${d.settings?.cpu_autopick ? ' · autopick si se acaba el reloj' : ''}</div>
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
function depthChartHTML(p) {
  if (!p.team) return '<span class="muted small">Sin equipo.</span>';
  const picked = pickedIds();
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
    const own = picked.has(q.player_id) ? `<span class="muted small">· ${esc(rosterUser(S.picks.find((x) => x.player_id === q.player_id).roster_id))}</span>` : '<span class="small" style="color:var(--good)">· libre</span>';
    return `<td class="${q.player_id === p.player_id ? 'me' : ''}">${nameCell(q)} ${injTag(q)}<div class="small muted">${fmt(pv.basePG)} FP/J${st?.gp ? ` · ${fmt0(st.gp)} JJ` : ''} ${own}</div></td>`;
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
    return `<div class="statline"><div class="s"><b>${perGame ? pv.games : fmt0(s.gp)}</b><span>${perGame ? 'JJ esp.' : 'JJ'}</span></div><div class="s"><b>${fmt(fppg)}</b><span>FP/J</span></div><div class="s"><b>${fmt0(perGame ? fppg * pv.games : fantasyPoints(s))}</b><span>${perGame ? 'FP esperados' : 'FP total'}</span></div></div>`;
  };
  const picked = S.picks.find((x) => x.player_id === pid);
  box.innerHTML = `
    <div class="phead"><img src="${img}" onerror="this.style.display='none'" alt=""><div>
      <h2>${esc(p.first_name)} ${esc(p.last_name)} <span class="muted">#${esc(p.number ?? '')}</span></h2>
      <div>${posTags(p)} <b>${esc(p.team || 'Sin equipo')}</b> · ${p.age ? p.age + ' años' : ''} · ${p.years_exp != null ? (p.years_exp === 0 ? 'novato' : p.years_exp + ' temporadas') : ''} ${p.height ? '· ' + esc(p.height) : ''} ${p.college ? '· ' + esc(p.college) : ''}</div>
      ${inj}
      ${picked ? `<div class="small">Draftеado por <b>${esc(rosterUser(picked.roster_id))}</b> (pick #${picked.pick_no})</div>` : `<div class="small" style="color:var(--good)">Disponible · ADP Sleeper ${pv.adp != null ? fmt(pv.adp, 1) : '—'}</div>`}
    </div></div>
    ${pr ? `<div class="pbox"><h3>Proyección ${S.projSeason || ''}-${String(Number(S.projSeason) + 1).slice(2)} por juego (puntos de esta liga)</h3>${sline(pr, 'proyección', true)}</div>` : ''}
    <div class="pbox" style="margin-top:10px"><h3>Temporada pasada ${S.statsSeason || ''}-${String(Number(S.statsSeason) + 1).slice(2)} (promedios por juego, puntos de esta liga)</h3>${sline(st, 'stats del año pasado', false)}</div>
    <div class="pbox" style="margin-top:10px"><h3 id="pBestTitle">Mejores 5 juegos ${S.statsSeason || ''}-${String(Number(S.statsSeason) + 1).slice(2)} (puntos de esta liga)</h3><div id="pBest" class="loading">Cargando…</div></div>
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
    if (gs && games?.length) { const yr = Number(gs) - 1; $('#pBestTitle').textContent = `Mejores 5 juegos ${yr}-${String(yr + 1).slice(2)}${String(yr + 1) !== String(Number(S.statsSeason) + 1) ? ' (su última temporada con juegos)' : ''} (puntos de esta liga)`; }
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
      <div class="small muted" style="margin-top:6px">${rows.length} juegos registrados · promedio ${fmt(avg)} FP · top 5 promedio ${fmt(top.reduce((a, r) => a + r.fp, 0) / top.length)} FP · juegos de 50+ FP: ${over(50)} · 40+: ${over(40)} · menos de 20: ${rows.filter((r) => r.fp < 20).length}</div>`;
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
    const hint = /conectar|fetch/i.test(e.message) ? ' · Revisa tu conexión o prueba en otro navegador (Chrome/Safari normal, no una vista dentro de otra app).' : '';
    $('#leagueName').innerHTML = `<span class="err">${esc(e.message)}${esc(hint)}</span>`;
    $('#setup').classList.remove('hidden');
    const d = document.querySelector('#setup .diag'); if (d) d.open = true;
  }
}

// ---------- UI ----------
document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'players') renderPlayersTable();
  if (b.dataset.tab === 'picks') { renderReco(); loadClaudeLive(); }
  if (b.dataset.tab === 'injuries') renderInjuries();
});
$('#setupBtn').onclick = () => $('#setup').classList.toggle('hidden');
$('#applySetup').onclick = () => { S.cfg = { user: $('#inUser').value.trim(), league: $('#inLeague').value.trim(), season: $('#inSeason').value.trim(), poll: Number($('#inPoll').value) || 15 }; lsSet('draft_cfg', S.cfg); boot(); };
$('#refreshBtn').onclick = () => { S.lastPickCount = -1; refresh(); };
$('#availSearch').oninput = renderAvail; $('#availSort').onchange = () => { const v = $('#availSort').value; S.sortAvail = v === 'proj' ? { key: 'V', dir: -1 } : v === 'last' ? { key: 'lastTot', dir: -1 } : v === 'adp' ? { key: 'adp', dir: 1 } : { key: 'rec', dir: -1 }; renderAvail(); };
$('#plSearch').oninput = renderPlayersTable; $('#plOnlyAvail').onchange = renderPlayersTable; $('#plPerGame').onchange = renderPlayersTable;
$('#modalClose').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').classList.add('hidden'); });
$('#manualNote').value = lsGet('manual_note') || '';
$('#manualNote').oninput = () => lsSet('manual_note', $('#manualNote').value);

boot();
