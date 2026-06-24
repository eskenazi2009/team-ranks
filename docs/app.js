"use strict";

const state = {
  meta: null,
  categories: [],
  period: "season",
  view: "teams",
  data: { season: null, last7: null }, // teams arrays keyed by period
  byId: {},                            // current period: id -> team
  modalTeamId: null,
  compareTeamId: null,
  sort: { key: null, dir: 1 },         // league table sort
};

const $ = (sel) => document.querySelector(sel);

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Rank -> bar fill fraction (rank 1 = full, 30 = nearly empty).
function fillPct(rank, total = 30) {
  return Math.max(4, ((total + 1 - rank) / total) * 100);
}

// Lighten very dark team colors so bars stay visible on the dark track.
function barColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "var(--accent)";
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.35) {
    const f = 0.55; // blend toward white
    r = Math.round(r + (255 - r) * f);
    g = Math.round(g + (255 - g) * f);
    b = Math.round(b + (255 - b) * f);
  }
  return `rgb(${r},${g},${b})`;
}

async function loadJSON(path) {
  // Cache-bust with a unique query string: GitHub Pages' CDN caches by full URL
  // (max-age 600), and `cache: no-store` only covers the browser cache. A unique
  // param forces a fresh fetch past the CDN as soon as Pages redeploys.
  const res = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function init() {
  try {
    state.meta = await loadJSON("data/meta.json");
    state.categories = state.meta.categories;
    state.data.season = (await loadJSON("data/season.json")).teams;
    state.data.last7 = (await loadJSON("data/last7.json")).teams;
  } catch (err) {
    $("#subtitle").textContent = "Could not load data. Run the scraper first.";
    console.error(err);
    return;
  }
  const dt = new Date(state.meta.updated);
  const when = isNaN(dt) ? "unknown" : dt.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  $("#subtitle").textContent =
    `${state.meta.seasonYear} season · last updated ${when} · ranks across all 30 teams`;

  wireControls();
  applyPeriod();
}

function wireControls() {
  $("#period-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    setPeriod(b.dataset.period);
  });
  $("#modal-period").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    setPeriod(b.dataset.period);
  });
  $("#view-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    setActive("#view-seg", b);
    state.view = b.dataset.view;
    $("#teams-view").classList.toggle("hidden", state.view !== "teams");
    $("#table-view").classList.toggle("hidden", state.view !== "table");
    $("#search").classList.toggle("hidden", state.view !== "teams");
  });
  $("#search").addEventListener("input", renderGrid);
  $("#close-modal").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // Custom compare dropdown (native <select> can't show logos).
  $("#compare-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#compare-menu").classList.toggle("open");
  });
  document.addEventListener("click", () => $("#compare-menu").classList.remove("open"));
  $("#compare-menu").addEventListener("click", (e) => {
    const item = e.target.closest(".dd-item"); if (!item) return;
    selectCompare(item.dataset.id || null);
    $("#compare-menu").classList.remove("open");
  });
}

function selectCompare(id) {
  state.compareTeamId = id;
  const label = $("#compare-label");
  if (id) {
    const t = state.byId[id];
    label.innerHTML = `<img src="${t.logo}" alt=""><span>${t.shortName}</span>`;
  } else {
    label.textContent = "— none —";
  }
  renderModalBody();
}

function setActive(segSel, btn) {
  document.querySelectorAll(`${segSel} button`).forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
}

// Single source of truth for the period; keeps the page + modal toggles in sync.
function setPeriod(period) {
  state.period = period;
  document.querySelectorAll("#period-seg button, #modal-period button").forEach((b) =>
    b.classList.toggle("active", b.dataset.period === period)
  );
  applyPeriod();
}

function applyPeriod() {
  const teams = state.data[state.period];
  state.byId = {};
  teams.forEach((t) => (state.byId[t.id] = t));
  renderGrid();
  renderTable();
  if (state.modalTeamId) renderModalBody(); // keep modal in sync on period switch
}

/* ---------- Teams grid ---------- */
function renderGrid() {
  const q = $("#search").value.trim().toLowerCase();
  const teams = [...state.data[state.period]]
    .filter((t) => t.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  const grid = $("#team-grid");
  grid.innerHTML = "";
  for (const t of teams) {
    const card = document.createElement("button");
    card.className = "team-card";
    card.style.setProperty("--tc", t.color);
    card.innerHTML = `
      <img src="${t.logo}" alt="" loading="lazy" />
      <span><span class="nm">${t.name}</span><span class="sub">${t.abbr}</span></span>`;
    card.addEventListener("click", () => openModal(t.id));
    grid.appendChild(card);
  }
}

/* ---------- Modal ---------- */
function openModal(id) {
  state.modalTeamId = id;
  state.compareTeamId = null;
  const others = [...state.data[state.period]]
    .filter((t) => t.id !== id)
    .sort((a, b) => a.shortName.localeCompare(b.shortName));
  $("#compare-menu").innerHTML =
    `<div class="dd-item" data-id="">— none —</div>` +
    others.map((t) =>
      `<div class="dd-item" data-id="${t.id}"><img src="${t.logo}" alt="">${t.shortName}</div>`
    ).join("");
  $("#compare-menu").classList.remove("open");
  $("#compare-label").textContent = "— none —";
  document.querySelectorAll("#modal-period button").forEach((b) =>
    b.classList.toggle("active", b.dataset.period === state.period)
  );
  $("#overlay").classList.add("open");
  document.body.style.overflow = "hidden";
  renderModalHead();
  renderModalBody();
}

function closeModal() {
  $("#overlay").classList.remove("open");
  document.body.style.overflow = "";
  state.modalTeamId = null;
}

function renderModalHead() {
  const t = state.byId[state.modalTeamId];
  $("#modal-head").innerHTML =
    `<img src="${t.logo}" alt="" /><h2>${t.name}</h2>`;
}

function teamTag(t) {
  return `<span class="cell-team-tag"><img src="${t.logo}" alt="">${t.abbr}</span>`;
}

function statCell(team, cat) {
  const s = team.stats[cat.key];
  const winner = cell_isWinner(cat, team);
  return `
    <div class="stat-cell">
      <span class="rank-badge ${winner ? "winner" : ""}">${ordinal(s.rank)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${fillPct(s.rank)}%;background:${barColor(team.color)}"></span></span>
      <span class="stat-val">${s.display}</span>
    </div>`;
}

function cell_isWinner(cat, team) {
  if (!state.compareTeamId) return false;
  const a = state.byId[state.modalTeamId], b = state.byId[state.compareTeamId];
  const ra = a.stats[cat.key].rank, rb = b.stats[cat.key].rank;
  if (ra === rb) return false;
  const better = (ra < rb) ? a : b; // lower rank number = better
  return better.id === team.id;
}

function renderModalBody() {
  const a = state.byId[state.modalTeamId];
  const b = state.compareTeamId ? state.byId[state.compareTeamId] : null;
  const body = $("#modal-body");
  let html = "";

  if (b) {
    html += `<div class="stat-row" style="border-bottom:1px solid var(--line);padding-bottom:6px;">
      <span class="stat-label"></span>
      <div class="stat-teams">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="font-size:13px;color:var(--muted)">${teamTag(a)}</div>
          <div style="font-size:13px;color:var(--muted)">${teamTag(b)}</div>
        </div>
      </div></div>`;
  }

  for (const group of ["batting", "pitching"]) {
    html += `<div class="group-title ${group}">${group}</div>`;
    for (const cat of state.categories.filter((c) => c.group === group)) {
      html += `<div class="stat-row"><span class="stat-label">${cat.label}</span><div class="stat-teams">`;
      if (b) {
        html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div>${statCell(a, cat)}</div><div>${statCell(b, cat)}</div></div>`;
      } else {
        html += statCell(a, cat);
      }
      html += `</div></div>`;
    }
  }
  body.innerHTML = html;
}

/* ---------- League table ---------- */
function rankColor(rank, total = 30) {
  // green (1) -> yellow (mid) -> red (30)
  const t = (rank - 1) / (total - 1);
  const hue = (1 - t) * 120; // 120=green, 0=red
  return `hsl(${hue} 60% 38%)`;
}

function renderTable() {
  const table = $("#league-table");
  const cats = state.categories;
  let head = `<thead><tr><th class="team" data-sort="name">Team</th>`;
  for (const c of cats) {
    const cls = state.sort.key === c.key ? "sorted" : "";
    head += `<th class="grp-${c.group} ${cls}" data-sort="${c.key}" title="${c.label}">${c.label}</th>`;
  }
  head += `</tr></thead>`;

  let teams = [...state.data[state.period]];
  const sk = state.sort.key;
  if (sk === "name") {
    teams.sort((a, b) => a.name.localeCompare(b.name) * state.sort.dir);
  } else if (sk) {
    teams.sort((a, b) => (a.stats[sk].rank - b.stats[sk].rank) * state.sort.dir);
  } else {
    teams.sort((a, b) => a.name.localeCompare(b.name));
  }

  let bodyRows = "";
  for (const t of teams) {
    bodyRows += `<tr><td class="team"><img src="${t.logo}" alt="">${t.abbr}</td>`;
    for (const c of cats) {
      const s = t.stats[c.key];
      bodyRows += `<td><span class="cell-val">${s.display}</span><br>
        <span class="rk" style="background:${rankColor(s.rank)}">${s.rank}</span></td>`;
    }
    bodyRows += `</tr>`;
  }
  table.innerHTML = head + `<tbody>${bodyRows}</tbody>`;

  table.querySelectorAll("th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else { state.sort.key = key; state.sort.dir = 1; }
      renderTable();
    });
  });
}

init();
