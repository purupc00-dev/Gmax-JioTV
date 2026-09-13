/**
 * Gmax-JioTV — EPG Timeline Guide
 * Loads channels from localStorage servers_map (or S11 M3U)
 * Loads XMLTV EPG and maps by tvg-id
 */

"use strict";

const CONFIG = {
  // Same gateway as main — private repo + real EPG sources stay hidden.
  // Every source is proxied through this one domain, distinguished only
  // by ?src=, so real EPG hosts never show up in Network tab.
  GATEWAY_BASE: "https://playlist.gmaxhub.workers.dev",
  CHANNELS_ENDPOINT: "/channels",
  EPG_ENDPOINT: "/epg",
  EPG_SOURCES: [
    // Baseline/broad coverage first — unverified quality, only used to
    // fill gaps for channels nothing else covers
    "aio", "tsepg1", "tsepg2", "klivjio", "klivairtel", "klivfiltered", "iptvepgorg", "rbgy",
    // Trusted, richer 2-day+catchup guides go LAST so they always win over
    // the baseline sources above for any channel id both happen to cover
    "jiotv", "tataplay",
  ],
  SERVERS_MAP_KEY: "gmax_servers_map",
  FAVORITES_KEY: "gmax-jiotv-favorites",

  PX_PER_HOUR: window.innerWidth < 700 ? 140 : 180,
  HOURS_BEFORE: 6,  // more room to scroll back and see past programmes
  HOURS_AFTER: 10,
};

/* ---------- state ---------- */
let channels = []; // { id, name, logo, group, language, tvgId }
let programmesByChannel = new Map(); // tvgId → [{ start, stop, title, desc }]
let dayOffset = 0; // 0 = today
let filterCategory = "all";
let filterLanguage = "all";
let filterFavOnly = false;
let searchQuery = "";
let favorites = new Set(JSON.parse(localStorage.getItem(CONFIG.FAVORITES_KEY) || "[]"));
let viewStart = null; // Date
let viewEnd = null;

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s*\|\s*gmaxhub\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name) {
  return normalizeName(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ch";
}

function inferLanguage(name, group) {
  const n = (name + " " + group).toLowerCase();
  if (/\b(hindi|star plus|colors|zee tv|sony sab)\b/.test(n)) return "Hindi";
  if (/\b(english|movies now|hbo|axn|star movies)\b/.test(n)) return "English";
  if (/\b(tamil|sun tv|zee tamil)\b/.test(n)) return "Tamil";
  if (/\b(telugu|gemini|zee telugu)\b/.test(n)) return "Telugu";
  if (/\b(malayalam|asianet)\b/.test(n)) return "Malayalam";
  if (/\b(kannada|udaya|zee kannada)\b/.test(n)) return "Kannada";
  if (/\b(bengali|zee bangla)\b/.test(n)) return "Bengali";
  if (/\b(marathi|zee marathi)\b/.test(n)) return "Marathi";
  return "Other";
}

function parseXmltvDate(s) {
  // 20260913120000 +0530  or 20260913120000
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  // Treat as local time (browser) — good enough for guide display
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function formatTime(d) {
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

// Tries every tvg-id this channel is known by (across all its playlist
// sources) against the merged EPG map, since different source playlists
// (S6/S7/S10/Pocket TV/etc.) can carry different id schemes for the
// same logical channel.
function getProgrammesFor(ch) {
  const candidates = ch.altTvgIds && ch.altTvgIds.length ? ch.altTvgIds : [String(ch.tvgId)];
  for (const id of candidates) {
    const list = programmesByChannel.get(id);
    if (list && list.length) return list;
  }
  return [];
}

/* ---------- M3U (fallback if no servers_map) ---------- */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const comma = line.lastIndexOf(",");
      const attrsStr = comma >= 0 ? line.slice(8, comma) : line.slice(8);
      const display = comma >= 0 ? line.slice(comma + 1).trim() : "";
      const attrs = {};
      const re = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(attrsStr))) attrs[m[1]] = m[2];
      cur = {
        tvgId: attrs["tvg-id"] || "",
        name: (attrs["tvg-name"] || display || "Unknown").replace(/\s*\|\s*GmaxHub\s*$/i, "").trim(),
        logo: attrs["tvg-logo"] || "",
        group: attrs["group-title"] || "Other",
      };
    } else if (cur && line && !line.startsWith("#")) {
      const id = cur.tvgId || slugify(cur.name);
      out.push({
        id,
        tvgId: cur.tvgId || id,
        name: cur.name,
        logo: cur.logo,
        group: cur.group,
        language: inferLanguage(cur.name, cur.group),
      });
      cur = null;
    }
  }
  return out;
}

async function loadChannels() {
  // Prefer servers_map from main page (has same ids)
  try {
    const raw = localStorage.getItem(CONFIG.SERVERS_MAP_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      const list = Object.values(map).map((ch) => ({
        id: ch.id,
        tvgId: String(ch.id), // M3U tvg-id is usually the numeric id
        altTvgIds: collectAltTvgIds(ch),
        name: ch.name,
        logo: ch.logo || "",
        group: ch.group || "Other",
        language: inferLanguage(ch.name, ch.group),
      }));
      if (list.length) return list;
    }
  } catch (_) {}

  // Fallback: single aggregated call, same endpoint main.js uses
  const res = await fetch(CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT, { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load channels");
  const { channels } = await res.json();
  return (channels || []).map((ch) => ({
    id: ch.id,
    tvgId: String(ch.id),
    altTvgIds: collectAltTvgIds(ch),
    name: ch.name,
    logo: ch.logo || "",
    group: ch.group || "Other",
    language: ch.language || inferLanguage(ch.name, ch.group),
  }));
}

// A channel can carry different tvg-ids across its servers/playlists
// (e.g. S6/S7/S10/Pocket TV vs S11) — collect every distinct one so
// programme lookup can try them all against whichever EPG source
// actually covers that particular id scheme.
function collectAltTvgIds(ch) {
  const ids = new Set();
  if (ch.id != null) ids.add(String(ch.id));
  (ch.servers || []).forEach((s) => {
    if (s && s.tvgId) ids.add(String(s.tvgId));
  });
  return [...ids];
}

/* ---------- EPG fetch + parse ---------- */
async function fetchGzipText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`EPG HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  // Some sources are gzip (.xml.gz), others are plain XML with no such
  // extension — don't trust the URL or Content-Type, check the actual
  // bytes. A gzip stream always starts with the magic bytes 1F 8B.
  const bytes = new Uint8Array(buf);
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

  if (isGzip && typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Response(buf).body.pipeThrough(ds);
    return await new Response(stream).text();
  }
  // Plain text (or no DecompressionStream support) — decode as-is
  return new TextDecoder("utf-8").decode(buf);
}

function parseXmltv(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const map = new Map();

  const progs = doc.querySelectorAll("programme");
  progs.forEach((p) => {
    const channel = p.getAttribute("channel");
    if (!channel) return;
    const start = parseXmltvDate(p.getAttribute("start"));
    const stop = parseXmltvDate(p.getAttribute("stop"));
    if (!start || !stop) return;
    const titleEl = p.querySelector("title");
    const descEl = p.querySelector("desc");
    const title = titleEl ? titleEl.textContent.trim() : "Programme";
    const desc = descEl ? descEl.textContent.trim() : "";

    if (!map.has(channel)) map.set(channel, []);
    map.get(channel).push({ start, stop, title, desc });
  });

  // sort each channel
  for (const [, list] of map) {
    list.sort((a, b) => a.start - b.start);
  }
  return map;
}

async function loadEpg() {
  // Fetch every source in parallel — all through our own Worker (/epg?src=...)
  // so no real EPG host ever appears in Network tab. A failure on one
  // source doesn't block the others.
  const results = await Promise.all(
    CONFIG.EPG_SOURCES.map(async (src) => {
      try {
        const text = await fetchGzipText(`${CONFIG.GATEWAY_BASE}${CONFIG.EPG_ENDPOINT}?src=${src}`);
        return { src, ok: true, map: parseXmltv(text) };
      } catch (err) {
        return { src, ok: false, error: err.message };
      }
    })
  );

  // Merge in CONFIG.EPG_SOURCES order: broad/unverified sources fill in
  // first as a baseline, then the trusted JioTV/TataPlay catchup guides
  // (listed last) overwrite them for any channel id both cover.
  const merged = new Map();
  let succeeded = 0;
  for (const r of results) {
    if (!r.ok) {
      console.warn(`[EPG] source '${r.src}' failed:`, r.error);
      continue;
    }
    succeeded++;
    for (const [channelId, programmes] of r.map) {
      merged.set(channelId, programmes); // later source in the list wins for that channel id
    }
  }

  if (succeeded === 0 || merged.size === 0) {
    throw new Error("No EPG source available");
  }
  console.log(`[EPG] Loaded ${merged.size} channels across ${succeeded}/${CONFIG.EPG_SOURCES.length} source(s)`);
  return merged;
}

/* ---------- view window ---------- */
function computeViewWindow() {
  const now = new Date();
  if (dayOffset === 0) {
    viewStart = new Date(now);
    viewStart.setMinutes(0, 0, 0);
    viewStart.setHours(viewStart.getHours() - CONFIG.HOURS_BEFORE);
    viewEnd = new Date(viewStart);
    viewEnd.setHours(viewEnd.getHours() + CONFIG.HOURS_BEFORE + CONFIG.HOURS_AFTER);
  } else {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    viewStart = d;
    viewEnd = new Date(d);
    viewEnd.setHours(24);
  }
}

function pxForTime(date) {
  const ms = date - viewStart;
  return (ms / 3600000) * CONFIG.PX_PER_HOUR;
}

function widthForRange(start, stop) {
  const ms = Math.max(0, stop - start);
  return Math.max(40, (ms / 3600000) * CONFIG.PX_PER_HOUR - 4);
}

/* ---------- filters ---------- */
function getVisibleChannels() {
  return channels.filter((ch) => {
    if (filterFavOnly && !favorites.has(String(ch.id))) return false;
    if (filterCategory !== "all") {
      const g = (ch.group || "").toLowerCase();
      if (!g.includes(filterCategory.toLowerCase())) return false;
    }
    if (filterLanguage !== "all" && ch.language !== filterLanguage) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const hay = (ch.name + " " + ch.group).toLowerCase();
      // also match programme titles in window
      const progs = getProgrammesFor(ch);
      const hitProg = progs.some(
        (p) => p.start < viewEnd && p.stop > viewStart && p.title.toLowerCase().includes(q)
      );
      if (!hay.includes(q) && !hitProg) return false;
    }
    return true;
  });
}

/* ---------- render ---------- */
function renderTimeHeader() {
  const el = $("#epg-time-header");
  el.innerHTML = "";
  const totalHours = Math.ceil((viewEnd - viewStart) / 3600000);
  for (let i = 0; i < totalHours; i++) {
    const t = new Date(viewStart);
    t.setHours(t.getHours() + i);
    const tick = document.createElement("div");
    tick.className = "epg-hour-tick";
    tick.style.flex = `0 0 ${CONFIG.PX_PER_HOUR}px`;
    tick.style.width = `${CONFIG.PX_PER_HOUR}px`;
    tick.textContent = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.appendChild(tick);
  }
}

function renderGrid() {
  const visible = getVisibleChannels();
  const chCol = $("#epg-channel-col");
  const progCol = $("#epg-programmes");
  chCol.innerHTML = "";
  progCol.innerHTML = "";

  $("#epg-date-label").textContent = formatDateLabel(dayOffset);
  $("#epg-status").textContent = `${visible.length} channels · EPG ready`;

  if (!visible.length) {
    $("#epg-empty").classList.remove("hidden");
    return;
  }
  $("#epg-empty").classList.add("hidden");

  const totalWidth = Math.ceil((viewEnd - viewStart) / 3600000) * CONFIG.PX_PER_HOUR;
  progCol.style.width = totalWidth + "px";

  const now = new Date();
  const nowX = pxForTime(now);

  visible.forEach((ch) => {
    // left column
    const row = document.createElement("div");
    row.className = "epg-channel-row";
    row.title = "Play " + ch.name;
    const logoHtml = ch.logo
      ? `<img class="epg-ch-logo" src="${escapeHtml(ch.logo)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">`
      : "";
    const fb = `<div class="epg-ch-fallback" style="${ch.logo ? "display:none" : ""}">${escapeHtml(
      (ch.name || "?").slice(0, 2).toUpperCase()
    )}</div>`;
    row.innerHTML = `${logoHtml}${fb}<div class="epg-ch-name">${escapeHtml(ch.name)}</div>`;
    row.addEventListener("click", () => {
      window.location.href = `./player.html?id=${encodeURIComponent(ch.id)}`;
    });
    chCol.appendChild(row);

    // programmes row
    const progRow = document.createElement("div");
    progRow.className = "epg-prog-row";
    progRow.style.width = totalWidth + "px";

    const list = getProgrammesFor(ch);
    list.forEach((p) => {
      if (p.stop <= viewStart || p.start >= viewEnd) return;
      const left = Math.max(0, pxForTime(p.start));
      const right = Math.min(totalWidth, pxForTime(p.stop));
      const w = Math.max(36, right - left - 3);

      const block = document.createElement("div");
      const isLive = p.start <= now && p.stop > now;
      const isPast = p.stop <= now;
      block.className = "epg-prog-block " + (isLive ? "live" : isPast ? "past" : "upcoming");
      block.style.left = left + "px";
      block.style.width = w + "px";
      block.title = `${p.title}\n${formatTime(p.start)} – ${formatTime(p.stop)}${p.desc ? "\n" + p.desc : ""}`;
      block.innerHTML = `
        <div class="epg-prog-title">${escapeHtml(p.title)}</div>
        <div class="epg-prog-time">${formatTime(p.start)} – ${formatTime(p.stop)}</div>
      `;
      block.addEventListener("click", (e) => {
        e.stopPropagation();
        window.location.href = `./player.html?id=${encodeURIComponent(ch.id)}`;
      });
      progRow.appendChild(block);
    });

    // now marker only for today
    if (dayOffset === 0 && nowX >= 0 && nowX <= totalWidth) {
      const marker = document.createElement("div");
      marker.className = "epg-now-marker";
      marker.style.left = nowX + "px";
      progRow.appendChild(marker);
    }

    progCol.appendChild(progRow);
  });

  // scroll so "now" is visible
  if (dayOffset === 0) {
    const wrap = $("#epg-grid-wrap");
    requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, nowX - 120);
    });
  }
}

function fillFilterDropdowns() {
  const cats = new Set();
  const langs = new Set();
  channels.forEach((c) => {
    if (c.group) cats.add(c.group);
    if (c.language) langs.add(c.language);
  });

  const catSel = $("#epg-category");
  const langSel = $("#epg-language");
  [...cats].sort().forEach((c) => {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    catSel.appendChild(o);
  });
  [...langs].sort().forEach((l) => {
    const o = document.createElement("option");
    o.value = l;
    o.textContent = l;
    langSel.appendChild(o);
  });
}

function refresh() {
  computeViewWindow();
  renderTimeHeader();
  renderGrid();
}

/* ---------- events ---------- */
function bindEvents() {
  $("#btn-now").addEventListener("click", () => {
    dayOffset = 0;
    $$(".epg-tool-btn").forEach((b) => b.classList.remove("active"));
    $("#btn-now").classList.add("active");
    refresh();
  });
  $("#btn-prev-day").addEventListener("click", () => {
    dayOffset -= 1;
    $("#btn-now").classList.toggle("active", dayOffset === 0);
    refresh();
  });
  $("#btn-next-day").addEventListener("click", () => {
    dayOffset += 1;
    $("#btn-now").classList.toggle("active", dayOffset === 0);
    refresh();
  });

  $("#epg-category").addEventListener("change", (e) => {
    filterCategory = e.target.value;
    refresh();
  });
  $("#epg-language").addEventListener("change", (e) => {
    filterLanguage = e.target.value;
    refresh();
  });
  $("#epg-fav-only").addEventListener("change", (e) => {
    filterFavOnly = e.target.checked;
    refresh();
  });

  let t;
  $("#epg-search").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      searchQuery = e.target.value.trim();
      $("#epg-search-clear").classList.toggle("hidden", !searchQuery);
      refresh();
    }, 160);
  });
  $("#epg-search-clear").addEventListener("click", () => {
    $("#epg-search").value = "";
    searchQuery = "";
    $("#epg-search-clear").classList.add("hidden");
    refresh();
  });
}

function $$(s) {
  return document.querySelectorAll(s);
}

/* ---------- init ---------- */
async function init() {
  bindEvents();
  const loading = $("#epg-loading");
  try {
    channels = await loadChannels();
    // Deduplicate by id for display
    const seen = new Set();
    channels = channels.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    fillFilterDropdowns();
    $("#epg-status").textContent = "Loading EPG data…";

    programmesByChannel = await loadEpg();

    // Match rate log
    let matched = 0;
    channels.forEach((c) => {
      if (getProgrammesFor(c).length) matched++;
    });
    console.log(`[EPG] ${matched}/${channels.length} channels have programme data`);

    loading.classList.add("hidden");
    refresh();
  } catch (err) {
    console.error(err);
    loading.innerHTML = `
      <div class="error-box">
        <p>Could not load EPG.</p>
        <p class="error-detail">${escapeHtml(err.message)}</p>
        <p style="font-size:12px;margin-top:8px">Channels still load — programme blocks need a reachable XMLTV source.</p>
        <button type="button" class="btn-primary" onclick="location.reload()">Retry</button>
      </div>
    `;
    // Still show channel list with empty programmes
    try {
      if (!channels.length) channels = await loadChannels();
      fillFilterDropdowns();
      programmesByChannel = new Map();
      loading.classList.add("hidden");
      refresh();
    } catch (_) {}
  }
}

init();
