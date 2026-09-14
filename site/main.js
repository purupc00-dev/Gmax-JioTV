/**
 * Gmax-JioTV — Main Homepage Logic
 * Fetches M3Us → deduplicates → builds server map → renders discovery UI
 */

"use strict";

/* ============================================================
   CONFIG
   ============================================================ */
const CONFIG = {
  // Cloudflare Worker gateway — only this domain + one endpoint appears in Network tab
  GATEWAY_BASE: "https://playlist.gmaxhub.workers.dev",
  CHANNELS_ENDPOINT: "/channels",

  // Static JSON (serve from same origin /site or /data — not from private GitHub)
  HIGHLIGHTS_URL: "highlights.json",
  NOTIFICATIONS_URL: "notifications.json",

  // Local storage keys
  SERVERS_MAP_KEY: "gmax_servers_map",
  FAVORITES_KEY: "gmax-jiotv-favorites",
  MOST_VIEWED_KEY: "gmax_most_viewed",
  NOTIF_READ_KEY: "gmax_notif_read",

  HERO_INTERVAL_MS: 5000,
  CHANNELS_PER_PAGE: 80,
};

/* ============================================================
   STATE
   ============================================================ */
let allChannels = [];          // deduplicated channel objects
let filteredChannels = [];
let activeCategory = "all";
let activeLanguage = "all";
let searchQuery = "";
let visibleCount = CONFIG.CHANNELS_PER_PAGE;
let heroIndex = 0;
let heroTimer = null;
let highlights = [];
let favorites = new Set(JSON.parse(localStorage.getItem(CONFIG.FAVORITES_KEY) || "[]"));
let mostViewed = JSON.parse(localStorage.getItem(CONFIG.MOST_VIEWED_KEY) || "{}"); // { id: count }
let restLoaded = false;  // whether the non-S11 playlists have been fetched yet
let restLoading = false;

/* ============================================================
   DOM REFS
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  searchInput: $("#search-input"),
  searchClear: $("#search-clear"),
  heroTrack: $("#hero-track"),
  heroDots: $("#hero-dots"),
  heroPrev: $("#hero-prev"),
  heroNext: $("#hero-next"),
  mostViewedSection: $("#most-viewed-section"),
  mostViewedTrack: $("#most-viewed-track"),
  mvPrev: $("#mv-prev"),
  mvNext: $("#mv-next"),
  categorySelect: $("#category-select"),
  languageSelect: $("#language-select"),
  clearFilters: $("#clear-filters"),
  resultsCount: $("#results-count"),
  channelsGrid: $("#channels-grid"),
  emptyState: $("#empty-state"),
  loadingState: $("#loading-state"),
  emptyClear: $("#empty-clear"),
  notifBell: $("#notif-bell"),
  notifBadge: $("#notif-badge"),
  notifPanel: $("#notif-panel"),
  notifBody: $("#notif-body"),
  notifClose: $("#notif-close"),
  footerCount: $("#footer-channel-count"),
};

/* ============================================================
   HELPERS
   ============================================================ */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s*\|\s*gmaxhub\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(name) {
  return normalizeName(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "channel";
}

function getLogoFallback(name) {
  const initials = (name || "?")
    .replace(/\|.*$/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || "")
    .join("")
    .toUpperCase();
  return initials || "?";
}

/* ============================================================
   M3U PARSER
   ============================================================ */
function parseM3U(text, sourceLabel = "unknown") {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      // Parse attributes and display name
      const attrPart = line.substring(8);
      const commaIdx = attrPart.lastIndexOf(",");
      const attrsStr = commaIdx >= 0 ? attrPart.slice(0, commaIdx) : attrPart;
      const displayName = commaIdx >= 0 ? attrPart.slice(commaIdx + 1).trim() : "";

      const attrs = {};
      const attrRegex = /([\w-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRegex.exec(attrsStr)) !== null) {
        attrs[m[1]] = m[2];
      }

      current = {
        tvgId: attrs["tvg-id"] || "",
        name: (attrs["tvg-name"] || displayName || "Unknown").replace(/\s*\|\s*GmaxHub\s*$/i, "").trim(),
        logo: attrs["tvg-logo"] || "",
        group: attrs["group-title"] || "Other",
        displayName: displayName || attrs["tvg-name"] || "Unknown",
        source: sourceLabel,
        // DRM / headers collected from following lines
        licenseKey: null,
        cookie: null,
        userAgent: null,
        referrer: null,
        origin: null,
        url: null,
        streamType: "mpd", // default
      };
    } else if (current) {
      if (line.startsWith("#KODIPROP:inputstream.adaptive.license_key=")) {
        current.licenseKey = line.split("=").slice(1).join("=").trim();
      } else if (line.startsWith("#EXTHTTP:")) {
        try {
          const json = JSON.parse(line.slice(9));
          if (json.Cookie) current.cookie = json.Cookie;
        } catch (_) {}
      } else if (line.startsWith("#EXTVLCOPT:http-cookie=")) {
        current.cookie = line.split("=").slice(1).join("=").trim();
      } else if (line.startsWith("#EXTVLCOPT:http-user-agent=")) {
        current.userAgent = line.split("=").slice(1).join("=").trim();
      } else if (line.startsWith("#EXTVLCOPT:http-referrer=")) {
        current.referrer = line.split("=").slice(1).join("=").trim();
      } else if (line.startsWith("#EXTVLCOPT:http-extra-headers=")) {
        const h = line.split("=").slice(1).join("=").trim();
        if (h.toLowerCase().startsWith("origin:")) {
          current.origin = h.slice(7).trim();
        }
      } else if (!line.startsWith("#")) {
        // Stream URL
        current.url = line;
        if (line.includes(".m3u8")) current.streamType = "hls";
        else if (line.includes(".mpd")) current.streamType = "mpd";
        channels.push(current);
        current = null;
      }
    }
  }
  return channels;
}

/* ============================================================
   FETCH + DEDUP ENGINE
   ============================================================ */
async function fetchText(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function loadPrimaryChannels() {
  // Single request: Worker merges Master.json by channel name (all sources).
  const res = await fetch(
    CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} for channels`);
  const { channels } = await res.json();
  return Array.isArray(channels) ? channels : [];
}

function inferLanguage(name, group) {
  const n = (name + " " + group).toLowerCase();
  if (/\b(hindi|star plus|colors|zee tv|sony sab|and tv)\b/.test(n)) return "Hindi";
  if (/\b(english|movies now|hbo|axn|star movies|sony pix)\b/.test(n)) return "English";
  if (/\b(tamil|sun tv|zee tamil|star vijay)\b/.test(n)) return "Tamil";
  if (/\b(telugu|gemini|zee telugu|star maa)\b/.test(n)) return "Telugu";
  if (/\b(malayalam|asianet|surya|zee keralam)\b/.test(n)) return "Malayalam";
  if (/\b(kannada|udaya|zee kannada|star suvarna)\b/.test(n)) return "Kannada";
  if (/\b(bengali|zee bangla|star jalsha)\b/.test(n)) return "Bengali";
  if (/\b(marathi|zee marathi|colors marathi|star pravah)\b/.test(n)) return "Marathi";
  if (/\b(punjabi|ptc|zee punjabi)\b/.test(n)) return "Punjabi";
  if (/\b(gujarati|colors gujarati|zee gujarati)\b/.test(n)) return "Gujarati";
  if (group && /sports|news|movies|kids|music|lifestyle|infotainment/i.test(group)) return "Multi";
  return "Other";
}

/* ============================================================
   CATEGORIES & LANGUAGES
   ============================================================ */
// Different playlists format the same real category very differently, e.g.
// group-title="JioTV+ ▶ | English" is really just "English". Strip decorative
// branding/emoji and keep the last meaningful segment after common
// separators, so these collapse into the same category instead of each
// playlist's noisy label becoming its own separate, useless entry.
function normalizeCategoryLabel(raw) {
  if (!raw) return "Other";
  let s = String(raw).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "").trim();
  const parts = s.split(/[|›»▶:]+/).map((p) => p.trim()).filter(Boolean);
  const label = (parts.length ? parts[parts.length - 1] : s).replace(/\s+/g, " ").trim();
  return label || "Other";
}

// A channel can carry a different category label per playlist source (its
// primary S11 entry, plus whatever every other playlist called it). Collect
// every one of them — normalized — instead of only the single label that
// happened to "win" the channel-identity merge, so categories that only
// exist in secondary playlists (S1-S13 variants, Sports, FreeDish, etc.)
// still show up in the filter instead of being silently discarded.
function getChannelCategories(ch) {
  const set = new Set();
  set.add(normalizeCategoryLabel(ch.group));
  (ch.servers || []).forEach((s) => {
    if (s && s.group) set.add(normalizeCategoryLabel(s.group));
  });
  return [...set];
}

function getUniqueLanguages(channels) {
  const set = new Set();
  channels.forEach((c) => set.add(c.language || "Other"));
  return ["all", ...Array.from(set).sort()];
}

// Real categories straight from your playlists' group-title values —
// normalized + deduplicated case-insensitively (so "English"/"ENGLISH"/
// "JioTV+ ▶ | English" across different m3u files collapse into one entry)
// instead of a fixed guess-list, and pulled from EVERY server a channel
// has, not just whichever source's name won the merge.
function getUniqueCategories(channels) {
  const seen = new Map(); // lowercase key -> { label, count }
  channels.forEach((c) => {
    getChannelCategories(c).forEach((label) => {
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, { key, label, count: 0 });
      seen.get(key).count++;
    });
  });
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ============================================================
   FILTERS + RENDER
   ============================================================ */
function computeFilteredChannels() {
  const q = searchQuery.toLowerCase().trim();
  return allChannels.filter((ch) => {
    if (activeCategory !== "all") {
      const cats = getChannelCategories(ch).map((l) => l.toLowerCase());
      if (!cats.includes(activeCategory)) return false;
    }
    if (activeLanguage !== "all" && ch.language !== activeLanguage) return false;
    if (q) {
      const hay = (ch.name + " " + ch.group + " " + (ch.language || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function applyFilters() {
  filteredChannels = computeFilteredChannels();
  visibleCount = CONFIG.CHANNELS_PER_PAGE;
  renderChannels();
  updateResultsMeta();
  updateClearFiltersVisibility();
}

function updateResultsMeta() {
  const total = filteredChannels.length;
  const shown = Math.min(visibleCount, total);
  els.resultsCount.textContent =
    total === 0
      ? "No channels match"
      : shown < total
      ? `Showing ${shown} of ${total} channels`
      : `${total} channel${total === 1 ? "" : "s"}`;
  els.footerCount.textContent = `${allChannels.length} channels`;
}

function updateClearFiltersVisibility() {
  const hasFilter =
    activeCategory !== "all" || activeLanguage !== "all" || searchQuery.trim() !== "";
  els.clearFilters.classList.toggle("hidden", !hasFilter);
}

function renderCategorySelect() {
  const cats = getUniqueCategories(allChannels);
  const total = allChannels.length;
  els.categorySelect.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = `All Categories (${total})`;
  if (activeCategory === "all") allOpt.selected = true;
  els.categorySelect.appendChild(allOpt);

  cats.forEach(({ key, label, count }) => {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = `${label} (${count})`;
    if (key === activeCategory) opt.selected = true;
    els.categorySelect.appendChild(opt);
  });
}

function renderLanguageSelect() {
  const langs = getUniqueLanguages(allChannels);
  els.languageSelect.innerHTML = "";
  langs.forEach((lang) => {
    const opt = document.createElement("option");
    opt.value = lang;
    opt.textContent = lang === "all" ? "All Languages" : lang;
    if (lang === activeLanguage) opt.selected = true;
    els.languageSelect.appendChild(opt);
  });
}

function createChannelCard(ch) {
  const isFav = favorites.has(String(ch.id));
  const card = document.createElement("article");
  card.className = "channel-card";
  card.setAttribute("role", "listitem");
  card.dataset.id = ch.id;

  const logoHtml = ch.logo
    ? `<img src="${escapeHtml(ch.logo)}" alt="" class="channel-logo" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    : "";
  const fallback = `<div class="channel-fallback" style="${ch.logo ? "display:none" : ""}">${escapeHtml(getLogoFallback(ch.name))}</div>`;

  card.innerHTML = `
    <button type="button" class="fav-btn ${isFav ? "active" : ""}" data-id="${escapeHtml(ch.id)}" aria-label="Toggle favorite">
      ${isFav ? "♥" : "♡"}
    </button>
    <div class="channel-logo-wrap">
      ${logoHtml}
      ${fallback}
    </div>
    <div class="channel-info">
      <div class="channel-name">${escapeHtml(ch.name)}</div>
      <div class="channel-meta">
        <span class="channel-group">${escapeHtml(ch.group)}</span>
      </div>
    </div>
  `;

  // Click card → player
  card.addEventListener("click", (e) => {
    if (e.target.closest(".fav-btn")) return;
    trackView(ch.id);
    window.location.href = `./player.html?id=${encodeURIComponent(ch.id)}`;
  });

  // Favorite toggle
  card.querySelector(".fav-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(ch.id);
    const btn = e.currentTarget;
    const nowFav = favorites.has(String(ch.id));
    btn.classList.toggle("active", nowFav);
    btn.textContent = nowFav ? "♥" : "♡";
  });

  return card;
}

function renderChannels() {
  const slice = filteredChannels.slice(0, visibleCount);
  els.channelsGrid.innerHTML = "";
  els.loadingState.classList.add("hidden");

  if (slice.length === 0) {
    els.emptyState.classList.remove("hidden");
    els.channelsGrid.classList.add("hidden");
    return;
  }

  els.emptyState.classList.add("hidden");
  els.channelsGrid.classList.remove("hidden");

  const frag = document.createDocumentFragment();
  slice.forEach((ch) => frag.appendChild(createChannelCard(ch)));
  els.channelsGrid.appendChild(frag);

  // Infinite scroll sentinel
  if (visibleCount < filteredChannels.length) {
    const sentinel = document.createElement("div");
    sentinel.id = "scroll-sentinel";
    sentinel.style.height = "1px";
    els.channelsGrid.appendChild(sentinel);

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          visibleCount += CONFIG.CHANNELS_PER_PAGE;
          obs.disconnect();
          renderChannels();
          updateResultsMeta();
        }
      },
      { rootMargin: "200px" }
    );
    obs.observe(sentinel);
  } else if (!restLoaded && !restLoading) {
    // User has scrolled through everything currently loaded (S11 on first
    // visit). Now — and only now — fetch the rest of the playlists, in
    // one request, so the Network tab only fills in as the user actually
    // needs more, instead of 19 extra calls up front.
    const sentinel = document.createElement("div");
    sentinel.id = "scroll-sentinel";
    sentinel.style.height = "1px";
    els.channelsGrid.appendChild(sentinel);

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          obs.disconnect();
          loadRestChannels();
        }
      },
      { rootMargin: "200px" }
    );
    obs.observe(sentinel);
  }
}

/* ============================================================
   LAZY-LOAD REMAINING PLAYLISTS (fires once, after S11 is scrolled)
   ============================================================ */
function persistServersMap() {
  const serversMap = {};
  for (const ch of allChannels) {
    serversMap[ch.id] = {
      id: ch.id,
      name: ch.name,
      logo: ch.logo,
      group: ch.group,
      servers: ch.servers,
    };
  }
  localStorage.setItem(CONFIG.SERVERS_MAP_KEY, JSON.stringify(serversMap));
}

async function loadRestChannels() {
  if (restLoaded || restLoading) return;
  restLoading = true;

  try {
    const res = await fetch(
      CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT + "?scope=rest",
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { extraServers, extraChannels } = await res.json();

    // Attach alternate servers to channels S11 already has
    if (extraServers) {
      for (const ch of allChannels) {
        const key = normalizeName(ch.name);
        const additions = extraServers[key];
        if (!additions || !additions.length) continue;
        additions.forEach((s) => {
          const dup = ch.servers.some((existing) => existing.url === s.url);
          if (!dup) ch.servers.push({ ...s, label: `Server ${ch.servers.length + 1}` });
        });
      }
    }

    // Append channels that only exist in secondary playlists — no
    // duplicates, since the Worker already excluded anything matching a
    // primary channel by normalized name
    if (Array.isArray(extraChannels) && extraChannels.length) {
      allChannels = allChannels.concat(extraChannels);
    }

    restLoaded = true;
    persistServersMap();
    renderCategorySelect();
    renderLanguageSelect();
    // Keep current scroll position/visibleCount — just widen the pool the
    // sentinel can keep paging through
    filteredChannels = computeFilteredChannels();
    renderChannels();
    updateResultsMeta();
  } catch (err) {
    console.warn("Failed to load additional playlists", err.message);
    restLoading = false; // allow retry on next scroll intersection
    return;
  }
  restLoading = false;
}

/* ============================================================
   FAVORITES + MOST VIEWED
   ============================================================ */
function toggleFavorite(id) {
  const key = String(id);
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  localStorage.setItem(CONFIG.FAVORITES_KEY, JSON.stringify([...favorites]));
}

function trackView(id) {
  const key = String(id);
  mostViewed[key] = (mostViewed[key] || 0) + 1;
  localStorage.setItem(CONFIG.MOST_VIEWED_KEY, JSON.stringify(mostViewed));
}

function renderMostViewed() {
  const sorted = Object.entries(mostViewed)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([id]) => allChannels.find((c) => String(c.id) === id))
    .filter(Boolean);

  if (sorted.length === 0) {
    els.mostViewedSection.classList.add("hidden");
    return;
  }

  els.mostViewedSection.classList.remove("hidden");
  els.mostViewedTrack.innerHTML = "";

  sorted.forEach((ch) => {
    const item = document.createElement("div");
    item.className = "mv-item";
    item.title = ch.name;
    item.innerHTML = `
      <div class="mv-logo-wrap">
        ${ch.logo ? `<img src="${escapeHtml(ch.logo)}" alt="${escapeHtml(ch.name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'">` : ""}
        <div class="mv-fallback" style="${ch.logo ? "display:none" : "display:grid"}">${escapeHtml(getLogoFallback(ch.name))}</div>
      </div>
    `;
    item.addEventListener("click", () => {
      trackView(ch.id);
      window.location.href = `./player.html?id=${encodeURIComponent(ch.id)}`;
    });
    els.mostViewedTrack.appendChild(item);
  });
}

/* ============================================================
   HERO BANNER
   ============================================================ */
async function loadHighlights() {
  // Serve highlights.json from the same origin (site/ or data/) — not from private GitHub
  const candidates = [
    "./" + CONFIG.HIGHLIGHTS_URL,
    "./data/" + CONFIG.HIGHLIGHTS_URL,
    "/data/" + CONFIG.HIGHLIGHTS_URL,
  ];
  try {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            highlights = data;
            return;
          }
        }
      } catch (_) {}
    }
    highlights = getDefaultHighlights();
  } catch {
    highlights = getDefaultHighlights();
  }
}

function getDefaultHighlights() {
  return [
    {
      title: "Star Sports 1 HD",
      description: "Live cricket, football and exclusive sports coverage in high definition.",
      image: "https://images.unsplash.com/photo-1540747913346-19e32dc3e20d?w=1200&q=80",
      tag: "🔴 LIVE",
      category: "SPORTS",
      channelName: "Star Sports 1 HD",
      channelId: null,
    },
    {
      title: "GmaxHub Premium",
      description: "Hundreds of channels. One place. Seamless ClearKey playback.",
      image: "https://images.unsplash.com/photo-1522869635100-9f4c5e86aa37?w=1200&q=80",
      tag: "NEW",
      category: "FEATURED",
      channelName: null,
      channelId: null,
    },
  ];
}

function renderHero() {
  if (!highlights.length) {
    $("#hero-section").classList.add("hidden");
    return;
  }

  els.heroTrack.innerHTML = "";
  els.heroDots.innerHTML = "";

  highlights.forEach((item, i) => {
    const slide = document.createElement("div");
    slide.className = "hero-slide" + (i === 0 ? " active" : "");
    slide.style.backgroundImage = `linear-gradient(90deg, rgba(10,13,24,0.92) 0%, rgba(10,13,24,0.4) 50%, rgba(10,13,24,0.7) 100%), url('${escapeHtml(item.image || "")}')`;
    slide.innerHTML = `
      <div class="hero-content">
        ${item.tag ? `<span class="hero-tag">${escapeHtml(item.tag)}</span>` : ""}
        <h2 class="hero-title">${escapeHtml(item.title || "")}</h2>
        <p class="hero-desc">${escapeHtml(item.description || "")}</p>
        <div class="hero-actions">
          ${
            item.link
              ? `<a class="btn-primary hero-play" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">▶ Watch Now</a>`
              : item.channelId || item.channelName
              ? `<button type="button" class="btn-primary hero-play" data-id="${escapeHtml(item.channelId || "")}" data-name="${escapeHtml(item.channelName || "")}">▶ Watch Now</button>`
              : ""
          }
        </div>
      </div>
    `;
    els.heroTrack.appendChild(slide);

    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "hero-dot" + (i === 0 ? " active" : "");
    dot.setAttribute("aria-label", `Slide ${i + 1}`);
    dot.addEventListener("click", () => goToHero(i));
    els.heroDots.appendChild(dot);
  });

  // Play buttons (channel → player, external link uses <a>)
  els.heroTrack.querySelectorAll("button.hero-play").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      let target = null;
      if (id) target = allChannels.find((c) => String(c.id) === id);
      if (!target && name) {
        const n = normalizeName(name);
        target = allChannels.find((c) => normalizeName(c.name) === n);
      }
      if (target) {
        trackView(target.id);
        window.location.href = `./player.html?id=${encodeURIComponent(target.id)}`;
      } else if (id) {
        // Direct id from highlights (e.g. 892) even before channels load
        window.location.href = `./player.html?id=${encodeURIComponent(id)}`;
      }
    });
  });

  startHeroAutoplay();
}

function goToHero(index) {
  heroIndex = (index + highlights.length) % highlights.length;
  $$(".hero-slide").forEach((s, i) => s.classList.toggle("active", i === heroIndex));
  $$(".hero-dot").forEach((d, i) => d.classList.toggle("active", i === heroIndex));
  resetHeroAutoplay();
}

function startHeroAutoplay() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => goToHero(heroIndex + 1), CONFIG.HERO_INTERVAL_MS);
}

function resetHeroAutoplay() {
  startHeroAutoplay();
}

/* ============================================================
   NOTIFICATIONS
   ============================================================ */
async function loadNotifications() {
  const candidates = [
    "./" + CONFIG.NOTIFICATIONS_URL,
    "./data/" + CONFIG.NOTIFICATIONS_URL,
    "/data/" + CONFIG.NOTIFICATIONS_URL,
  ];
  try {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) continue;
        const data = await res.json();
        if (!data || !data.enabled) return;

        const readKey = localStorage.getItem(CONFIG.NOTIF_READ_KEY);
        const isNew = readKey !== data.time;

        els.notifBody.innerHTML = `
          <div class="notif-item">
            <strong>${escapeHtml(data.title || "Update")}</strong>
            <p>${escapeHtml(data.message || "")}</p>
            <span class="notif-time">${escapeHtml(data.time || "")}</span>
          </div>
        `;

        if (isNew) {
          els.notifBadge.classList.remove("hidden");
          els.notifBadge.textContent = "1";
        }
        return;
      } catch (_) {}
    }
  } catch (_) {}
}

/* ============================================================
   EVENT BINDINGS
   ============================================================ */
function bindEvents() {
  // Search
  let searchDebounce;
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchQuery = els.searchInput.value;
      els.searchClear.classList.toggle("hidden", !searchQuery);
      applyFilters();
    }, 180);
  });
  els.searchClear.addEventListener("click", () => {
    els.searchInput.value = "";
    searchQuery = "";
    els.searchClear.classList.add("hidden");
    applyFilters();
    els.searchInput.focus();
  });

  // Category
  els.categorySelect.addEventListener("change", () => {
    activeCategory = els.categorySelect.value;
    applyFilters();
  });

  // Language
  els.languageSelect.addEventListener("change", () => {
    activeLanguage = els.languageSelect.value;
    applyFilters();
  });

  // Clear filters
  els.clearFilters.addEventListener("click", () => {
    activeCategory = "all";
    activeLanguage = "all";
    searchQuery = "";
    els.searchInput.value = "";
    els.searchClear.classList.add("hidden");
    els.languageSelect.value = "all";
    els.categorySelect.value = "all";
    applyFilters();
  });
  els.emptyClear.addEventListener("click", () => els.clearFilters.click());

  // Hero arrows
  els.heroPrev.addEventListener("click", () => goToHero(heroIndex - 1));
  els.heroNext.addEventListener("click", () => goToHero(heroIndex + 1));

  // Most viewed slider
  els.mvPrev.addEventListener("click", () => {
    els.mostViewedTrack.scrollBy({ left: -280, behavior: "smooth" });
  });
  els.mvNext.addEventListener("click", () => {
    els.mostViewedTrack.scrollBy({ left: 280, behavior: "smooth" });
  });

  // Notification
  els.notifBell.addEventListener("click", () => {
    els.notifPanel.classList.toggle("hidden");
    els.notifBadge.classList.add("hidden");
    // Mark as read
    const timeEl = els.notifBody.querySelector(".notif-time");
    if (timeEl) localStorage.setItem(CONFIG.NOTIF_READ_KEY, timeEl.textContent);
  });
  els.notifClose.addEventListener("click", () => els.notifPanel.classList.add("hidden"));

  // Close notif on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".notif-widget")) {
      els.notifPanel.classList.add("hidden");
    }
  });

  // Keyboard: / focuses search
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== els.searchInput) {
      e.preventDefault();
      els.searchInput.focus();
    }
  });
}

/* ============================================================
   INIT
   ============================================================ */
async function init() {
  bindEvents();
  loadNotifications();

  try {
    await loadHighlights();
    renderHero();

    allChannels = await loadPrimaryChannels();
    restLoaded = true; // full Master merge — no secondary fetch
    persistServersMap();
    console.log(`[Gmax] Loaded ${allChannels.length} channels (S11 primary)`);

    renderCategorySelect();
    renderLanguageSelect();
    renderMostViewed();
    applyFilters();
  } catch (err) {
    console.error("Failed to load playlists", err);
    els.loadingState.innerHTML = `
      <div class="error-box">
        <p>Could not load playlists.</p>
        <p class="error-detail">${escapeHtml(err.message)}</p>
        <button type="button" class="btn-primary" onclick="location.reload()">Retry</button>
      </div>
    `;
  }
}

init();
