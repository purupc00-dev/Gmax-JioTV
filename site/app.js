"use strict";

/* =========================================================
   CONFIG & SERVER FALLBACK TIERS
========================================================= */

const CHANNELS_URL = "./channels.json";
const CHANNELS_PER_PAGE = 60;
const LIVE_DELAY_SECONDS = 15;
const BUFFERING_GOAL_SECONDS = 25;
const REBUFFERING_GOAL_SECONDS = 6;
const BUFFER_BEHIND_SECONDS = 45;

// Primary server rotation: JioTV+ (server 6 / pllive) prioritized
const JIO_SERVERS = [
  "https://jiotvpllive.cdn.jio.com",
  "https://jiotvmblive.cdn.jio.com",
  "https://nw18live.cdn.jio.com"
];

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
let currentServerIndex = 0;

/* =========================================================
   FAVORITES
========================================================= */

const favorites = new Set(
  JSON.parse(localStorage.getItem("gmax-jiotv-favorites") || "[]")
);

/* =========================================================
   DOM ELEMENTS
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

/* =========================================================
   STREAM SANITIZATION & DYNAMIC SERVERS
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidHexKey(key) {
  return typeof key === "string" && /^[0-9a-fA-F]{32}$/.test(key);
}

function transformToDynamicServer(rawUrl, serverIndex = 0) {
  if (!rawUrl) return "";
  let cleanUrl = rawUrl.split("?")[0].trim();
  
  // Replace static CDN hosts with dynamic tier
  const targetServer = JIO_SERVERS[serverIndex % JIO_SERVERS.length];
  cleanUrl = cleanUrl.replace(/https?:\/\/[a-zA-Z0-9.-]+\.cdn\.jio\.com/g, targetServer);
  
  // Standardize double slashes
  return cleanUrl.replace(/([^:]\/)\/+/g, "$1");
}

function streamType(url) {
  const normalized = String(url || "").toLowerCase();
  if (normalized.includes(".mpd")) return "dash";
  if (normalized.includes(".m3u8")) return "hls";
  return "unknown";
}

function getStreamUrl(channel, serverIndex = 0) {
  const base = channel?.stream_url || channel?.url || "";
  return transformToDynamicServer(base, serverIndex);
}

function getCategory(channel) {
  return channel?.category || channel?.group || channel?.groupTitle || "Entertainment";
}

function getChannelLogo(channel) {
  return channel?.logo || channel?.tvg_logo || "";
}

function getChannelId(channel) {
  return String(channel?.id || channel?.tvgId || channel?.["tvg-id"] || "");
}

function saveFavorites() {
  localStorage.setItem("gmax-jiotv-favorites", JSON.stringify([...favorites]));
}

/* =========================================================
   LIVE LAG & TIME ENGINE
========================================================= */

function getLiveSeekRange() {
  if (!shakaPlayer || typeof shakaPlayer.seekRange !== "function") return null;
  try {
    const range = shakaPlayer.seekRange();
    return range && Number.isFinite(range.end) ? range : null;
  } catch (e) {
    return null;
  }
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

function seekToConfiguredLivePosition() {
  const target = getTargetLiveTime();
  if (target === null) return false;
  try {
    shakaPlayer.seek(target);
    return true;
  } catch (error) {
    try {
      video.currentTime = target;
      return true;
    } catch (e) {
      return false;
    }
  }
}

/* =========================================================
   GRID & FAVORITES RENDERING
========================================================= */

function toggleFavorite(channelId) {
  const key = String(channelId);
  favorites.has(key) ? favorites.delete(key) : favorites.add(key);
  saveFavorites();
  renderChannels();
}

function buildCategories() {
  const categories = new Set();
  for (const channel of allChannels) {
    const category = getCategory(channel);
    if (category) categories.add(category);
  }

  const sorted = [...categories].sort((a, b) => String(a).localeCompare(String(b)));
  categoryList.innerHTML = "";
  categoryList.appendChild(createCategoryButton("ALL", true));

  for (const category of sorted) {
    categoryList.appendChild(createCategoryButton(category, false));
  }
}

function createCategoryButton(category, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-button" + (active ? " active" : "");
  button.textContent = String(category);

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
      item.classList.toggle("active", item.textContent === String(category));
    });

    applyFilters();
  });

  return button;
}

function applyFilters() {
  const query = normalize(searchInput.value);

  filteredChannels = allChannels.filter(channel => {
    const category = getCategory(channel);
    const matchesCategory =
      activeCategory === "ALL" || normalize(category) === normalize(activeCategory);

    if (!matchesCategory) return false;
    if (!query) return true;

    const searchable = [
      channel.name,
      channel.id,
      channel.group,
      channel.category,
      channel.language,
      channel.country
    ]
      .map(normalize)
      .join(" ");

    return searchable.includes(query);
  });

  resultsCount.textContent = `${filteredChannels.length.toLocaleString()} channels`;
  visibleCount = Math.min(visibleCount, filteredChannels.length);
  renderChannels();
}

function renderChannels() {
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
  const group = getCategory(channel);

  card.innerHTML = `
    <button class="favorite-button ${favorite ? "active" : ""}" type="button" aria-label="Favorite">
      ${favorite ? "♥" : "♡"}
    </button>
    <div class="channel-logo-wrap">
      ${
        logo
          ? `<img class="channel-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(
              channel.name
            )}" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">`
          : ""
      }
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

  card.addEventListener("click", () => openChannel(channel));
  return card;
}

/* =========================================================
   PLAYER LIFECYCLE & ENGINE
========================================================= */

async function destroyPlayer() {
  stopLiveStatusTimer();
  hidePlayerErrorOverlay();

  if (shakaPlayer) {
    try {
      await shakaPlayer.destroy();
    } catch (error) {
      console.warn("Shaka destroy failed:", error);
    }
    shakaPlayer = null;
  }

  if (playerUiShell) {
    playerUiShell.classList.remove("gmax-controls-hidden");
  }
}

async function openChannel(channel, serverIndex = 0) {
  currentChannel = channel;
  currentServerIndex = serverIndex;

  const id = getChannelId(channel);
  let streamUrl = getStreamUrl(channel, currentServerIndex);

  if (!streamUrl) {
    showPlayerError("This channel does not contain a playable stream URL.");
    return;
  }

  lastStreamUrl = streamUrl;
  lastStreamType = streamType(streamUrl);

  playerSection.classList.remove("hidden");
  playerEmpty.classList.add("hidden");
  playingTitle.textContent = channel.name || "Channel";
  playingMeta.textContent = ["JIO TV", channel.country || "INDIA", getCategory(channel)]
    .filter(Boolean)
    .join(" • ");

  clearPlayerError();
  showPlayerLoading(true);

  history.replaceState(null, "", `?id=${encodeURIComponent(id || "")}`);
  window.scrollTo({ top: 0, behavior: "smooth" });

  await destroyPlayer();

  try {
    if (lastStreamType === "dash") {
      await playDash(streamUrl);
    } else if (lastStreamType === "hls") {
      await playHls(streamUrl);
    } else {
      throw new Error(`Unsupported stream format:\n${streamUrl}`);
    }
  } catch (error) {
    console.warn(`Playback failed on server tier ${currentServerIndex}:`, error);
    
    // Automatic failover to secondary Jio TV routes
    if (currentServerIndex < JIO_SERVERS.length - 1) {
      console.info(`Switching to backup server tier ${currentServerIndex + 1}...`);
      await openChannel(channel, currentServerIndex + 1);
    } else {
      showPlayerError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    showPlayerLoading(false);
  }
}

/* =========================================================
   SHAKA DASH ENGINE
========================================================= */

async function playDash(streamUrl) {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    throw new Error("This browser does not support Shaka Player.");
  }

  shakaPlayer = new shaka.Player();

  shakaPlayer.configure({
    streaming: {
      bufferingGoal: BUFFERING_GOAL_SECONDS,
      rebufferingGoal: REBUFFERING_GOAL_SECONDS,
      bufferBehind: BUFFER_BEHIND_SECONDS,
      retryParameters: {
        maxAttempts: 3,
        baseDelay: 1000,
        backoffFactor: 2
      }
    }
  });

  await shakaPlayer.attach(video);

  shakaPlayer.addEventListener("error", event => {
    console.error("Shaka Player Error:", event.detail);
  });

  // Network Request Filter: Token injection and URL rewriting
  const networkingEngine = shakaPlayer.getNetworkingEngine();
  if (networkingEngine) {
    networkingEngine.registerRequestFilter((requestType, request) => {
      request.uris = request.uris.map(uri => {
        if (!uri) return uri;
        // Keep dynamic server alignment on segment paths
        return transformToDynamicServer(uri, currentServerIndex);
      });

      // Maintain valid cookies if dynamic parameters exist
      if (currentChannel?.cookie && currentChannel.cookie.includes("__hdnea__=")) {
        const authParam = currentChannel.cookie;
        request.uris = request.uris.map(uri => {
          if (uri.includes("__hdnea__=")) return uri;
          return uri + (uri.includes("?") ? "&" : "?") + authParam;
        });
      }
    });
  }

  // ClearKey Configuration (Sanitized)
  if (currentChannel?.key_id && currentChannel?.key) {
    const keyId = String(currentChannel.key_id).trim();
    const key = String(currentChannel.key).trim();

    if (isValidHexKey(keyId) && isValidHexKey(key)) {
      const clearKeys = {};
      clearKeys[keyId] = key;
      shakaPlayer.configure({
        drm: { clearKeys }
      });
    } else {
      console.warn("Skipping invalid/corrupted DRM Clearkey pair:", keyId, key);
    }
  }

  await shakaPlayer.load(streamUrl);

  seekToConfiguredLivePosition();
  video.controls = false;
  setupCinematicPlayer();
  updateQualityOptions();
  startLiveStatusTimer();
  updatePlayerUi();

  await video.play().catch(() => {});
}

/* =========================================================
   HLS ENGINE
========================================================= */

async function playHls(streamUrl) {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = streamUrl;
    video.controls = false;
    setupCinematicPlayer();
    updateQualityOptions();
    startLiveStatusTimer();
    await waitForVideoReady();
    seekNativeHlsToDelayedLive();
    updatePlayerUi();
    await video.play().catch(() => {});
    return;
  }

  if (window.shaka && shaka.Player.isBrowserSupported()) {
    shakaPlayer = new shaka.Player();
    shakaPlayer.configure({
      streaming: {
        bufferingGoal: BUFFERING_GOAL_SECONDS,
        rebufferingGoal: REBUFFERING_GOAL_SECONDS,
        bufferBehind: BUFFER_BEHIND_SECONDS
      }
    });

    await shakaPlayer.attach(video);
    await shakaPlayer.load(streamUrl);

    seekToConfiguredLivePosition();
    video.controls = false;
    setupCinematicPlayer();
    updateQualityOptions();
    startLiveStatusTimer();
    updatePlayerUi();
    await video.play().catch(() => {});
    return;
  }

  throw new Error("This browser cannot play HLS streams.");
}

function seekNativeHlsToDelayedLive() {
  try {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    video.currentTime = Math.max(0, duration - LIVE_DELAY_SECONDS);
    return true;
  } catch (error) {
    return false;
  }
}

function waitForVideoReady() {
  return new Promise(resolve => {
    if (video.readyState >= 2) return resolve();
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

/* =========================================================
   UI CONTROLS & EVENT BINDINGS
========================================================= */

function showPlayerLoading(state) {
  if (playerLoading) playerLoading.classList.toggle("hidden", !state);
  state ? showPlayerSpinner() : hidePlayerSpinner();
}

function showPlayerError(message) {
  playerError.textContent = message;
  playerError.classList.remove("hidden");
  showPlayerErrorOverlay(message);
}

function clearPlayerError() {
  playerError.textContent = "";
  playerError.classList.add("hidden");
  hidePlayerErrorOverlay();
}

function showPlayerSpinner() {
  const spinner = playerUiShell?.querySelector('[data-role="spinner"]');
  if (spinner) spinner.style.display = "block";
}

function hidePlayerSpinner() {
  const spinner = playerUiShell?.querySelector('[data-role="spinner"]');
  if (spinner) spinner.style.display = "none";
}

function showPlayerErrorOverlay(message) {
  const overlay = playerUiShell?.querySelector('[data-role="error"]');
  if (!overlay) return;
  const messageElement = overlay.querySelector('[data-role="error-message"]');
  if (messageElement) messageElement.textContent = message || "The channel could not be played.";
  overlay.classList.add("open");
}

function hidePlayerErrorOverlay() {
  const overlay = playerUiShell?.querySelector('[data-role="error"]');
  if (overlay) overlay.classList.remove("open");
}

async function retryCurrentChannel() {
  if (isPlayerRetrying || !currentChannel) return;
  isPlayerRetrying = true;
  showPlayerLoading(true);
  clearPlayerError();

  try {
    await destroyPlayer();
    // Rotate server tier on manual retry
    currentServerIndex = (currentServerIndex + 1) % JIO_SERVERS.length;
    await openChannel(currentChannel, currentServerIndex);
  } catch (error) {
    showPlayerError(error instanceof Error ? error.message : String(error));
  } finally {
    isPlayerRetrying = false;
    showPlayerLoading(false);
  }
}

function startLiveStatusTimer() {
  stopLiveStatusTimer();
  liveStatusTimer = setInterval(() => updateLiveStatus(), 1000);
  updateLiveStatus();
}

function stopLiveStatusTimer() {
  if (liveStatusTimer) {
    clearInterval(liveStatusTimer);
    liveStatusTimer = null;
  }
}

function updateLiveStatus() {
  if (!playerControls) return;
  const lagElement = playerControls.querySelector('[data-role="live-lag"]');
  if (!lagElement) return;

  const lag = getCurrentLiveLag();
  if (lag === null) {
    lagElement.textContent = `LIVE • -${LIVE_DELAY_SECONDS}s`;
    return;
  }
  lagElement.textContent = `LIVE • -${Math.max(0, Math.round(lag))}s`;
}

function updateQualityOptions() {
  if (!qualityMenu) return;

  if (!shakaPlayer || typeof shakaPlayer.getVariantTracks !== "function") {
    qualityMenu.innerHTML = `
      <button class="gmax-quality-item active" type="button">Auto</button>
      <button class="gmax-quality-item" type="button" disabled>Native HLS</button>
    `;
    return;
  }

  const tracks = shakaPlayer
    .getVariantTracks()
    .filter(track => track?.video && track?.height);

  const bestByResolution = new Map();
  for (const track of tracks) {
    const height = Number(track.height);
    const existing = bestByResolution.get(height);
    if (!existing || Number(track.bandwidth || 0) > Number(existing.bandwidth || 0)) {
      bestByResolution.set(height, track);
    }
  }

  const uniqueTracks = [...bestByResolution.values()].sort(
    (a, b) => Number(b.height || 0) - Number(a.height || 0)
  );

  qualityMenu.innerHTML = `
    <button class="gmax-quality-item active" data-quality="auto" type="button">Auto</button>
    ${uniqueTracks
      .map(track => {
        const fps = Number(track.frameRate || 0);
        return `
          <button class="gmax-quality-item" data-quality-track="${track.id}" type="button">
            ${track.height}p${fps ? ` • ${Math.round(fps)}fps` : ""}
          </button>
        `;
      })
      .join("")}
  `;

  qualityMenu.querySelectorAll("[data-quality]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      shakaPlayer.configure({ abr: { enabled: true } });
      setActiveQualityButton(button);
      qualityMenu.classList.remove("open");
    });
  });

  qualityMenu.querySelectorAll("[data-quality-track]").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const trackId = Number(button.dataset.qualityTrack);
      const selected = tracks.find(track => Number(track.id) === trackId);
      if (!selected) return;

      shakaPlayer.configure({ abr: { enabled: false } });
      shakaPlayer.selectVariantTrack(selected, true, 0);
      setActiveQualityButton(button);
      qualityMenu.classList.remove("open");
    });
  });
}

function setActiveQualityButton(activeButton) {
  if (!qualityMenu) return;
  qualityMenu.querySelectorAll(".gmax-quality-item").forEach(item => {
    item.classList.toggle("active", item === activeButton);
  });
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

function showPlayerControlsTemporarily() {
  if (!playerUiShell) return;
  playerUiShell.classList.remove("gmax-controls-hidden");
  clearTimeout(playerUiTimer);
  playerUiTimer = setTimeout(() => {
    if (!video.paused) playerUiShell.classList.add("gmax-controls-hidden");
  }, 2800);
}

function toggleFullscreen() {
  if (!playerUiShell) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    playerUiShell.requestFullscreen().catch(() => {});
  }
}

function handlePlayerKeyboard(event) {
  if (!playerUiShell || playerSection.classList.contains("hidden")) return;
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

  const key = String(event.key).toLowerCase();
  if (key === " ") {
    event.preventDefault();
    video.paused ? video.play().catch(() => {}) : video.pause();
    updatePlayerUi();
  } else if (key === "m") {
    video.muted = !video.muted;
    updatePlayerUi();
  } else if (key === "f") {
    toggleFullscreen();
  } else if (key === "g") {
    seekToConfiguredLivePosition();
  } else if (key === "arrowup") {
    event.preventDefault();
    video.volume = Math.min(1, video.volume + 0.05);
    video.muted = false;
    updatePlayerUi();
  } else if (key === "arrowdown") {
    event.preventDefault();
    video.volume = Math.max(0, video.volume - 0.05);
    updatePlayerUi();
  }
  showPlayerControlsTemporarily();
}

/* =========================================================
   CINEMATIC UI CREATION & STYLE INJECTION
========================================================= */

function injectCinematicPlayerStyles() {
  if (document.getElementById("gmax-cinematic-player-styles")) return;
  const style = document.createElement("style");
  style.id = "gmax-cinematic-player-styles";
  style.textContent = `
    .gmax-player-shell { position: relative; width: 100%; aspect-ratio: 16 / 9; min-height: 280px; background: #000; overflow: hidden; border-radius: 18px; box-shadow: 0 30px 90px rgba(0,0,0,.55); isolation: isolate; user-select: none; }
    .gmax-player-shell video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
    .gmax-player-gradient { position: absolute; inset: auto 0 0; height: 210px; pointer-events: none; background: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,.08) 20%, rgba(0,0,0,.82) 100%); z-index: 3; }
    .gmax-player-top { position: absolute; top: 0; left: 0; right: 0; padding: 20px; display: flex; align-items: flex-start; gap: 12px; z-index: 6; background: linear-gradient(to bottom, rgba(0,0,0,.7), transparent); pointer-events: none; }
    .gmax-now-playing { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .gmax-channel-art { width: 54px; height: 54px; border-radius: 12px; object-fit: contain; background: rgba(255,255,255,.08); padding: 5px; border: 1px solid rgba(255,255,255,.1); flex: 0 0 auto; }
    .gmax-now-copy { min-width: 0; }
    .gmax-now-label { font: 800 10px/1 system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: #ff2b83; margin-bottom: 6px; }
    .gmax-now-title { color: #fff; font: 800 clamp(15px, 2vw, 22px)/1.2 system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: min(55vw, 520px); }
    .gmax-now-meta { color: rgba(255,255,255,.65); font: 500 11px/1.3 system-ui, sans-serif; margin-top: 4px; }
    .gmax-live-badge { margin-left: auto; pointer-events: auto; display: inline-flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 999px; color: #fff; background: rgba(229,9,20,.95); font: 900 10px/1 system-ui, sans-serif; letter-spacing: .08em; box-shadow: 0 8px 28px rgba(229,9,20,.35); }
    .gmax-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 5px rgba(255,255,255,.08); }
    .gmax-player-controls { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; display: flex; align-items: center; gap: 9px; padding: 70px 18px 16px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.92)); transition: opacity .2s ease, transform .2s ease; }
    .gmax-player-shell.gmax-controls-hidden .gmax-player-controls, .gmax-player-shell.gmax-controls-hidden .gmax-player-top { opacity: 0; pointer-events: none; }
    .gmax-player-button { width: 38px; height: 38px; border: 0; border-radius: 11px; display: grid; place-items: center; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; font: 700 15px/1 system-ui, sans-serif; transition: .15s ease; flex: 0 0 auto; }
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
    <div class="gmax-live-badge" title="Live"><span class="gmax-live-dot"></span> LIVE</div>
  `;
  shell.appendChild(top);

  const spinner = document.createElement("div");
  spinner.className = "gmax-spinner";
  spinner.dataset.role = "spinner";
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
    <button class="gmax-go-live" data-action="go-live" type="button" title="Return to live edge">GO LIVE</button>
    <span class="gmax-player-spacer"></span>
    <div class="gmax-quality-wrap">
      <button class="gmax-player-button" data-action="quality" type="button" title="Quality">⚙</button>
      <div class="gmax-quality-menu" data-role="quality-menu"></div>
    </div>
    <button class="gmax-player-button" data-action="fullscreen" type="button" title="Fullscreen">⛶</button>
  `;
  shell.appendChild(controls);

  playerControls = controls;
  qualityMenu = controls.querySelector('[data-role="quality-menu"]');

  controls.querySelector('[data-action="play"]').addEventListener("click", async e => {
    e.stopPropagation();
    video.paused ? await video.play().catch(() => {}) : video.pause();
    updatePlayerUi();
  });

  controls.querySelector('[data-action="mute"]').addEventListener("click", e => {
    e.stopPropagation();
    video.muted = !video.muted;
    updatePlayerUi();
  });

  controls.querySelector('[data-action="volume"]').addEventListener("input", e => {
    e.stopPropagation();
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    updatePlayerUi();
  });

  controls.querySelector('[data-action="go-live"]').addEventListener("click", e => {
    e.stopPropagation();
    if (seekToConfiguredLivePosition()) video.play().catch(() => {});
    updatePlayerUi();
  });

  controls.querySelector('[data-action="quality"]').addEventListener("click", e => {
    e.stopPropagation();
    qualityMenu.classList.toggle("open");
  });

  controls.querySelector('[data-action="fullscreen"]').addEventListener("click", e => {
    e.stopPropagation();
    toggleFullscreen();
  });

  errorOverlay.querySelector('[data-action="retry"]').addEventListener("click", e => {
    e.stopPropagation();
    retryCurrentChannel();
  });

  shell.addEventListener("mousemove", showPlayerControlsTemporarily);
  shell.addEventListener("touchstart", showPlayerControlsTemporarily, { passive: true });
  document.addEventListener("click", e => {
    if (qualityMenu && !e.target.closest(".gmax-quality-wrap")) qualityMenu.classList.remove("open");
  });

  ["play", "pause", "timeupdate", "loadedmetadata", "volumechange"].forEach(evt => {
    video.addEventListener(evt, updatePlayerUi);
  });

  window.addEventListener("keydown", handlePlayerKeyboard);
}

function updatePlayerIdentity() {
  if (!playerUiShell || !currentChannel) return;
  const art = playerUiShell.querySelector('[data-role="channel-art"]');
  const title = playerUiShell.querySelector('[data-role="channel-title"]');
  const meta = playerUiShell.querySelector('[data-role="channel-meta"]');
  const logo = getChannelLogo(currentChannel);

  if (art) {
    if (logo) {
      art.src = logo;
      art.style.display = "block";
    } else {
      art.removeAttribute("src");
      art.style.display = "none";
    }
  }
  if (title) title.textContent = currentChannel.name || "Live TV";
  if (meta) meta.textContent = ["JIO TV", currentChannel.country || "INDIA", getCategory(currentChannel)].filter(Boolean).join(" • ");
}

function buildRelatedChannels() {
  if (!playerSection || !currentChannel) return;
  let info = playerSection.querySelector(".gmax-player-info");
  if (!info) {
    info = document.createElement("div");
    info.className = "gmax-player-info";
    playerSection.appendChild(info);
  }

  const logo = getChannelLogo(currentChannel);
  const related = allChannels
    .filter(ch => getChannelId(ch) !== getChannelId(currentChannel))
    .filter(ch => normalize(getCategory(ch)) === normalize(getCategory(currentChannel)))
    .slice(0, 12);

  info.innerHTML = `
    <div class="gmax-player-info-main">
      ${logo ? `<img class="gmax-info-logo" src="${escapeHtml(logo)}" alt="" referrerpolicy="no-referrer">` : ""}
      <div>
        <div class="gmax-info-label">NOW PLAYING</div>
        <div class="gmax-info-title">${escapeHtml(currentChannel.name || "Live TV")}</div>
        <div class="gmax-info-meta">${escapeHtml(["JIO TV", currentChannel.country || "INDIA", getCategory(currentChannel)].filter(Boolean).join(" • "))}</div>
      </div>
    </div>
  `;
}

/* =========================================================
   SCROLL & INITIALIZATION
========================================================= */

function ensureInfiniteScrollObserver() {
  if (infiniteScrollObserver) return;
  let sentinel = document.getElementById("gmax-infinite-scroll-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.id = "gmax-infinite-scroll-sentinel";
    sentinel.style.height = "1px";
    sentinel.style.width = "100%";
    channelsGrid.insertAdjacentElement("afterend", sentinel);
  }

  infiniteScrollObserver = new IntersectionObserver(
    entries => {
      const entry = entries[0];
      if (!entry.isIntersecting || infiniteScrollBusy || visibleCount >= filteredChannels.length) return;
      infiniteScrollBusy = true;
      visibleCount += CHANNELS_PER_PAGE;
      renderChannels();
      requestAnimationFrame(() => {
        infiniteScrollBusy = false;
      });
    },
    { root: null, rootMargin: "1000px 0px", threshold: 0 }
  );

  infiniteScrollObserver.observe(sentinel);
}

function hideLoadMore() {
  if (loadMore) {
    loadMore.classList.add("hidden");
    loadMore.style.display = "none";
  }
  if (loadMoreButton) {
    loadMoreButton.style.display = "none";
  }
}

searchInput.addEventListener("input", () => {
  visibleCount = CHANNELS_PER_PAGE;
  if (infiniteScrollObserver) {
    infiniteScrollObserver.disconnect();
    infiniteScrollObserver = null;
  }
  const oldSentinel = document.getElementById("gmax-infinite-scroll-sentinel");
  if (oldSentinel) oldSentinel.remove();
  applyFilters();
});

function getRequestedChannelId() {
  return new URLSearchParams(window.location.search).get("id");
}

function openRequestedChannel() {
  const id = getRequestedChannelId();
  if (!id) return;
  const channel = allChannels.find(item => String(item.id ?? item.tvgId) === String(id));
  if (channel) {
    setTimeout(() => openChannel(channel), 200);
  }
}

closePlayerButton.addEventListener("click", async () => {
  await destroyPlayer();
  video.pause();
  video.removeAttribute("src");
  video.load();
  playerSection.classList.add("hidden");
  playerEmpty.classList.remove("hidden");
  clearPlayerError();
  currentChannel = null;
  lastStreamUrl = "";
  lastStreamType = "";

  const info = playerSection.querySelector(".gmax-player-info");
  if (info) info.remove();
  history.replaceState(null, "", window.location.pathname);
});

async function loadChannels() {
  try {
    const response = await fetch(CHANNELS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`channels.json returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("channels.json is not an array.");

    allChannels = data.filter(channel => channel && (channel.name || channel.stream_url || channel.url));
    filteredChannels = [...allChannels];
    channelCount.textContent = `${allChannels.length.toLocaleString()} channels`;
    resultsCount.textContent = `${allChannels.length.toLocaleString()} channels`;

    buildCategories();
    applyFilters();
    openRequestedChannel();
  } catch (error) {
    console.error("Channel loading failed:", error);
    channelCount.textContent = "Failed to load";
    resultsCount.textContent = "0 channels";
    channelsGrid.innerHTML = `
      <div class="empty-grid">
        <strong>Failed to load Jio TV channels</strong><br><br>
        <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  hideLoadMore();
  loadChannels();
});
