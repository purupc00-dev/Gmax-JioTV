"use strict";

/* =========================================================
   CONFIG
========================================================= */

const CHANNELS_URL = "./channels.json";
const API_BASE = "https://gmax-jiotv.vercel.app/api"; 
const PROXY_BASE = "https://gmaxhub.vercel.app/api/proxy?url="; // NEW: Global Proxy Base
const CHANNELS_PER_PAGE = 60;
const LIVE_DELAY_SECONDS = 5;
const LIVE_CATCHUP_TRIGGER_SECONDS = 3;
const LIVE_CATCHUP_HARD_RESYNC_SECONDS = 15;
const LIVE_CATCHUP_PLAYBACK_RATE = 1.12;
const BUFFERING_GOAL_SECONDS = 40;
const REBUFFERING_GOAL_SECONDS = 12;
const BUFFER_BEHIND_SECONDS = 60;

/* =========================================================
   STATE
========================================================= */

let allChannels = [];
let filteredChannels = [];
let activeCategory = "ALL";
let visibleCount = CHANNELS_PER_PAGE;
let shakaPlayer = null;
let currentChannel = null;
let playerUiShell = null;
let playerControls = null;
let qualityMenu = null;
let playerUiTimer = null;
let liveStatusTimer = null;
let infiniteScrollObserver = null;
let infiniteScrollBusy = false;
let lastStreamUrl = "";
let lastStreamType = "";
let isPlayerRetrying = false;
let playbackWatchdogTimer = null;
let currentFallbackIndex = 0;
let reconnectInFlight = false;

const RECENT_KEY = "gmax-jiotv-recent";
const RECENT_MAX = 12;
let recentIds = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
let jioAuth = JSON.parse(localStorage.getItem("gmax_jio_auth")) || null;

/* =========================================================
   FAVORITES
========================================================= */

const favorites = new Set(JSON.parse(localStorage.getItem("gmax-jiotv-favorites") || "[]"));

function toggleFavorite(channelId) {
  const key = String(channelId);
  if (favorites.has(key)) {
    favorites.delete(key);
  } else {
    favorites.add(key);
  }
  saveFavorites();
  buildCategories();
  renderChannels();
}

function saveFavorites() {
  localStorage.setItem("gmax-jiotv-favorites", JSON.stringify([...favorites]));
}

/* =========================================================
   CATEGORIES
========================================================= */

const MAIN_CATEGORIES = [
  "Entertainment", "Movies", "Sports", "News", "Kids", 
  "Music", "Information", "Religious",
];

function buildCategories() {
  if(!categoryList) return;
  categoryList.innerHTML = "";
  categoryList.appendChild(createCategoryButton("ALL", activeCategory === "ALL"));
  categoryList.appendChild(createCategoryButton("FAVORITES", activeCategory === "FAVORITES"));
  for (const category of MAIN_CATEGORIES) {
    categoryList.appendChild(createCategoryButton(category, activeCategory === category));
  }
}

function createCategoryButton(category, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-button" + (active ? " active" : "");
  button.dataset.category = String(category);
  button.textContent = category === "FAVORITES" ? `⭐ Favorites (${favorites.size})` : String(category);

  button.addEventListener("click", () => {
    activeCategory = category;
    visibleCount = CHANNELS_PER_PAGE;
    if (infiniteScrollObserver) {
      infiniteScrollObserver.disconnect();
      infiniteScrollObserver = null;
    }
    const oldSentinel = document.getElementById("gmax-infinite-scroll-sentinel");
    if (oldSentinel) oldSentinel.remove();

    document.querySelectorAll(".category-button").forEach(item => {
      item.classList.toggle("active", item.dataset.category === String(category));
      if (item.dataset.category === "FAVORITES") {
        item.textContent = `⭐ Favorites (${favorites.size})`;
      }
    });
    applyFilters();
  });
  return button;
}

/* =========================================================
   DOM
========================================================= */

const channelsGrid = document.getElementById("channels-grid");
const categoryList = document.getElementById("category-list");
const searchInput = document.getElementById("search-input");
const channelCount = document.getElementById("channel-count");
const resultsCount = document.getElementById("results-count");
const loadMore = document.getElementById("load-more");
const loadMoreButton = document.getElementById("load-more-button");
const playerSection = document.getElementById("player-section");
const video = document.getElementById("video");
const playingTitle = document.getElementById("playing-title");
const playingMeta = document.getElementById("playing-meta");
const playerLoading = document.getElementById("player-loading");
const playerEmpty = document.getElementById("player-empty");
const playerError = document.getElementById("player-error");
const closePlayerButton = document.getElementById("close-player");

const authNavBtn = document.getElementById("auth-nav-btn");
const loginModal = document.getElementById("login-modal");
const stepPhone = document.getElementById("step-phone");
const stepOtp = document.getElementById("step-otp");
const inputPhone = document.getElementById("input-phone");
const inputOtp = document.getElementById("input-otp");
const btnSendOtp = document.getElementById("btn-send-otp");
const btnVerifyOtp = document.getElementById("btn-verify-otp");
const btnCancelLogin = document.getElementById("btn-cancel-login");
const loginError = document.getElementById("login-error");

/* =========================================================
   OTP LOGIN SYSTEM
========================================================= */

function updateAuthUI() {
    if (authNavBtn) { 
        authNavBtn.textContent = jioAuth ? "Logout" : "Login";
        authNavBtn.style.display = "none"; 
    } 
}
updateAuthUI();

if (authNavBtn) {
    authNavBtn.addEventListener("click", () => {
        if (jioAuth) {
            localStorage.removeItem("gmax_jio_auth");
            jioAuth = null;
            updateAuthUI();
            alert("Logged out successfully.");
            loadChannels(); 
        } else {
            loginModal.classList.remove("hidden");
            stepPhone.classList.remove("hidden");
            stepOtp.classList.add("hidden");
            loginError.textContent = "";
        }
    });
}

if (btnCancelLogin) {
    btnCancelLogin.addEventListener("click", () => loginModal.classList.add("hidden"));
}

if (btnSendOtp) {
    btnSendOtp.addEventListener("click", async () => {
        const number = inputPhone.value.trim();
        if (number.length < 10) return loginError.textContent = "Enter a valid 10-digit number.";
        
        btnSendOtp.textContent = "Sending...";
        btnSendOtp.disabled = true;
        try {
            const res = await fetch(`${API_BASE}/send_otp`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ number })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                stepPhone.classList.add("hidden");
                stepOtp.classList.remove("hidden");
                loginError.textContent = "";
            } else {
                const base = data.error || data.message || `Failed to send OTP (HTTP ${res.status}).`;
                loginError.textContent = data.raw ? `${base} [raw: ${data.raw.slice(0, 150)}]` : base;
            }
        } catch (e) {
            loginError.textContent = `Server connection error: ${e.message}`;
        }
        btnSendOtp.textContent = "Send OTP";
        btnSendOtp.disabled = false;
    });
}

if (btnVerifyOtp) {
    btnVerifyOtp.addEventListener("click", async () => {
        const number = inputPhone.value.trim();
        const otp = inputOtp.value.trim();
        if (!otp) return loginError.textContent = "Enter OTP.";
        
        btnVerifyOtp.textContent = "Verifying...";
        btnVerifyOtp.disabled = true;
        try {
            const res = await fetch(`${API_BASE}/verify_otp`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ number, otp })
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                jioAuth = { ssotoken: data.ssoToken, uniqueid: data.uniqueId, crmid: data.crm || "" };
                if (!jioAuth.ssotoken || !jioAuth.uniqueid) {
                    loginError.textContent = "Login succeeded but session info was incomplete. Try again.";
                    btnVerifyOtp.textContent = "Verify & Login";
                    btnVerifyOtp.disabled = false;
                    return;
                }
                localStorage.setItem("gmax_jio_auth", JSON.stringify(jioAuth));
                loginModal.classList.add("hidden");
                updateAuthUI();
                alert("Login Successful! Loading your JioTV channel list...");
                loadChannels(); 
            } else {
                loginError.textContent = data.error || data.message || `Invalid OTP (HTTP ${res.status}).`;
            }
        } catch (e) {
            loginError.textContent = `Verification error: ${e.message}`;
        }
        btnVerifyOtp.textContent = "Verify & Login";
        btnVerifyOtp.disabled = false;
    });
}

/* =========================================================
   HELPERS & DATA
========================================================= */

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function streamType(channel) {
  const url = String(channel?.stream_url || channel?.url || "").toLowerCase();
  if (url.includes(".mpd") || url.includes(".dash")) return "dash";
  if (url.includes(".m3u8")) return "hls";
  return "unknown";
}

function getStreamUrl(channel) {
  return channel?.stream_url || channel?.url || "";
}

function normalizeCategory(group, name) {
  const text = `${group || ""} ${name || ""}`.toLowerCase();
  if (/sport|cricket|football|fifa|tennis|kabaddi|nba|nfl|racing|formula/.test(text)) return "Sports";
  if (/news|headline|breaking|current affairs/.test(text)) return "News";
  if (/movie|cinema|film|bollywood|hollywood|picture/.test(text)) return "Movies";
  if (/kid|cartoon|animation|junior|children|nick|hungama/.test(text)) return "Kids";
  if (/music|mtv|radio|songs|fm /.test(text)) return "Music";
  if (/relig|devotional|spiritual|bhakti|temple|islam|quran|church|gospel|hindu|sikh/.test(text)) return "Religious";
  if (/info|document|education|knowledge|science|tech|history|nature|travel|lifestyle|business|weather|health|food/.test(text)) return "Information";
  return "Entertainment";
}

function getCategory(channel) {
  const raw = channel?.category || channel?.group || "";
  if (MAIN_CATEGORIES.includes(raw)) return raw;
  return normalizeCategory(raw, channel?.name || "");
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  const t = document.createElement("textarea");
  t.innerHTML = String(str);
  return t.value;
}

function getChannelLogo(channel) {
  return channel?.logo || channel?.tvg_logo || "";
}

function getChannelId(channel) {
  return String(channel?.id || channel?.tvgId || channel?.kid || "");
}

function base64ToHex(base64UrlStr) {
  let base64 = base64UrlStr.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) { base64 += '='; }
  const raw = atob(base64);
  let hex = '';
  for (let i = 0; i < raw.length; i++) {
    const h = raw.charCodeAt(i).toString(16);
    hex += (h.length === 2 ? h : '0' + h);
  }
  return hex;
}

/* =========================================================
   ADVANCED PARSER (TESTER LOGIC)
========================================================= */

function checkTokenExpiration(tokenStr) {
  if (!tokenStr) return null;
  const expMatch = tokenStr.match(/exp=(\d+)/i);
  if (expMatch) return parseInt(expMatch[1], 10) < Math.floor(Date.now() / 1000); 
  return null; 
}

function healChannel(ch) {
  const inlineHotstar = ch.url.match(/(hdntl=[^&|]+)/i);
  if (inlineHotstar) { ch.token = inlineHotstar[1]; ch.tokenType = "HOTSTAR"; ch.url = ch.url.replace(/([?&])hdntl=[^&|]*/gi, '').replace(/[?&]$/, ''); }
  const inlineSony = ch.url.match(/(hdnea=exp=[^&|]+)/i);
  if (inlineSony && ch.tokenType !== "JIO") { ch.token = inlineSony[1]; ch.tokenType = "SONYLIV"; ch.url = ch.url.replace(/([?&])hdnea=exp=[^&|]*/gi, '').replace(/[?&]$/, ''); }
  const inlineJio = ch.url.match(/(__hdnea__=[^&|]+)/i) || ch.url.match(/(st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+)/i);
  if (inlineJio) { ch.token = inlineJio[1].startsWith('__hdnea__') ? inlineJio[1] : "__hdnea__=" + inlineJio[1]; ch.tokenType = "JIO"; ch.url = ch.url.replace(/([?&])(__hdnea__=)?st=\d+~exp=[^&|]*/gi, '').replace(/[?&]$/, ''); }

  if (ch.url.includes('hotstar.com') || ch.url.includes('hot.php')) {
    if (!ch.origin) ch.origin = "https://www.hotstar.com";
    if (!ch.referer) ch.referer = "https://www.hotstar.com/";
  }
  if (ch.url.includes('sonyliv.com') || ch.url.includes('slivcdn.com')) {
    if (!ch.origin) ch.origin = "https://www.sonyliv.com";
    if (!ch.referer) ch.referer = "https://www.sonyliv.com/";
  }

  if (ch.token) ch.isExpired = checkTokenExpiration(ch.token);
  return ch;
}

function createEmptyChannel() {
  return { name: "Unknown", group: "Uncategorized", url: "", kid: "", key: "", clearKeysMap: null, licenseUrl: "", drmType: "clearkey", userAgent: "", token: "", tokenType: "NONE", isExpired: null, logo: "", origin: "", referer: "" };
}

function parseUniversalM3U(text) {
  const lines = text.split('\n');
  const channels = [];
  let ch = createEmptyChannel();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const nameMatch = line.match(/tvg-name="([^"]+)"/);
      ch.name = nameMatch ? nameMatch[1] : line.split(',').pop().trim();
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      if (logoMatch) ch.logo = logoMatch[1];
      const groupMatch = line.match(/group-title="([^"]+)"/);
      if (groupMatch && groupMatch[1]) ch.group = groupMatch[1];
      const idMatch = line.match(/tvg-id="([^"]+)"/);
      if (idMatch) ch.id = idMatch[1];
    } 
    else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_type=')) { ch.drmType = line.split('=')[1].trim(); }
    else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      const val = line.split('=').slice(1).join('=').trim();
      if (val.startsWith('http')) { ch.licenseUrl = val; }
      else if (val.startsWith('{')) {
        try {
          const jwk = JSON.parse(val);
          if (jwk.keys) {
            ch.clearKeysMap = {};
            jwk.keys.forEach(k => { if (k.kid && k.k) ch.clearKeysMap[base64ToHex(k.kid)] = base64ToHex(k.k); });
          }
        } catch(e) {}
      } else if (val.includes(':')) {
        const parts = val.split(':');
        ch.kid = parts[0].trim();
        ch.key = parts[1].trim();
      }
    }
    else if (line.startsWith('#EXTVLCOPT:http-user-agent=')) { ch.userAgent = line.split('=')[1].trim(); }
    else if (line.startsWith('#EXTVLCOPT:http-referrer=')) { ch.referer = line.substring(25).trim(); }
    else if (line.startsWith('#EXTVLCOPT:http-cookie=')) {
      const cookieStr = line.substring(23).trim();
      const hotstarMatch = cookieStr.match(/hdntl=[^&\s"|']+/i);
      const jioMatch = cookieStr.match(/__hdnea__=[^&\s"|']+/i) || cookieStr.match(/st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/i);
      const sonyMatch = cookieStr.match(/hdnea=exp=[^&\s"|']+/i);
      if (hotstarMatch) { ch.token = hotstarMatch[0]; ch.tokenType = "HOTSTAR"; }
      else if (jioMatch) { ch.token = jioMatch[0].startsWith('__hdnea__') ? jioMatch[0] : "__hdnea__=" + jioMatch[0]; ch.tokenType = "JIO"; }
      else if (sonyMatch) { ch.token = sonyMatch[0]; ch.tokenType = "SONYLIV"; }
      else { ch.token = cookieStr; ch.tokenType = "UNKNOWN"; }
    }
    else if (line.startsWith('#EXTHTTP:')) {
      try {
        const jsonStr = line.substring(9).trim();
        const httpProps = JSON.parse(jsonStr);
        if (httpProps.Origin || httpProps.origin) ch.origin = httpProps.Origin || httpProps.origin;
        if (httpProps.Referer || httpProps.referer || httpProps.Referrer || httpProps.referrer) ch.referer = httpProps.Referer || httpProps.referer || httpProps.Referrer || httpProps.referrer;
        const cookieStr = httpProps.Cookie || httpProps.cookie;
        if (cookieStr) {
          const hotstarMatch = cookieStr.match(/hdntl=[^&\s"|']+/i);
          const jioMatch = cookieStr.match(/__hdnea__=[^&\s"|']+/i) || cookieStr.match(/st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/i);
          const sonyMatch = cookieStr.match(/hdnea=exp=[^&\s"|']+/i);
          if (hotstarMatch) { ch.token = hotstarMatch[0]; ch.tokenType = "HOTSTAR"; }
          else if (jioMatch) { ch.token = jioMatch[0].startsWith('__hdnea__') ? jioMatch[0] : "__hdnea__=" + jioMatch[0]; ch.tokenType = "JIO"; }
          else if (sonyMatch) { ch.token = sonyMatch[0]; ch.tokenType = "SONYLIV"; }
          else { ch.token = cookieStr; ch.tokenType = "UNKNOWN"; }
        }
      } catch(e) {}
    }
    
    if (!line.startsWith('#') && line.startsWith('http')) {
      let rawUrl = line;

      if (!ch.token) {
        const hMatch = rawUrl.match(/hdntl=[^&\s"|']+/i);
        const jMatch = rawUrl.match(/__hdnea__=[^&\s"|']+/i) || rawUrl.match(/st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/i);
        const sMatch = rawUrl.match(/hdnea=exp=[^&\s"|']+/i);
        if (hMatch) { ch.token = hMatch[0]; ch.tokenType = "HOTSTAR"; }
        else if (jMatch) { ch.token = jMatch[0].startsWith('__hdnea__') ? jMatch[0] : "__hdnea__=" + jMatch[0]; ch.tokenType = "JIO"; }
        else if (sMatch) { ch.token = sMatch[0]; ch.tokenType = "SONYLIV"; }
      }

      if (rawUrl.includes('|')) {
        const separator = rawUrl.includes('?|') ? '?|' : '|';
        const parts = rawUrl.split(separator);
        ch.url = parts[0].replace(/\?$/, '');
        const kodiProps = parts[1].split('&');
        kodiProps.forEach(prop => {
          const kv = prop.split('=');
          if (kv.length >= 2) {
            const key = kv[0].toLowerCase();
            let val = kv.slice(1).join('=');
            try { val = decodeURIComponent(val); } catch(e) {}
            if (key === 'cookie') {
              const hMatch = val.match(/hdntl=[^&\s"|']+/i);
              const jMatch = val.match(/__hdnea__=[^&\s"|']+/i) || val.match(/st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/i);
              const sMatch = val.match(/hdnea=exp=[^&\s"|']+/i);
              if (hMatch) { ch.token = hMatch[0]; ch.tokenType = "HOTSTAR"; }
              else if (jMatch) { ch.token = jMatch[0].startsWith('__hdnea__') ? jMatch[0] : "__hdnea__=" + jMatch[0]; ch.tokenType = "JIO"; }
              else if (sMatch) { ch.token = sMatch[0]; ch.tokenType = "SONYLIV"; }
              else { ch.token = val; ch.tokenType = "UNKNOWN"; }
            }
            if (key === 'referer') ch.referer = val;
            if (key === 'origin') ch.origin = val;
            if (key === 'user-agent' && !ch.userAgent) ch.userAgent = val;
          }
        });
      } else {
        let cleanUrl = rawUrl.replace(/([?&])(__hdnea__|hdntl|hdnea)=[^&]*/gi, "").replace(/([?&])st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/gi, "").replace(/\?&/g, "?").replace(/[?&]$/, "");
        ch.url = cleanUrl;
      }
      ch = healChannel(ch);
      channels.push(ch);
      ch = createEmptyChannel();
    }
  }
  return channels;
}

/* =========================================================
   EXTENDED CONFIG MERGER
========================================================= */

function getActiveStreamConfig() {
  const ch = currentChannel;
  if (!ch) return { url: "", cookie: "", kid: "", key: "", token: "", origin: "", referer: "", userAgent: "", licenseUrl: "" };

  const sources = Array.isArray(ch.sources) && ch.sources.length ? ch.sources : null;

  if (sources) {
    const idx = Math.min(Math.max(currentFallbackIndex, 0), sources.length - 1);
    const s = sources[idx] || sources[0];
    return {
      url: s.stream_url || s.url || getStreamUrl(ch),
      cookie: s.cookie || ch.cookie || ch.token || "",
      kid: s.key_id || s.kid || ch.key_id || ch.kid || "",
      key: s.key || ch.key || "",
      token: s.token || ch.token || "",
      origin: s.origin || ch.origin || "",
      referer: s.referer || ch.referer || "",
      userAgent: s.userAgent || ch.userAgent || "",
      licenseUrl: s.licenseUrl || ch.licenseUrl || ""
    };
  }

  let url = getStreamUrl(ch);
  let cookie = ch.cookie || ch.token || "";
  let kid = ch.key_id || ch.kid || "";
  let key = ch.key || "";
  let token = ch.token || "";
  let origin = ch.origin || "";
  let referer = ch.referer || "";
  let userAgent = ch.userAgent || "";
  let licenseUrl = ch.licenseUrl || "";

  if (currentFallbackIndex > 0 && ch.fallbacks && ch.fallbacks[currentFallbackIndex - 1]) {
    const fb = ch.fallbacks[currentFallbackIndex - 1];
    url = fb.stream_url || url;
    cookie = fb.cookie || cookie;
    kid = fb.key_id || kid;
    key = fb.key || key;
    token = fb.token || token;
    origin = fb.origin || origin;
    referer = fb.referer || referer;
    userAgent = fb.userAgent || userAgent;
    licenseUrl = fb.licenseUrl || licenseUrl;
  }
  return { url, cookie, kid, key, token, origin, referer, userAgent, licenseUrl };
}

/* =========================================================
   FILTERING & RENDERING
========================================================= */

function applyFilters() {
  const query = normalize(searchInput ? searchInput.value : "");
  filteredChannels = allChannels.filter(channel => {
    const category = getCategory(channel);
    const matchesCategory = activeCategory === "ALL" || (activeCategory === "FAVORITES" ? favorites.has(getChannelId(channel)) : normalize(category) === normalize(activeCategory));
    if (!matchesCategory) return false;
    if (!query) return true;
    const searchable = [channel.name, channel.id, channel.group, channel.category, channel.language, channel.country].map(normalize).join(" ");
    return searchable.includes(query);
  });
  if (resultsCount) resultsCount.textContent = `${filteredChannels.length.toLocaleString()} channels`;
  visibleCount = Math.min(visibleCount, filteredChannels.length);
  renderChannels();
}

function renderChannels() {
  if (!channelsGrid) return;
  const visible = filteredChannels.slice(0, visibleCount);
  channelsGrid.innerHTML = "";
  if (visible.length === 0) {
    channelsGrid.innerHTML = `<div class="empty-grid">No channels found.</div>`;
    hideLoadMore();
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const channel of visible) {
    fragment.appendChild(createChannelCard(channel));
  }
  channelsGrid.appendChild(fragment);
  hideLoadMore();
  ensureInfiniteScrollObserver();
}

function createChannelCard(channel) {
  const card = document.createElement("article");
  card.className = "channel-card";
  const id = getChannelId(channel) || String(Math.random());
  const favorite = favorites.has(id);
  const logo = getChannelLogo(channel);
  const group = channel.group || channel.groupTitle || getCategory(channel);

  card.innerHTML = `
    <button class="favorite-button ${favorite ? "active" : ""}" type="button" aria-label="Favorite">${favorite ? "♥" : "♡"}</button>
    <div class="channel-logo-wrap">
      ${logo ? `<img class="channel-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(channel.name)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">` : ""}
      <div class="channel-fallback" style="display:${logo ? "none" : "flex"};">TV</div>
    </div>
    <div class="channel-info">
      <div class="channel-name">${escapeHtml(channel.name || "Unknown Channel")}</div>
      <div class="channel-meta">JIO TV • ${escapeHtml(channel.country || "INDIA")} • ${escapeHtml(group)}</div>
    </div>
  `;

  card.querySelector(".favorite-button").addEventListener("click", event => {
    event.stopPropagation();
    toggleFavorite(id);
  });

  card.addEventListener("click", () => {
    openChannel(channel, 0);
  });
  return card;
}

/* =========================================================
   PLAYER DESTROY
========================================================= */

async function destroyPlayer() {
  stopLiveStatusTimer();
  clearTimeout(playbackWatchdogTimer); 
  hidePlayerErrorOverlay();

  if (shakaPlayer) {
    try { await shakaPlayer.destroy(); } catch (error) {}
    shakaPlayer = null;
  }

  try {
    if(video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
    }
  } catch (e) {}

  if (playerUiShell) {
    playerUiShell.classList.remove("gmax-controls-hidden");
  }
}

/* =========================================================
   ORIGINAL PLAYER MESSAGE FUNCTIONS
========================================================= */

function showPlayerLoading(state) {
  if (playerLoading) playerLoading.classList.toggle("hidden", !state);
  if (playerUiShell) {
    const reconnectOverlay = playerUiShell.querySelector('[data-role="reconnect-overlay"]');
    if (reconnectOverlay) reconnectOverlay.style.display = (state && reconnectInFlight) ? "flex" : "none";
  }
  hidePlayerSpinner();
  if (playerError) {
    playerError.classList.add("hidden");
    playerError.textContent = "";
  }
}

function totalSourceCount(channel) {
  if (!channel) return 1;
  if (Array.isArray(channel.sources) && channel.sources.length) return channel.sources.length;
  const fb = channel.fallbacks || [];
  return 1 + fb.length;
}

function setLoadingSourceMessage(index, total) {
  const n = index + 1;
  const t = Math.max(total, n);
  const msg = index === 0 ? `Connecting... (${n}/${t})` : `Reconnecting... (${n}/${t})`;
  if (playerUiShell) {
    const reconnectText = playerUiShell.querySelector('[data-role="reconnect-text"]');
    if (reconnectText) reconnectText.textContent = msg;
  }
  const loadingSpan = document.querySelector("#player-loading-text") || document.querySelector("#player-loading span");
  if (loadingSpan) loadingSpan.textContent = msg;
}

async function handleStreamError(err) {
  console.warn("Silent reconnect:", err);
  if (reconnectInFlight || !currentChannel) return;
  reconnectInFlight = true;
  clearTimeout(playbackWatchdogTimer);

  const total = totalSourceCount(currentChannel);
  const maxIdx = total - 1;

  if (currentFallbackIndex < maxIdx) {
    const nextIdx = currentFallbackIndex + 1;
    setLoadingSourceMessage(nextIdx, total);
    showPlayerLoading(true);
    hidePlayerErrorOverlay();
    
    setTimeout(() => {
      reconnectInFlight = false;
      openChannel(currentChannel, nextIdx).catch(() => {});
    }, 500);

  } else {
    showPlayerLoading(false);
    const errorMsg = `All ${total} sources failed to play.`;
    showPlayerErrorOverlay(errorMsg);
    await destroyPlayer();
    reconnectInFlight = false;
  }
}

function showPlayerError(message) { handleStreamError(message); }
function clearPlayerError() {
  if(playerError) { playerError.textContent = ""; playerError.classList.add("hidden"); }
  hidePlayerErrorOverlay();
}

/* =========================================================
   OPEN CHANNEL (MERGED WITH TESTER LOGIC)
========================================================= */

async function openChannel(channel, fallbackIdx = 0) {
  currentChannel = channel;
  currentFallbackIndex = fallbackIdx;
  const id = channel.id || channel.tvgId;

  const config = getActiveStreamConfig();
  let streamUrl = config.url;
  
  // Use Tester Proxy Toggle if it exists, otherwise false
  const proxyToggle = document.getElementById("use-proxy-toggle");
  const useProxy = proxyToggle ? proxyToggle.checked : false;

  if (jioAuth && jioAuth.ssotoken && !channel.isM3u) {
      const channelId = channel.id || channel.tvgId;
      if (channelId) {
          try {
              const res = await fetch(`${API_BASE}/get_stream?id=${channelId}&ssotoken=${encodeURIComponent(jioAuth.ssotoken)}&uniqueid=${encodeURIComponent(jioAuth.uniqueid)}&crmid=${encodeURIComponent(jioAuth.crmid || "")}`);
              const streamData = await res.json();
              if (streamData.url) {
                  streamUrl = streamData.url;
                  config.token = streamData.token || config.token;
              }
          } catch (e) { console.error("Vercel stream fetch failed", e); }
      }
  }

  if (!streamUrl) {
    showPlayerError("This channel does not contain a playable stream URL.");
    return;
  }

  lastStreamUrl = streamUrl;
  lastStreamType = streamType({ stream_url: streamUrl });

  if(playerSection) playerSection.classList.remove("hidden");
  if(playerEmpty) playerEmpty.classList.add("hidden");

  if (!playerUiShell) setupCinematicPlayer();

  if(playingTitle) playingTitle.textContent = channel.name || "Channel";
  if(playingMeta) playingMeta.textContent = ["JIO TV", channel.country || "INDIA", getCategory(channel)].filter(Boolean).join(" • ");

  clearPlayerError();
  hidePlayerErrorOverlay();
  setLoadingSourceMessage(fallbackIdx, totalSourceCount(channel));
  showPlayerLoading(true);

  try {
    const cid = String(channel.id || channel.tvgId || channel.kid || "");
    if (cid) {
      recentIds = [cid, ...recentIds.filter((x) => x !== cid)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
      renderRecentSlider();
    }
  } catch (_) {}

  history.replaceState(null, "", `?id=${encodeURIComponent(id || "")}`);
  window.scrollTo({ top: 0, behavior: "smooth" });

  await destroyPlayer();

  clearTimeout(playbackWatchdogTimer);
  playbackWatchdogTimer = setTimeout(() => {
    if (video.readyState <= 2 && !reconnectInFlight) {
      handleStreamError("Stream timeout (Black screen)");
    }
  }, 15000);

  let streamLoadedSuccessfully = false;

  try {
    if (lastStreamType === "dash") {
      await playDash(config, useProxy);
    } else if (lastStreamType === "hls") {
      await playHls(config, useProxy);
    } else {
      throw new Error(`Unsupported stream format.`);
    }
    streamLoadedSuccessfully = true;
  } catch (error) {
    console.error("Playback failed:", error);
    await handleStreamError(error instanceof Error ? error.message : String(error));
  } finally {
    if (streamLoadedSuccessfully) {
      reconnectInFlight = false;
      showPlayerLoading(false);
    } else if (!reconnectInFlight) {
      showPlayerLoading(false);
    }
  }
}

function getShakaStreamingConfig(isClearKey) {
  return {
    preferredVideoCodecs: ['avc1', 'avc'], // 4012 H.264 Bypass
    preferredAudioCodecs: ['mp4a', 'aac'],
    streaming: {
      bufferingGoal: 30,
      rebufferingGoal: 2,
      bufferBehind: BUFFER_BEHIND_SECONDS,
      lowLatencyMode: false,
      inaccurateManifestTolerance: 2,
      segmentPrefetchLimit: 3,
      retryParameters: { maxAttempts: 5, baseDelay: 400, backoffFactor: 1.6, timeout: 20000 },
      stallEnabled: true,
      stallThreshold: 1.5,
      stallSkip: 0.1,
      jumpLargeGaps: true,
      ignoreTextStreamFailures: true
    },
    abr: { enabled: true, useNetworkInformation: true, switchInterval: 8, bandwidthUpgradeTarget: 0.85, bandwidthDowngradeTarget: 0.95 },
    manifest: {
      dash: { ignoreDrmInfo: isClearKey, defaultPresentationDelay: 10 }, // 6012 Bypass + Buffer stall fix
      retryParameters: { maxAttempts: 4, baseDelay: 300, backoffFactor: 1.5, timeout: 15000 }
    }
  };
}

/* =========================================================
   DASH ENGINE (WITH ULTIMATE FILTER & PRE-FETCH)
========================================================= */

async function playDash(config, useProxy) {
  if (!window.shaka) throw new Error("Shaka Player has not loaded yet.");
  if (!shaka.Player.isBrowserSupported()) throw new Error("Browser unsupported.");

  shakaPlayer = new shaka.Player(video);
  
  shakaPlayer.addEventListener("error", event => { handleStreamError(event.detail); });

  const networkingEngine = shakaPlayer.getNetworkingEngine();
  
  // Ultimate Network Filter 
  if (networkingEngine) {
    networkingEngine.registerResponseFilter((type, response) => {
        if (type === shaka.net.NetworkingEngine.RequestType.MANIFEST) {
            if (response.uri && response.uri.includes('/api/proxy?url=')) {
                try {
                    let urlObj = new URL(response.uri);
                    let actualUrl = urlObj.searchParams.get('url');
                    if (actualUrl) { response.uri = actualUrl; }
                } catch (e) {}
            }
        }
    });

    networkingEngine.registerRequestFilter((type, request) => {
        if (config.userAgent) request.headers['User-Agent'] = config.userAgent;
        if (config.origin) request.headers['Origin'] = config.origin;
        if (config.referer) request.headers['Referer'] = config.referer;
        if (config.token || config.cookie) request.headers['Cookie'] = config.token || config.cookie;

        if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
            if (useProxy && config.licenseUrl && (config.origin || config.referer || config.userAgent)) {
                let proxyLicenseUrl = PROXY_BASE + encodeURIComponent(request.uris[0]);
                if (config.userAgent) proxyLicenseUrl += `&ua=${encodeURIComponent(config.userAgent)}`;
                if (config.origin) proxyLicenseUrl += `&origin=${encodeURIComponent(config.origin)}`;
                if (config.referer) proxyLicenseUrl += `&referer=${encodeURIComponent(config.referer)}`;
                if (config.token) proxyLicenseUrl += `&cookie=${encodeURIComponent(config.token)}`;
                request.uris[0] = proxyLicenseUrl;
            }
            return;
        }

        request.uris = request.uris.map(uri => {
            let cleanUri = uri;
            if (cleanUri.includes('?|')) cleanUri = cleanUri.split('?|')[0];
            else if (cleanUri.includes('|')) cleanUri = cleanUri.split('|')[0];

            try {
                const isProxied = cleanUri.includes('/api/proxy?url=');
                let actualUrl = cleanUri;
                let urlObj = null;
                if (isProxied) {
                    urlObj = new URL(cleanUri, window.location.origin);
                    actualUrl = urlObj.searchParams.get('url') || cleanUri;
                }

                const isCDN = actualUrl.includes('hotstar.com') || actualUrl.includes('jio.com') || actualUrl.includes('.m4s') || actualUrl.includes('.ts') || actualUrl.includes('.mpd') || actualUrl.includes('.dash') || actualUrl.includes('.m3u8');
                
                if (isCDN) {
                    let cleanActualUrl = actualUrl.replace(/([?&])(__hdnea__|hdntl|hdnea)=[^&]*/gi, "").replace(/([?&])st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/gi, "").replace(/\?&/g, "?").replace(/[?&]$/, "");
                    cleanActualUrl = cleanActualUrl.replace(/(https?:\/\/[^\/]+)\/\/+/g, "$1/"); // Double Slash Sanitize

                    const theToken = config.token || config.cookie;
                    if (theToken) {
                        const separator = cleanActualUrl.includes("?") ? "&" : "?";
                        cleanActualUrl = cleanActualUrl + separator + theToken;
                    }

                    if (useProxy) {
                        let proxyUri = PROXY_BASE + encodeURIComponent(cleanActualUrl);
                        if (config.userAgent) proxyUri += `&ua=${encodeURIComponent(config.userAgent)}`;
                        if (config.origin) proxyUri += `&origin=${encodeURIComponent(config.origin)}`;
                        if (config.referer) proxyUri += `&referer=${encodeURIComponent(config.referer)}`;
                        if (theToken) proxyUri += `&cookie=${encodeURIComponent(theToken)}`;
                        return proxyUri;
                    } else if (isProxied) {
                        urlObj.searchParams.set('url', cleanActualUrl);
                        return urlObj.toString();
                    } else {
                        return cleanActualUrl;
                    }
                }
            } catch (e) {}
            return cleanUri; 
        });
    });
  }

  let drmConfig = { clearKeys: {}, servers: {} };
  let useDrm = false;

  // Remote Key Pre-Fetch Engine (Fixes 6001 / 6012)
  if (config.licenseUrl && !config.kid) {
      try {
          let keyFetchUrl = config.licenseUrl;
          if (useProxy) {
              keyFetchUrl = PROXY_BASE + encodeURIComponent(config.licenseUrl);
              if (config.userAgent) keyFetchUrl += `&ua=${encodeURIComponent(config.userAgent)}`;
              if (config.origin) keyFetchUrl += `&origin=${encodeURIComponent(config.origin)}`;
              if (config.referer) keyFetchUrl += `&referer=${encodeURIComponent(config.referer)}`;
              if (config.token) keyFetchUrl += `&cookie=${encodeURIComponent(config.token)}`;
          }
          const res = await fetch(keyFetchUrl);
          const text = await res.text();
          const cleanText = text.trim();
          
          if (cleanText.includes(':') && !cleanText.startsWith('{')) {
              const parts = cleanText.split(':');
              drmConfig.clearKeys[parts[0].trim()] = parts[1].trim();
              useDrm = true;
          } else if (cleanText.includes('{')) {
              const jwk = JSON.parse(cleanText);
              if (jwk.keys) {
                  jwk.keys.forEach(k => { if (k.kid && k.k) drmConfig.clearKeys[base64ToHex(k.kid)] = base64ToHex(k.k); });
                  useDrm = true;
              }
          } else {
              drmConfig.servers['org.w3.clearkey'] = config.licenseUrl;
              useDrm = true;
          }
      } catch (e) {
          drmConfig.servers['org.w3.clearkey'] = config.licenseUrl;
          useDrm = true;
      }
  } else if (config.kid && config.key) {
      drmConfig.clearKeys[config.kid] = config.key;
      useDrm = true;
  } else if (currentChannel.clearKeysMap && Object.keys(currentChannel.clearKeysMap).length > 0) {
      drmConfig.clearKeys = currentChannel.clearKeysMap;
      useDrm = true;
  }

  let isClearKey = useDrm && (Object.keys(drmConfig.clearKeys).length > 0 || config.licenseUrl.includes("key.php") || (currentChannel.drmType && currentChannel.drmType.toLowerCase() === 'clearkey'));

  const shakaConfig = getShakaStreamingConfig(isClearKey);
  if (useDrm) shakaConfig.drm = drmConfig;
  shakaPlayer.configure(shakaConfig);

  let finalManifestUrl = config.url.replace(/(https?:\/\/[^\/]+)\/\/+/g, "$1/");
  const theToken = config.token || config.cookie;
  
  if (theToken) {
      const separator = finalManifestUrl.includes("?") ? "&" : "?";
      finalManifestUrl = finalManifestUrl + separator + theToken;
  }

  if (useProxy) {
      let proxyUrl = PROXY_BASE + encodeURIComponent(finalManifestUrl);
      if (config.userAgent) proxyUrl += `&ua=${encodeURIComponent(config.userAgent)}`;
      if (config.origin) proxyUrl += `&origin=${encodeURIComponent(config.origin)}`;
      if (config.referer) proxyUrl += `&referer=${encodeURIComponent(config.referer)}`;
      if (theToken) proxyUrl += `&cookie=${encodeURIComponent(theToken)}`;
      finalManifestUrl = proxyUrl;
  }

  await shakaPlayer.load(finalManifestUrl);
  seekToConfiguredLivePosition();
  video.controls = false;
  setupCinematicPlayer();
  updateQualityOptions();
  try {
    shakaPlayer.addEventListener("trackschanged", () => updateQualityOptions());
    shakaPlayer.addEventListener("adaptation", () => updateQualityOptions());
  } catch (_) {}
  setTimeout(() => updateQualityOptions(), 800);
  setTimeout(() => updateQualityOptions(), 2500);

  startLiveStatusTimer();
  updatePlayerUi();
  await video.play().catch(() => {});
}

/* =========================================================
   HLS ENGINE (WITH ULTIMATE FILTER)
========================================================= */

async function playHls(config, useProxy) {
  if (video.canPlayType("application/vnd.apple.mpegurl") && !useProxy && !config.token) {
    video.src = config.url;
    video.controls = false;
    setupCinematicPlayer();
    updateQualityOptions();
    startLiveStatusTimer();
    await waitForVideoReady();
    seekNativeHlsToDelayedLive();
    updatePlayerUi();
    video.addEventListener("error", () => handleStreamError(video.error));
    await video.play().catch(() => {});
    return;
  }

  if (window.shaka && shaka.Player.isBrowserSupported()) {
    shakaPlayer = new shaka.Player(video);
    shakaPlayer.configure(getShakaStreamingConfig(false));
    shakaPlayer.addEventListener("error", event => { handleStreamError(event.detail); });

    const networkingEngine = shakaPlayer.getNetworkingEngine();
    if (networkingEngine) {
        // Re-use identical filter from Dash Engine
        networkingEngine.registerRequestFilter((type, request) => {
            if (config.userAgent) request.headers['User-Agent'] = config.userAgent;
            if (config.origin) request.headers['Origin'] = config.origin;
            if (config.referer) request.headers['Referer'] = config.referer;
            if (config.token || config.cookie) request.headers['Cookie'] = config.token || config.cookie;

            request.uris = request.uris.map(uri => {
                let cleanUri = uri;
                if (cleanUri.includes('?|')) cleanUri = cleanUri.split('?|')[0];
                else if (cleanUri.includes('|')) cleanUri = cleanUri.split('|')[0];

                try {
                    const isProxied = cleanUri.includes('/api/proxy?url=');
                    let actualUrl = cleanUri;
                    let urlObj = null;
                    if (isProxied) {
                        urlObj = new URL(cleanUri, window.location.origin);
                        actualUrl = urlObj.searchParams.get('url') || cleanUri;
                    }

                    const isCDN = actualUrl.includes('hotstar.com') || actualUrl.includes('jio.com') || actualUrl.includes('.ts') || actualUrl.includes('.m3u8');
                    
                    if (isCDN) {
                        let cleanActualUrl = actualUrl.replace(/([?&])(__hdnea__|hdntl|hdnea)=[^&]*/gi, "").replace(/([?&])st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/gi, "").replace(/\?&/g, "?").replace(/[?&]$/, "");
                        cleanActualUrl = cleanActualUrl.replace(/(https?:\/\/[^\/]+)\/\/+/g, "$1/");

                        const theToken = config.token || config.cookie;
                        if (theToken) {
                            const separator = cleanActualUrl.includes("?") ? "&" : "?";
                            cleanActualUrl = cleanActualUrl + separator + theToken;
                        }

                        if (useProxy) {
                            let proxyUri = PROXY_BASE + encodeURIComponent(cleanActualUrl);
                            if (config.userAgent) proxyUri += `&ua=${encodeURIComponent(config.userAgent)}`;
                            if (config.origin) proxyUri += `&origin=${encodeURIComponent(config.origin)}`;
                            if (config.referer) proxyUri += `&referer=${encodeURIComponent(config.referer)}`;
                            if (theToken) proxyUri += `&cookie=${encodeURIComponent(theToken)}`;
                            return proxyUri;
                        } else if (isProxied) {
                            urlObj.searchParams.set('url', cleanActualUrl);
                            return urlObj.toString();
                        } else {
                            return cleanActualUrl;
                        }
                    }
                } catch (e) {}
                return cleanUri; 
            });
        });
    }

    let finalManifestUrl = config.url.replace(/(https?:\/\/[^\/]+)\/\/+/g, "$1/");
    const theToken = config.token || config.cookie;
    
    if (theToken) {
        const separator = finalManifestUrl.includes("?") ? "&" : "?";
        finalManifestUrl = finalManifestUrl + separator + theToken;
    }

    if (useProxy) {
        let proxyUrl = PROXY_BASE + encodeURIComponent(finalManifestUrl);
        if (config.userAgent) proxyUrl += `&ua=${encodeURIComponent(config.userAgent)}`;
        if (config.origin) proxyUrl += `&origin=${encodeURIComponent(config.origin)}`;
        if (config.referer) proxyUrl += `&referer=${encodeURIComponent(config.referer)}`;
        if (theToken) proxyUrl += `&cookie=${encodeURIComponent(theToken)}`;
        finalManifestUrl = proxyUrl;
    }

    await shakaPlayer.load(finalManifestUrl);
    seekToConfiguredLivePosition();
    video.controls = false;
    setupCinematicPlayer();
    updateQualityOptions();
    try {
      shakaPlayer.addEventListener("trackschanged", () => updateQualityOptions());
      shakaPlayer.addEventListener("adaptation", () => updateQualityOptions());
    } catch (_) {}
    setTimeout(() => updateQualityOptions(), 800);
    setTimeout(() => updateQualityOptions(), 2500);

    startLiveStatusTimer();
    updatePlayerUi();
    await video.play().catch(() => {});
    return;
  }
  throw new Error("This browser cannot play HLS.");
}

/* =========================================================
   NATIVE HLS SEEK & HELPERS
========================================================= */

function seekNativeHlsToDelayedLive() {
  try {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const target = Math.max(0, duration - LIVE_DELAY_SECONDS);
    video.currentTime = target;
    return true;
  } catch (error) { return false; }
}

function waitForVideoReady() {
  return new Promise(resolve => {
    if (video.readyState >= 2) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("canplay", finish);
      resolve();
    };
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("canplay", finish, { once: true });
    setTimeout(finish, 5000);
  });
}

function getLiveSeekRange() {
  if (!shakaPlayer || typeof shakaPlayer.seekRange !== "function") return null;
  try {
    const range = shakaPlayer.seekRange();
    if (!range || !Number.isFinite(range.end)) return null;
    return range;
  } catch (error) { return null; }
}

function getCurrentLiveLag() {
  const range = getLiveSeekRange();
  if (!range || !Number.isFinite(video.currentTime)) return null;
  return Math.max(0, range.end - video.currentTime);
}

function getTargetLiveTime() {
  const range = getLiveSeekRange();
  if (!range) return null;
  return Math.max(range.start, range.end - LIVE_DELAY_SECONDS);
}

function applyLiveCatchup(lag) {
  if (!video || video.paused || video.seeking) return;
  if (lag > LIVE_DELAY_SECONDS + LIVE_CATCHUP_HARD_RESYNC_SECONDS) {
    seekToConfiguredLivePosition();
    video.playbackRate = 1;
    return;
  }
  if (lag > LIVE_DELAY_SECONDS + LIVE_CATCHUP_TRIGGER_SECONDS) {
    if (video.playbackRate !== LIVE_CATCHUP_PLAYBACK_RATE) {
      video.playbackRate = LIVE_CATCHUP_PLAYBACK_RATE;
    }
    return;
  }
  if (video.playbackRate !== 1) {
    video.playbackRate = 1;
  }
}

function seekToConfiguredLivePosition() {
  const target = getTargetLiveTime();
  if (target === null) return false;
  try { shakaPlayer.seek(target); return true; } 
  catch (error) {
    try { video.currentTime = target; return true; } 
    catch (fallbackError) { return false; }
  }
}

/* =========================================================
   UI INJECTION & CONTROLS
========================================================= */

// INJECT THE TESTER M3U INPUT UI AT THE TOP AUTOMATICALLY
function injectTesterUI() {
    const headerHtml = `
      <div class="tester-header" style="background:var(--card-bg); padding:20px; border-radius:12px; margin-bottom:20px; display:flex; gap:10px; flex-wrap:wrap; border:1px solid var(--border); align-items:center;">
        <input type="text" id="m3u-url" placeholder="Paste raw GitHub .m3u or .json URL here..." style="flex:1; min-width:250px; padding:14px; border-radius:8px; border:1px solid var(--border); background:#000; color:var(--text); font-family:monospace; font-size:14px;">
        <div class="proxy-toggle-container" style="display:flex; align-items:center; gap:8px; background:rgba(255,43,131,0.1); padding:12px 18px; border-radius:8px; border:1px solid var(--accent);">
          <input type="checkbox" id="use-proxy-toggle" checked style="width:18px; height:18px; accent-color:var(--accent); cursor:pointer; margin:0;">
          <label for="use-proxy-toggle" style="font-size:14px; font-weight:bold; cursor:pointer; user-select:none; color:var(--accent); text-transform:uppercase; letter-spacing:0.5px;">Use Vercel Proxy</label>
        </div>
        <button id="btn-load-m3u" style="padding:14px 28px; background:var(--accent); color:var(--text); border:none; border-radius:8px; cursor:pointer; font-weight:800; text-transform:uppercase; transition:0.2s;">Load Playlist</button>
      </div>
    `;
    
    // Insert right before the category list
    if (categoryList && categoryList.parentElement) {
        categoryList.parentElement.insertAdjacentHTML('afterbegin', headerHtml);
        document.getElementById('btn-load-m3u').addEventListener('click', async () => {
            const url = document.getElementById("m3u-url").value.trim();
            if (!url) return;
            try {
                const useProxy = document.getElementById("use-proxy-toggle").checked;
                let fetchUrl = url;
                if (useProxy && url.includes("premiumplugx.com")) {
                    fetchUrl = PROXY_BASE + encodeURIComponent(url);
                }
                const res = await fetch(fetchUrl);
                if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
                const text = await res.text();
                
                const parsedChannels = parseUniversalM3U(text);
                if(parsedChannels.length > 0) {
                    parsedChannels.forEach(c => c.isM3u = true); // Flag so live fetcher doesn't override
                    applyChannelList(parsedChannels, "Custom M3U");
                    alert("Playlist Loaded Successfully!");
                } else {
                    alert("No channels found in playlist.");
                }
            } catch (err) {
                alert(`Error loading playlist: ${err.message}`);
            }
        });
    }
}

function injectCinematicPlayerStyles() {
  if (document.getElementById("gmax-cinematic-player-styles")) return;
  const style = document.createElement("style");
  style.id = "gmax-cinematic-player-styles";
  style.textContent = `
    .gmax-player-shell { position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 280px; background: #000; overflow: hidden; border-radius: 18px; box-shadow: 0 30px 90px rgba(0,0,0,.55); isolation: isolate; user-select: none; }
    .gmax-player-shell video { position: absolute; inset: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; background: #000; }
    .gmax-player-gradient { position: absolute; inset: auto 0 0; height: 210px; pointer-events: none; background: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.08) 20%, rgba(0,0,0,.82) 100%); z-index: 3; transition: opacity .25s ease;}
    .gmax-player-top { position: absolute; top: 0; left: 0; right: 0; padding: 20px; display: flex; align-items: flex-start; gap: 12px; z-index: 6; background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); pointer-events: none; }
    .gmax-now-playing { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .gmax-channel-art { width: 54px; height: 54px; border-radius: 12px; object-fit: contain; background: rgba(255,255,255,.08); padding: 5px; border: 1px solid rgba(255,255,255,.1); flex: 0 0 auto; }
    .gmax-now-copy { min-width: 0; }
    .gmax-now-label { font: 800 10px/1 system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #ff2b83; margin-bottom: 6px; }
    .gmax-now-title { color: #fff; font: 800 clamp(15px, 2vw, 22px)/1.2 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: min(55vw, 520px); }
    .gmax-now-meta { color: rgba(255,255,255,.65); font: 500 11px/1.3 system-ui, sans-serif; margin-top: 4px; }
    .gmax-live-badge { margin-left: auto; pointer-events: auto; display: inline-flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 999px; color: #fff; background: rgba(229,9,20,.95); font: 900 10px/1 system-ui, sans-serif; letter-spacing: .08em; box-shadow: 0 8px 28px rgba(229,9,20,.35); }
    .gmax-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 5px rgba(255,255,255,.08); }
    .gmax-reconnect-overlay { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, 0.85); border: 1px solid rgba(255, 152, 0, 0.3); padding: 6px 14px; border-radius: 20px; color: #ff9800; font: 600 13px/1 system-ui, sans-serif; display: flex; align-items: center; gap: 8px; z-index: 50; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    .gmax-reconnect-spinner { width: 14px; height: 14px; border: 2px solid rgba(255, 152, 0, 0.3); border-top-color: #ff9800; border-radius: 50%; animation: gmaxSpin 0.8s linear infinite; }
    .gmax-player-controls { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; display: flex; align-items: center; gap: 9px; padding: 70px 18px 16px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.92)); transition: opacity .2s ease, transform .2s ease; }
    .gmax-player-shell.gmax-controls-hidden .gmax-player-controls, .gmax-player-shell.gmax-controls-hidden .gmax-player-top, .gmax-player-shell.gmax-controls-hidden .gmax-player-gradient { opacity: 0; pointer-events: none; }
    .gmax-player-button { min-width: 38px; height: 38px; padding: 0 8px; border: 0; border-radius: 11px; display: grid; place-items: center; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; font: 700 15px/1 system-ui, sans-serif; transition: .15s ease; flex: 0 0 auto; }
    #gmax-aspect-btn { width: auto; padding: 0 12px; font-size: 13px; }
    .gmax-player-button:hover { background: rgba(255,43,131,.28); transform: translateY(-1px); }
    .gmax-player-spacer { flex: 1; }
    .gmax-live-lag { color: rgba(255,255,255,.88); font: 700 12px/1 system-ui, sans-serif; white-space: nowrap; }
    .gmax-go-live { border: 1px solid rgba(255,43,131,.5); background: rgba(255,43,131,.12); color: #fff; padding: 9px 12px; border-radius: 10px; font: 800 10px/1 system-ui, sans-serif; letter-spacing: .06em; cursor: pointer; }
    .gmax-go-live:hover { background: rgba(255,43,131,.28); }
    .gmax-volume { width: 86px; accent-color: #ff2b83; cursor: pointer; }
    .gmax-quality-wrap { position: relative; }
    .gmax-quality-menu { position: absolute; right: 0; bottom: 50px; width: 180px; max-height: 280px; overflow-y: auto; padding: 7px; display: none; background: rgba(15,15,18,.97); border: 1px solid rgba(255,255,255,.11); border-radius: 14px; box-shadow: 0 20px 60px rgba(0,0,0,.65); backdrop-filter: blur(18px); z-index: 30; }
    .gmax-quality-menu.open { display: block; }
    .gmax-quality-item { display: block; width: 100%; border: 0; border-radius: 9px; background: transparent; color: rgba(255,255,255,.76); text-align: left; padding: 10px 11px; cursor: pointer; font: 700 12px/1 system-ui, sans-serif; }
    .gmax-quality-item:hover, .gmax-quality-item.active { color: #fff; background: rgba(255,43,131,.16); }
    .gmax-spinner { position: absolute; left: 50%; top: 50%; width: 46px; height: 46px; margin: -23px 0 0 -23px; border: 3px solid rgba(255,255,255,.18); border-top-color: #ff2b83; border-radius: 50%; animation: gmaxSpin .8s linear infinite; z-index: 10; }
    @keyframes gmaxSpin { to { transform: rotate(360deg); } }
    .gmax-player-error { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 10px; text-align: center; padding: 24px; background: radial-gradient(circle at center, rgba(60,10,35,.75), rgba(0,0,0,.96)); color: #fff; z-index: 20; }
    .gmax-player-error.open { display: flex; }
    .gmax-error-title { font: 800 20px/1.2 system-ui, sans-serif; }
    .gmax-error-message { max-width: 520px; color: rgba(255,255,255,.6); font: 500 12px/1.5 system-ui, sans-serif; }
    .gmax-retry-button { margin-top: 7px; border: 0; border-radius: 10px; background: #ff2b83; color: #fff; padding: 11px 16px; cursor: pointer; font: 800 11px/1 system-ui, sans-serif; }
    .gmax-player-info { margin-top: 16px; display: grid; gap: 16px; }
    .gmax-player-info-main { display: flex; align-items: center; gap: 13px; }
    .gmax-info-logo { width: 52px; height: 52px; border-radius: 12px; object-fit: contain; background: rgba(255,255,255,.05); padding: 5px; }
    .gmax-info-label { color: #ff2b83; font: 900 10px/1 system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 5px; }
    .gmax-info-title { color: #fff; font: 900 20px/1.2 system-ui, sans-serif; }
    .gmax-info-meta { margin-top: 4px; color: rgba(255,255,255,.5); font: 500 12px/1.3 system-ui, sans-serif; }
    .gmax-related-title { color: #fff; font: 900 17px/1.2 system-ui, sans-serif; margin-bottom: 9px; }
    .gmax-related-row { display: flex; gap: 11px; overflow-x: auto; scrollbar-width: thin; padding-bottom: 4px; }
    .gmax-related-card { flex: 0 0 155px; min-height: 92px; border: 1px solid rgba(255,255,255,.07); background: linear-gradient(145deg, rgba(255,255,255,.06), rgba(255,255,255,.025)); border-radius: 12px; overflow: hidden; cursor: pointer; transition: .18s ease; }
    .gmax-related-card:hover { transform: translateY(-2px); border-color: rgba(255,43,131,.35); }
    .gmax-related-image { width: 100%; height: 55px; object-fit: contain; background: #0b0b0e; padding: 8px; }
    .gmax-related-name { padding: 7px 9px; color: rgba(255,255,255,.9); font: 800 11px/1.2 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media (max-width: 700px) {
      .gmax-player-shell { border-radius: 10px; min-height: 0; aspect-ratio: 16 / 10; max-height: min(68vw, 72vh); position: relative; overflow: hidden; }
      .gmax-player-shell video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
      .gmax-player-top { padding: 8px 10px; z-index: 10; }
      .gmax-channel-art { width: 36px; height: 36px; border-radius: 8px; }
      .gmax-now-title { max-width: 42vw; font-size: 14px !important; }
      .gmax-now-meta { display: none; }
      .gmax-live-badge { padding: 6px 8px; font-size: 9px !important; }
      .gmax-player-controls { gap: 4px; padding: 28px 6px calc(10px + env(safe-area-inset-bottom, 0px)); flex-wrap: wrap; justify-content: center; align-items: center; z-index: 12; background: linear-gradient(to top, rgba(0,0,0,.85) 0%, transparent 100%); pointer-events: auto; }
      .gmax-volume { display: none; }
      .gmax-live-lag { display: none; }
      .gmax-player-button { width: 40px; min-width: 40px; height: 40px; font-size: 14px; touch-action: manipulation; }
      .gmax-go-live { padding: 8px 10px; font-size: 10px; }
      .gmax-related-card { flex-basis: 120px; }
    }
    @media (max-width: 480px) {
      .gmax-player-shell { aspect-ratio: 16 / 10; max-height: min(68vw, 72vh); border-radius: 8px; }
      .gmax-player-controls { padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px)); }
    }
  `;
  document.head.appendChild(style);
}

function setupCinematicPlayer() {
  injectCinematicPlayerStyles();
  let shell = video.closest(".gmax-player-shell");
  if (!shell) {
    const parent = video.parentElement;
    if (!parent) return;
    shell = document.createElement("div");
    shell.className = "gmax-player-shell";
    parent.insertBefore(shell, video);
    shell.appendChild(video);
  }
  playerUiShell = shell;
  if (!playerControls) createPlayerControls(shell);
  updatePlayerIdentity();
  buildRelatedChannels();
  hidePlayerErrorOverlay();
}

function createPlayerControls(shell) {
  const gradient = document.createElement("div");
  gradient.className = "gmax-player-gradient";
  shell.appendChild(gradient);

  const top = document.createElement("div");
  top.className = "gmax-player-top";
  top.innerHTML = `
    <div class="gmax-now-playing">
      <img class="gmax-channel-art" data-role="channel-art" alt="">
      <div class="gmax-now-copy">
        <div class="gmax-now-label">NOW PLAYING</div>
        <div class="gmax-now-title" data-role="channel-title">Live TV</div>
        <div class="gmax-now-meta" data-role="channel-meta">JIO TV</div>
      </div>
    </div>
    <div class="gmax-live-badge" title="Live"><span class="gmax-live-dot"></span>LIVE</div>
  `;
  shell.appendChild(top);

  const reconnectOverlay = document.createElement("div");
  reconnectOverlay.className = "gmax-reconnect-overlay";
  reconnectOverlay.dataset.role = "reconnect-overlay";
  reconnectOverlay.style.display = "none";
  reconnectOverlay.innerHTML = `<span class="gmax-reconnect-spinner"></span><span data-role="reconnect-text">Reconnecting...</span>`;
  shell.appendChild(reconnectOverlay);

  const spinner = document.createElement("div");
  spinner.className = "gmax-spinner";
  spinner.dataset.role = "spinner";
  spinner.style.display = "none";
  shell.appendChild(spinner);

  const errorOverlay = document.createElement("div");
  errorOverlay.className = "gmax-player-error";
  errorOverlay.dataset.role = "error";
  errorOverlay.innerHTML = `
    <div class="gmax-error-title">Playback problem</div>
    <div class="gmax-error-message" data-role="error-message">The channel could not be played.</div>
    <button class="gmax-retry-button" data-action="retry" type="button">RECONNECT</button>
  `;
  shell.appendChild(errorOverlay);

  const controls = document.createElement("div");
  controls.className = "gmax-player-controls";
  controls.innerHTML = `
    <button class="gmax-player-button" data-action="play" type="button" title="Play / Pause">▶</button>
    <button class="gmax-player-button" data-action="mute" type="button" title="Mute">🔊</button>
    <input class="gmax-volume" data-action="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
    <span class="gmax-live-lag" data-role="live-lag">LIVE • -15s</span>
    <button class="gmax-go-live" data-action="go-live" type="button" title="Return to the live safety position">GO LIVE</button>
    <span class="gmax-player-spacer"></span>
    <div class="gmax-quality-wrap">
      <button class="gmax-player-button" data-action="quality" type="button" title="Quality">⚙</button>
      <div class="gmax-quality-menu" data-role="quality-menu"></div>
    </div>
    <button class="gmax-player-button" data-action="aspect" type="button" title="Fit / Fill / Stretch" id="gmax-aspect-btn">Fit ⛶</button>
    <button class="gmax-player-button" data-action="fullscreen" type="button" title="Fullscreen">⛶</button>
  `;
  shell.appendChild(controls);

  playerControls = controls;
  qualityMenu = controls.querySelector('[data-role="quality-menu"]');

  const playButton = controls.querySelector('[data-action="play"]');
  const muteButton = controls.querySelector('[data-action="mute"]');
  const volumeInput = controls.querySelector('[data-action="volume"]');
  const qualityButton = controls.querySelector('[data-action="quality"]');
  const goLiveButton = controls.querySelector('[data-action="go-live"]');
  const fullscreenButton = controls.querySelector('[data-action="fullscreen"]');
  const retryButton = errorOverlay.querySelector('[data-action="retry"]');
  const aspectButton = controls.querySelector('[data-action="aspect"]');

  const aspectModes = [
    { fit: "contain", label: "Fit ⛶", title: "Normal / Fit" },
    { fit: "cover", label: "Zoom ⛶", title: "Fill / Zoom" },
    { fit: "fill", label: "Stretch ⛶", title: "Stretch" },
  ];
  let currentAspect = 0;
  video.style.objectFit = aspectModes[0].fit;
  if (aspectButton) { aspectButton.textContent = aspectModes[0].label; aspectButton.title = aspectModes[0].title; }

  aspectButton.addEventListener("click", (event) => {
    event.stopPropagation();
    currentAspect = (currentAspect + 1) % aspectModes.length;
    const mode = aspectModes[currentAspect];
    video.style.objectFit = mode.fit;
    aspectButton.textContent = mode.label;
    aspectButton.title = mode.title;
  });

  playButton.addEventListener("click", async event => { event.stopPropagation(); if (video.paused) { await video.play().catch(() => {}); } else { video.pause(); } updatePlayerUi(); });
  muteButton.addEventListener("click", event => { event.stopPropagation(); video.muted = !video.muted; updatePlayerUi(); });
  volumeInput.addEventListener("input", event => { event.stopPropagation(); video.volume = Number(volumeInput.value); video.muted = video.volume === 0; updatePlayerUi(); });
  goLiveButton.addEventListener("click", event => { event.stopPropagation(); if (seekToConfiguredLivePosition()) { video.playbackRate = 1; video.play().catch(() => {}); } updatePlayerUi(); });
  qualityButton.addEventListener("click", event => { event.stopPropagation(); qualityMenu.classList.toggle("open"); });
  fullscreenButton.addEventListener("click", event => { event.stopPropagation(); toggleFullscreen(); });
  retryButton.addEventListener("click", event => { event.stopPropagation(); retryCurrentChannel(); });
  shell.addEventListener("dblclick", event => { if (event.target.closest(".gmax-player-controls")) return; toggleFullscreen(); });
  shell.addEventListener("click", event => { if (event.target !== video) return; if (video.paused) { video.play().catch(() => {}); } else { video.pause(); } });

  ["play", "pause", "timeupdate", "loadedmetadata", "volumechange", "durationchange", "progress", "canplay"].forEach(eventName => { video.addEventListener(eventName, updatePlayerUi); });
  ["playing", "canplay"].forEach(eventName => { video.addEventListener(eventName, () => { reconnectInFlight = false; showPlayerLoading(false); hidePlayerErrorOverlay(); clearTimeout(playbackWatchdogTimer); }); });

  shell.addEventListener("mousemove", () => { showPlayerControlsTemporarily(); });
  shell.addEventListener("touchstart", () => { showPlayerControlsTemporarily(); }, { passive: true });
  document.addEventListener("click", event => { if (!qualityMenu) return; if (!event.target.closest(".gmax-quality-wrap")) qualityMenu.classList.remove("open"); });
  window.addEventListener("keydown", handlePlayerKeyboard);
}

function updatePlayerIdentity() {
  if (!playerUiShell || !currentChannel) return;
  const art = playerUiShell.querySelector('[data-role="channel-art"]');
  const title = playerUiShell.querySelector('[data-role="channel-title"]');
  const meta = playerUiShell.querySelector('[data-role="channel-meta"]');
  const logo = getChannelLogo(currentChannel);
  if (art) { if (logo) { art.src = logo; art.style.display = "block"; } else { art.removeAttribute("src"); art.style.display = "none"; } }
  if (title) title.textContent = currentChannel.name || "Live TV";
  if (meta) meta.textContent = ["JIO TV", currentChannel.country || "INDIA", getCategory(currentChannel)].filter(Boolean).join(" • ");
}

function buildRelatedChannels() {
  if (!playerSection || !currentChannel) return;
  let info = playerSection.querySelector(".gmax-player-info");
  if (!info) { info = document.createElement("div"); info.className = "gmax-player-info"; playerSection.appendChild(info); }
  const logo = getChannelLogo(currentChannel);
  const related = allChannels.filter(channel => getChannelId(channel) !== getChannelId(currentChannel)).filter(channel => normalize(getCategory(channel)) === normalize(getCategory(currentChannel))).slice(0, 12);
  info.innerHTML = `
    <div class="gmax-player-info-main">
      ${logo ? `<img class="gmax-info-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer">` : ""}
      <div>
        <div class="gmax-info-label">NOW PLAYING</div>
        <div class="gmax-info-title">${escapeHtml(currentChannel.name || "Live TV")}</div>
        <div class="gmax-info-meta">${escapeHtml(["JIO TV", currentChannel.country || "INDIA", getCategory(currentChannel)].filter(Boolean).join(" • "))}</div>
      </div>
    </div>
    ${related.length ? `<div><div class="gmax-related-title">RELATED CHANNELS</div><div class="gmax-related-row">${related.map(channel => { const channelLogo = getChannelLogo(channel); return `<div class="gmax-related-card" data-related-channel="${escapeHtml(getChannelId(channel))}">${channelLogo ? `<img class="gmax-related-image" src="${escapeHtml(channelLogo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="gmax-related-image" style="display:grid;place-items:center;color:#777;font-weight:800;">TV</div>`}<div class="gmax-related-name">${escapeHtml(channel.name || "Channel")}</div></div>`; }).join("")}</div></div>` : ""}
  `;
  info.querySelectorAll("[data-related-channel]").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.relatedChannel;
      const channel = allChannels.find(item => getChannelId(item) === String(id));
      if (channel) openChannel(channel, 0);
    });
  });
}

function showPlayerControlsTemporarily() {
  if (!playerUiShell) return;
  playerUiShell.classList.remove("gmax-controls-hidden");
  clearTimeout(playerUiTimer);
  playerUiTimer = setTimeout(() => { if (!video.paused) playerUiShell.classList.add("gmax-controls-hidden"); }, 2800);
}

function autoEnterLandscapeOnMobile() {
  if (!playerUiShell || !window.matchMedia("(max-width: 700px) and (pointer: coarse)").matches) return;
  try {
    if (document.fullscreenElement) { if (screen.orientation && screen.orientation.lock) { screen.orientation.lock("landscape").catch(() => {}); } return; }
    if (playerUiShell.requestFullscreen) { playerUiShell.requestFullscreen().then(() => { if (screen.orientation && screen.orientation.lock) { screen.orientation.lock("landscape").catch(() => {}); } }).catch(() => {}); }
  } catch (_) {}
}

function toggleFullscreen() {
  if (!playerUiShell) return;
  if (document.fullscreenElement) { document.exitFullscreen().then(() => { if (screen.orientation && screen.orientation.unlock) { screen.orientation.unlock().catch(() => {}); } }).catch(() => {}); } 
  else { if (playerUiShell.requestFullscreen) { playerUiShell.requestFullscreen().then(() => { if (screen.orientation && screen.orientation.lock) { screen.orientation.lock("landscape").catch(() => {}); } }).catch(() => {}); } }
}

function handlePlayerKeyboard(event) {
  if (!playerUiShell || playerSection.classList.contains("hidden")) return;
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  const key = String(event.key).toLowerCase();
  if (key === " ") { event.preventDefault(); if (video.paused) { video.play().catch(() => {}); } else { video.pause(); } updatePlayerUi(); }
  if (key === "m") { video.muted = !video.muted; updatePlayerUi(); }
  if (key === "f") { toggleFullscreen(); }
  if (key === "g") { seekToConfiguredLivePosition(); }
  if (key === "arrowup") { event.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); video.muted = false; updatePlayerUi(); }
  if (key === "arrowdown") { event.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); updatePlayerUi(); }
  showPlayerControlsTemporarily();
}

function showPlayerSpinner() { if (playerLoading) playerLoading.classList.remove("hidden"); if (playerUiShell) { const spinner = playerUiShell.querySelector('[data-role="spinner"]'); if (spinner) spinner.style.display = "none"; } }
function hidePlayerSpinner() { if (playerUiShell) { const spinner = playerUiShell.querySelector('[data-role="spinner"]'); if (spinner) spinner.style.display = "none"; } }

function showPlayerErrorOverlay(message) {
  if (!playerUiShell) return;
  const overlay = playerUiShell.querySelector('[data-role="error"]');
  if (!overlay) return;
  const messageElement = overlay.querySelector('[data-role="error-message"]');
  if (messageElement) messageElement.textContent = message || "The channel could not be played.";
  overlay.classList.add("open");
}

function hidePlayerErrorOverlay() {
  if (!playerUiShell) return;
  const overlay = playerUiShell.querySelector('[data-role="error"]');
  if (overlay) overlay.classList.remove("open");
}

async function retryCurrentChannel() {
  if (isPlayerRetrying || !currentChannel) return;
  isPlayerRetrying = true; showPlayerLoading(true); clearPlayerError();
  try { await openChannel(currentChannel, 0); } finally { isPlayerRetrying = false; }
}

function startLiveStatusTimer() { stopLiveStatusTimer(); liveStatusTimer = setInterval(() => { updateLiveStatus(); }, 1000); updateLiveStatus(); }
function stopLiveStatusTimer() { if (liveStatusTimer) { clearInterval(liveStatusTimer); liveStatusTimer = null; } }

function updateLiveStatus() {
  if (!playerControls) return;
  const lagElement = playerControls.querySelector('[data-role="live-lag"]');
  if (!lagElement) return;
  const lag = getCurrentLiveLag();
  if (lag === null) { lagElement.textContent = `LIVE • -${LIVE_DELAY_SECONDS}s`; return; }
  applyLiveCatchup(lag);
  const rounded = Math.max(0, Math.round(lag));
  if (rounded > 3600) { lagElement.textContent = `LIVE • ...`; } else { lagElement.textContent = `LIVE • -${rounded}s`; }
}

function formatBandwidthMbps(bw) {
  const n = Number(bw) || 0;
  if (n <= 0) return "";
  const mbps = n / 1e6;
  if (mbps >= 10) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${Math.round(n / 1e3)} Kbps`;
}

function updateQualityOptions() {
  if (!qualityMenu) return;
  if (!shakaPlayer || typeof shakaPlayer.getVariantTracks !== "function") { qualityMenu.innerHTML = `<button class="gmax-quality-item active" type="button">Auto</button>`; return; }
  let tracks = shakaPlayer.getVariantTracks().filter((track) => { if (!track) return false; const h = Number(track.height) || 0; const bw = Number(track.bandwidth) || 0; return h > 0 || bw > 0; });
  const seen = new Set();
  const uniqueTracks = [];
  for (const track of tracks) {
    const h = Number(track.height) || 0;
    const bw = Number(track.bandwidth) || 0;
    const key = `${h}|${Math.round(bw / 50000)}`;
    if (seen.has(key)) continue;
    seen.add(key); uniqueTracks.push(track);
  }
  uniqueTracks.sort((a, b) => { const dh = (Number(b.height) || 0) - (Number(a.height) || 0); if (dh !== 0) return dh; return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0); });
  qualityMenu.innerHTML = `<div style="padding:6px 10px 4px;font:700 11px/1 system-ui;opacity:.55;letter-spacing:.04em;">Resolution</div><button class="gmax-quality-item active" data-quality="auto" type="button">Auto</button>${uniqueTracks.map((track) => { const h = Number(track.height) || 0; const label = h > 0 ? `${h}p` : "Video"; const bwLabel = formatBandwidthMbps(track.bandwidth); const text = bwLabel ? `${label} (${bwLabel})` : label; return `<button class="gmax-quality-item" data-quality-track="${track.id}" type="button">${text}</button>`; }).join("")}`;
  qualityMenu.querySelectorAll("[data-quality]").forEach(button => { button.addEventListener("click", event => { event.stopPropagation(); if (button.dataset.quality === "auto") { shakaPlayer.configure({ abr: { enabled: true } }); setActiveQualityButton(button); qualityMenu.classList.remove("open"); return; } }); });
  qualityMenu.querySelectorAll("[data-quality-track]").forEach(button => { button.addEventListener("click", event => { event.stopPropagation(); const trackId = Number(button.dataset.qualityTrack); const selected = tracks.find(track => Number(track.id) === trackId); if (!selected) return; shakaPlayer.configure({ abr: { enabled: false } }); shakaPlayer.selectVariantTrack(selected, true, 0); setActiveQualityButton(button); qualityMenu.classList.remove("open"); }); });
}

function setActiveQualityButton(activeButton) {
  if (!qualityMenu) return;
  qualityMenu.querySelectorAll(".gmax-quality-item").forEach(item => { item.classList.toggle("active", item === activeButton); });
}

function updatePlayerUi() {
  if (!playerControls) return;
  const playButton = playerControls.querySelector('[data-action="play"]');
  const muteButton = playerControls.querySelector('[data-action="mute"]');
  const volumeInput = playerControls.querySelector('[data-action="volume"]');
  if (playButton) playButton.textContent = video.paused ? "▶" : "Ⅱ";
  if (muteButton) muteButton.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  if (volumeInput) volumeInput.value = String(video.volume);
  updateLiveStatus();
}

function ensureInfiniteScrollObserver() {
  if (infiniteScrollObserver) return;
  let sentinel = document.getElementById("gmax-infinite-scroll-sentinel");
  if (!sentinel) { sentinel = document.createElement("div"); sentinel.id = "gmax-infinite-scroll-sentinel"; sentinel.style.height = "1px"; sentinel.style.width = "100%"; channelsGrid.insertAdjacentElement("afterend", sentinel); }
  infiniteScrollObserver = new IntersectionObserver(entries => { const entry = entries[0]; if (!entry.isIntersecting || infiniteScrollBusy || visibleCount >= filteredChannels.length) return; infiniteScrollBusy = true; visibleCount += CHANNELS_PER_PAGE; renderChannels(); requestAnimationFrame(() => { infiniteScrollBusy = false; }); }, { root: null, rootMargin: "1000px 0px", threshold: 0 });
  infiniteScrollObserver.observe(sentinel);
}

function hideLoadMore() {
  if (loadMore) { loadMore.classList.add("hidden"); loadMore.style.display = "none"; }
  if (loadMoreButton) loadMoreButton.style.display = "none";
}

if(searchInput) {
  searchInput.addEventListener("input", () => {
    visibleCount = CHANNELS_PER_PAGE;
    if (infiniteScrollObserver) { infiniteScrollObserver.disconnect(); infiniteScrollObserver = null; }
    const oldSentinel = document.getElementById("gmax-infinite-scroll-sentinel");
    if (oldSentinel) oldSentinel.remove();
    applyFilters();
  });
}

function getRequestedChannelId() { return new URLSearchParams(window.location.search).get("id"); }
function openRequestedChannel() { const id = getRequestedChannelId(); if (!id) return; const channel = allChannels.find(item => String(item.id ?? item.tvgId) === String(id)); if (!channel) return; setTimeout(() => { openChannel(channel, 0); }, 200); }

if(closePlayerButton) {
  closePlayerButton.addEventListener("click", async () => {
    await destroyPlayer();
    video.pause(); video.removeAttribute("src"); video.load();
    if(playerSection) playerSection.classList.add("hidden");
    if(playerEmpty) playerEmpty.classList.remove("hidden");
    clearPlayerError();
    currentChannel = null; lastStreamUrl = ""; lastStreamType = "";
    const info = playerSection.querySelector(".gmax-player-info");
    if (info) info.remove();
    const cleanUrl = window.location.pathname;
    history.replaceState(null, "", cleanUrl);
  });
}

/* =========================================================
   RECENTLY WATCHED SLIDER
========================================================= */

function renderRecentSlider() {
  const section = document.getElementById("recent-section");
  const slider = document.getElementById("recent-slider");
  if (!section || !slider || !allChannels.length) return;

  const items = recentIds.map((id) => allChannels.find((c) => String(c.id || c.tvgId || c.kid || "") === String(id))).filter(Boolean).slice(0, RECENT_MAX);

  if (!items.length) { section.classList.add("hidden"); slider.innerHTML = ""; return; }

  section.classList.remove("hidden");
  slider.innerHTML = items.map((ch) => {
      const logo = getChannelLogo(ch);
      const name = escapeHtml(ch.name || "Channel");
      const id = escapeHtml(String(ch.id || ch.kid || ""));
      return `
        <button type="button" class="recent-card" data-recent-id="${id}" title="${name}">
          ${logo ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">` : `<div class="channel-fallback" style="display:flex;width:56px;height:56px;margin:0 auto 6px;border-radius:10px;align-items:center;justify-content:center;background:rgba(255,255,255,.08);font-size:12px;">TV</div>`}
          <div class="recent-card-name">${name}</div>
        </button>
      `;
    }).join("");

  slider.querySelectorAll("[data-recent-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-recent-id");
      const ch = allChannels.find((c) => String(c.id || c.tvgId || c.kid || "") === String(id));
      if (ch) openChannel(ch, 0);
    });
  });
}

function bindRecentNav() {
  const slider = document.getElementById("recent-slider");
  const prev = document.getElementById("recent-prev");
  const next = document.getElementById("recent-next");
  if (!slider) return;
  const step = () => Math.min(slider.clientWidth * 0.7, 320);
  if (prev) prev.addEventListener("click", () => slider.scrollBy({ left: -step(), behavior: "smooth" }));
  if (next) next.addEventListener("click", () => slider.scrollBy({ left: step(), behavior: "smooth" }));
}

/* =========================================================
   LOAD CHANNELS
========================================================= */

function applyChannelList(data, sourceLabel) {
  if (!Array.isArray(data)) throw new Error(`${sourceLabel} did not return an array.`);
  const channelMap = new Map();

  data.forEach((ch) => {
    if (!ch || (!ch.name && !ch.stream_url && !ch.url)) return;
    const name = decodeHtmlEntities(ch.name || "");
    const category = normalizeCategory(ch.category || ch.group || "", name);
    const channelId = getChannelId(ch) || name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const streamUrl = ch.stream_url || ch.url || "";
    
    const sourceData = {
      stream_url: streamUrl, cookie: ch.cookie || "", key_id: ch.key_id || "",
      key: ch.key || "", m3u: ch.source_m3u || "", token: ch.token || "", 
      origin: ch.origin || "", referer: ch.referer || "", userAgent: ch.userAgent || "", 
      licenseUrl: ch.licenseUrl || ""
    };

    if (channelMap.has(channelId)) {
      const existing = channelMap.get(channelId);
      if (!existing.sources) existing.sources = [{ stream_url: existing.stream_url || existing.url || "", cookie: existing.cookie || "", key_id: existing.key_id || "", key: existing.key || "", m3u: existing.source_m3u || "" }];
      const isDuplicateUrl = existing.sources.some((s) => s.stream_url === streamUrl);
      if (!isDuplicateUrl && streamUrl) {
        if (String(sourceData.m3u).toLowerCase().includes("jtv3.m3u")) existing.sources.unshift(sourceData);
        else existing.sources.push(sourceData);
      }
    } else {
      const newCh = { ...ch, name, category };
      if (!newCh.sources && streamUrl) newCh.sources = [sourceData];
      channelMap.set(channelId, newCh);
    }
  });

  allChannels = Array.from(channelMap.values());
  allChannels.sort((a, b) => {
    const aHasJtv7 = a.sources && a.sources.some(s => String(s.m3u).toLowerCase().includes("jtvplus7.m3u"));
    const bHasJtv7 = b.sources && b.sources.some(s => String(s.m3u).toLowerCase().includes("jtvplus7.m3u"));
    if (aHasJtv7 && !bHasJtv7) return -1;
    if (!aHasJtv7 && bHasJtv7) return 1;
    const oa = Number(a.sort_order); const ob = Number(b.sort_order);
    if (Number.isFinite(oa) && Number.isFinite(ob) && oa !== ob) return oa - ob;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  filteredChannels = [...allChannels];
  if (channelCount) channelCount.textContent = `${allChannels.length.toLocaleString()} channels`;
  if (resultsCount) resultsCount.textContent = `${allChannels.length.toLocaleString()} channels`;

  buildCategories();
  applyFilters();
  renderRecentSlider();
  bindRecentNav();
  openRequestedChannel();
}

async function fetchLiveChannels() {
  if (!jioAuth || !jioAuth.ssotoken) return null;
  try {
    const params = new URLSearchParams({ ssotoken: jioAuth.ssotoken, uniqueid: jioAuth.uniqueid || "", crmid: jioAuth.crmid || "" });
    const res = await fetch(`${API_BASE}/get_channels?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.channels) || !data.channels.length) return null;
    return data.channels;
  } catch (e) { return null; }
}

async function loadChannels() {
  try {
    const liveChannels = await fetchLiveChannels();
    if (liveChannels) { applyChannelList(liveChannels, "Jio live catalog"); return; }
    const response = await fetch(CHANNELS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`channels.json returned HTTP ${response.status}`);
    const data = await response.json();
    applyChannelList(data, "channels.json");
  } catch (error) {
    if(channelCount) channelCount.textContent = "Failed to load";
    if(resultsCount) resultsCount.textContent = "0 channels";
    if(channelsGrid) channelsGrid.innerHTML = `<div class="empty-grid"><strong>Failed to load Jio TV channels</strong><br><br><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span></div>`;
  }
}

/* =========================================================
   START
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  injectTesterUI(); // Automatically inserts the M3U Loading UI
  hideLoadMore();
  loadChannels();
});
