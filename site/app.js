"use strict";

/* =========================================================
   CONFIG
========================================================= */

const CHANNELS_URL = "./channels.json";
const CHANNEL_REFRESH_MS = 10 * 60 * 1000;
const CHANNELS_PER_PAGE = 60;
const LIVE_DELAY_SECONDS = 15;
const BUFFERING_GOAL_SECONDS = 25;
const REBUFFERING_GOAL_SECONDS = 6;
const BUFFER_BEHIND_SECONDS = 45;
const MAX_RECENT_CHANNELS = 14;
const RECONNECT_DELAY_MS = 2500;

/* =========================================================
   STATE
========================================================= */

let allChannels = [];
let filteredChannels = [];
let activeCategory = "ALL";
let visibleCount = CHANNELS_PER_PAGE;

let shakaPlayer = null;
let currentChannel = null;
let currentSourceIndex = 0;
let currentAttemptToken = 0;
let sourceRecoveryTimer = null;
let channelRefreshTimer = null;
let liveStatusTimer = null;
let infiniteScrollObserver = null;
let infiniteScrollBusy = false;

let playerShell = null;
let playerControls = null;
let qualityMenu = null;
let sourceStatus = null;
let aspectControls = null;
let aspectControlsBound = false;

let lastStreamUrl = "";
let lastStreamType = "";
let isPlayerRetrying = false;
let playerReady = false;

const favorites = new Set(
  JSON.parse(localStorage.getItem("gmax-jiotv-favorites") || "[]")
);

let recentChannels = new Set(
  JSON.parse(localStorage.getItem("gmax-jiotv-recent") || "[]")
);

/* =========================================================
   DOM
========================================================= */

const channelsGrid = document.getElementById("channels-grid");
const categoryList = document.getElementById("category-list");
const searchInput = document.getElementById("search-input");
const channelCount = document.getElementById("channel-count");
const sourceCount = document.getElementById("source-count");
const resultsCount = document.getElementById("results-count");
const loadMore = document.getElementById("load-more");
const loadMoreButton = document.getElementById("load-more-button");
const recentSection = document.getElementById("recent-section");
const recentGrid = document.getElementById("recent-grid");
const playerSection = document.getElementById("player-section");
const videoContainer = document.querySelector(".video-container");
const video = document.getElementById("video");
const playingTitle = document.getElementById("playing-title");
const playingMeta = document.getElementById("playing-meta");
const playerLoading = document.getElementById("player-loading");
const playerLoadingText = document.getElementById("player-loading-text");
const playerEmpty = document.getElementById("player-empty");
const playerError = document.getElementById("player-error");
const closePlayerButton = document.getElementById("close-player");
sourceStatus = document.getElementById("source-status");
const staticAspectControls = document.getElementById("aspect-controls");

/* =========================================================
   HELPERS
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

function getChannelId(channel) {
  return String(channel?.id || channel?.tvgId || channel?.name || "").trim();
}

function getChannelLogo(channel) {
  return channel?.logo || channel?.tvg_logo || "";
}

function getCategory(channel) {
  return channel?.category || channel?.group || "Entertainment";
}

function sourceType(source) {
  const url = String(source?.stream_url || source?.url || "").toLowerCase();
  if (url.includes(".mpd")) return "dash";
  if (url.includes(".m3u8")) return "hls";
  return "unknown";
}

function getChannelSources(channel) {
  const sources = Array.isArray(channel?.sources)
    ? channel.sources.filter(source => source && source.stream_url)
    : [];

  if (sources.length) return sources;

  if (channel?.stream_url || channel?.url) {
    return [
      {
        server: channel?.source_m3u ? String(channel.source_m3u).replace(/\.[^.]+$/, "") : "primary",
        m3u: channel?.source_m3u || "primary",
        stream_url: channel?.stream_url || channel?.url,
        cookie: channel?.cookie,
        key_id: channel?.key_id,
        key: channel?.key,
        referrer: channel?.referrer,
        user_agent: channel?.user_agent,
      },
    ];
  }

  return [];
}

function sourceLabel(source, index, total) {
  const name = source?.m3u || source?.server || `source-${index + 1}`;
  return `Source ${index + 1}/${total} • ${name}`;
}

function setLoadingText(text) {
  if (playerLoadingText) playerLoadingText.textContent = text;
  if (sourceStatus) sourceStatus.textContent = text;
}

function setSourceStatus(source, index, total, prefix = "Connecting") {
  setLoadingText(`${prefix} • ${sourceLabel(source, index, total)}`);
}

function persistRecent() {
  localStorage.setItem("gmax-jiotv-recent", JSON.stringify([...recentChannels]));
}

function rememberRecent(channel) {
  const id = getChannelId(channel);
  if (!id) return;
  recentChannels.delete(id);
  recentChannels.add(id);

  while (recentChannels.size > MAX_RECENT_CHANNELS) {
    const oldest = recentChannels.values().next().value;
    recentChannels.delete(oldest);
  }

  persistRecent();
  renderRecentChannels();
}

function saveFavorites() {
  localStorage.setItem("gmax-jiotv-favorites", JSON.stringify([...favorites]));
}

function getUniqueM3uCount(channels = allChannels) {
  const set = new Set();
  for (const channel of channels) {
    for (const source of getChannelSources(channel)) {
      if (source?.m3u) set.add(source.m3u);
    }
    if (channel?.source_m3u) set.add(channel.source_m3u);
  }
  return set.size;
}

function resetInfiniteScroll() {
  if (infiniteScrollObserver) {
    infiniteScrollObserver.disconnect();
    infiniteScrollObserver = null;
  }

  document.getElementById("gmax-infinite-scroll-sentinel")?.remove();
}

/* =========================================================
   FAVORITES
========================================================= */

function toggleFavorite(channelId) {
  const key = String(channelId);
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  saveFavorites();
  renderChannels();
}

/* =========================================================
   CATEGORIES + FILTERS
========================================================= */

function buildCategories() {
  const categories = new Set();
  for (const channel of allChannels) {
    const category = getCategory(channel);
    if (category) categories.add(category);
  }

  categoryList.innerHTML = "";
  categoryList.appendChild(createCategoryButton("ALL", activeCategory === "ALL"));

  [...categories]
    .sort((a, b) => String(a).localeCompare(String(b)))
    .forEach(category => categoryList.appendChild(createCategoryButton(category, normalize(category) === normalize(activeCategory))));
}

function createCategoryButton(category, active) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `category-button${active ? " active" : ""}`;
  button.textContent = String(category);

  button.addEventListener("click", () => {
    activeCategory = category;
    visibleCount = CHANNELS_PER_PAGE;
    resetInfiniteScroll();
    buildCategories();
    applyFilters();
  });

  return button;
}

function applyFilters() {
  const query = normalize(searchInput?.value);

  filteredChannels = allChannels.filter(channel => {
    const category = getCategory(channel);
    const categoryMatch = activeCategory === "ALL" || normalize(category) === normalize(activeCategory);
    if (!categoryMatch) return false;
    if (!query) return true;

    const searchable = [
      channel.name,
      channel.id,
      channel.group,
      channel.category,
      channel.language,
      channel.country,
      channel.source_m3u,
      ...getChannelSources(channel).map(source => source.m3u),
    ]
      .map(normalize)
      .join(" ");

    return searchable.includes(query);
  });

  resultsCount.textContent = `${filteredChannels.length.toLocaleString()} channels`;
  visibleCount = Math.min(visibleCount, filteredChannels.length);
  renderChannels();
}

/* =========================================================
   CHANNEL CARDS
========================================================= */

function createChannelCard(channel, compact = false) {
  const card = document.createElement("article");
  card.className = compact ? "channel-card recent-card" : "channel-card";

  const id = getChannelId(channel) || String(Math.random());
  const favorite = favorites.has(id);
  const logo = getChannelLogo(channel);
  const group = channel.group || channel.groupTitle || getCategory(channel);

  card.innerHTML = `
    ${
      compact
        ? ""
        : `<button class="favorite-button ${favorite ? "active" : ""}" type="button" aria-label="Favorite">${favorite ? "♥" : "♡"}</button>`
    }
    <div class="channel-logo-wrap">
      ${
        logo
          ? `<img class="channel-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(channel.name)}" loading="lazy" referrerpolicy="no-referrer"><div class="channel-fallback" style="display:none">TV</div>`
          : `<div class="channel-fallback">TV</div>`
      }
    </div>
    <div class="channel-info">
      <div class="channel-name">${escapeHtml(channel.name || "Unknown Channel")}</div>
      <div class="channel-meta">JIO TV • ${escapeHtml(channel.country || "INDIA")} • ${escapeHtml(group)}</div>
    </div>
  `;

  const image = card.querySelector(".channel-logo");
  image?.addEventListener("error", () => {
    image.style.display = "none";
    const fallback = image.nextElementSibling;
    if (fallback) fallback.style.display = "flex";
  });

  card.querySelector(".favorite-button")?.addEventListener("click", event => {
    event.stopPropagation();
    toggleFavorite(id);
  });

  card.addEventListener("click", () => openChannel(channel));
  return card;
}

function renderChannels() {
  const visible = filteredChannels.slice(0, visibleCount);
  channelsGrid.innerHTML = "";

  if (!visible.length) {
    channelsGrid.innerHTML = `<div class="empty-grid">No channels found.</div>`;
    hideLoadMore();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const channel of visible) fragment.appendChild(createChannelCard(channel));
  channelsGrid.appendChild(fragment);

  ensureInfiniteScrollObserver();
  hideLoadMore();
}

function renderRecentChannels() {
  if (!recentSection || !recentGrid) return;

  const recent = [...recentChannels]
    .map(id => allChannels.find(channel => getChannelId(channel) === String(id)))
    .filter(Boolean)
    .slice(0, MAX_RECENT_CHANNELS);

  recentGrid.innerHTML = "";
  if (!recent.length) {
    recentSection.classList.add("hidden");
    return;
  }

  recentSection.classList.remove("hidden");
  const fragment = document.createDocumentFragment();
  for (const channel of recent) fragment.appendChild(createChannelCard(channel, true));
  recentGrid.appendChild(fragment);
}

function ensureInfiniteScrollObserver() {
  if (infiniteScrollObserver) return;

  let sentinel = document.getElementById("gmax-infinite-scroll-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.id = "gmax-infinite-scroll-sentinel";
    sentinel.style.height = "1px";
    channelsGrid.insertAdjacentElement("afterend", sentinel);
  }

  infiniteScrollObserver = new IntersectionObserver(
    entries => {
      const entry = entries[0];
      if (!entry?.isIntersecting || infiniteScrollBusy || visibleCount >= filteredChannels.length) return;

      infiniteScrollBusy = true;
      visibleCount += CHANNELS_PER_PAGE;
      renderChannels();

      requestAnimationFrame(() => {
        infiniteScrollBusy = false;
      });
    },
    { rootMargin: "900px 0px", threshold: 0 }
  );

  infiniteScrollObserver.observe(sentinel);
}

function hideLoadMore() {
  loadMore?.classList.add("hidden");
  if (loadMore) loadMore.style.display = "none";
  if (loadMoreButton) loadMoreButton.style.display = "none";
}

/* =========================================================
   PLAYER STATE + LOADING
========================================================= */

function showPlayerLoading(state) {
  playerLoading?.classList.toggle("hidden", !state);
  if (state) showPlayerSpinner();
  else hidePlayerSpinner();
}

function showPlayerSpinner() {
  playerShell?.querySelector("[data-role='spinner']")?.classList.remove("hidden");
}

function hidePlayerSpinner() {
  playerShell?.querySelector("[data-role='spinner']")?.classList.add("hidden");
}

function clearPlayerError() {
  if (!playerError) return;
  playerError.textContent = "";
  playerError.classList.add("hidden");
}

function showPlayerError(message) {
  console.warn("Playback problem:", message);
  clearPlayerError();
  setLoadingText("Reconnecting to live stream…");
  showPlayerLoading(true);
}

function scheduleSourceRetry() {
  if (sourceRecoveryTimer || !currentChannel) return;

  const token = currentAttemptToken;
  sourceRecoveryTimer = setTimeout(() => {
    sourceRecoveryTimer = null;
    if (token !== currentAttemptToken || !currentChannel) return;

    const sources = getChannelSources(currentChannel);
    if (currentSourceIndex + 1 < sources.length) {
      openChannel(currentChannel, currentSourceIndex + 1);
    } else {
      setSourceStatus(sources[0], 0, sources.length, "Reconnecting");
      setTimeout(() => {
        if (token !== currentAttemptToken || !currentChannel) return;
        openChannel(currentChannel, 0);
      }, RECONNECT_DELAY_MS);
    }
  }, 350);
}

function handlePlaybackFailure(error) {
  console.warn("Playback fallback:", error);
  showPlayerError(error);
  scheduleSourceRetry();
}

/* =========================================================
   STREAM URL / REQUEST HELPERS
========================================================= */

function appendCookieToUrl(url, cookie) {
  const sourceUrl = String(url || "");
  const token = String(cookie || "").trim();

  if (!sourceUrl || !token || !token.includes("__hdnea__=") || sourceUrl.includes("__hdnea__=")) {
    return sourceUrl;
  }

  return `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}${token}`;
}

function configureNetworking(player, source) {
  const networkingEngine = player?.getNetworkingEngine?.();
  if (!networkingEngine) return;

  networkingEngine.registerRequestFilter((requestType, request) => {
    const isManifest = requestType === shaka.net.NetworkingEngine.RequestType.MANIFEST;
    const isSegment = requestType === shaka.net.NetworkingEngine.RequestType.SEGMENT;

    if (!isManifest && !isSegment) return;

    if (source?.cookie) {
      request.uris = request.uris.map(uri => appendCookieToUrl(uri, source.cookie));
    }

    // These may be ignored by browsers when they are forbidden headers, but they
    // are harmless where the playback stack allows them.
    if (source?.referrer) request.headers.Referer = source.referrer;
    if (source?.user_agent) request.headers["User-Agent"] = source.user_agent;
  });
}

function configureClearKey(player, source) {
  if (!source?.key_id || !source?.key) return;

  player.configure({
    drm: {
      clearKeys: {
        [String(source.key_id).trim()]: String(source.key).trim(),
      },
    },
  });
}

/* =========================================================
   PLAYER DESTROY
========================================================= */

async function destroyPlayer() {
  if (liveStatusTimer) {
    clearInterval(liveStatusTimer);
    liveStatusTimer = null;
  }

  if (sourceRecoveryTimer) {
    clearTimeout(sourceRecoveryTimer);
    sourceRecoveryTimer = null;
  }

  if (shakaPlayer) {
    try {
      await shakaPlayer.destroy();
    } catch (error) {
      console.warn("Shaka destroy failed:", error);
    }
    shakaPlayer = null;
  }

  playerReady = false;
}

/* =========================================================
   PLAYER SETUP
========================================================= */

function ensurePlayerShell() {
  if (!videoContainer || !video) return null;

  let shell = video.closest(".gmax-player-shell");
  if (!shell) {
    shell = document.createElement("div");
    shell.className = "gmax-player-shell";
    videoContainer.insertBefore(shell, video);
    shell.appendChild(video);
  }

  playerShell = shell;

  if (!playerControls) createPlayerControls(shell);
  return shell;
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
    <div class="gmax-live-badge"><span class="gmax-live-dot"></span>LIVE</div>
  `;
  shell.appendChild(top);

  const spinner = document.createElement("div");
  spinner.className = "gmax-spinner";
  spinner.dataset.role = "spinner";
  shell.appendChild(spinner);

  const controls = document.createElement("div");
  controls.className = "gmax-player-controls";
  controls.innerHTML = `
    <button class="gmax-player-button" data-action="play" type="button" title="Play / Pause">▶</button>
    <button class="gmax-player-button" data-action="mute" type="button" title="Mute">🔊</button>
    <input class="gmax-volume" data-action="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
    <span class="gmax-live-lag" data-role="live-lag">LIVE • -${LIVE_DELAY_SECONDS}s</span>
    <button class="gmax-go-live" data-action="go-live" type="button" title="Return close to live">GO LIVE</button>
    <span class="gmax-player-spacer"></span>
    <div class="gmax-quality-wrap">
      <button class="gmax-player-button" data-action="quality" type="button" title="Quality">⚙</button>
      <div class="gmax-quality-menu" data-role="quality-menu"></div>
    </div>
    <button class="gmax-player-button" data-action="fullscreen" type="button" title="Fullscreen">⛶</button>
  `;
  shell.appendChild(controls);

  playerControls = controls;
  qualityMenu = controls.querySelector("[data-role='quality-menu']");

  const playButton = controls.querySelector("[data-action='play']");
  const muteButton = controls.querySelector("[data-action='mute']");
  const volumeInput = controls.querySelector("[data-action='volume']");
  const qualityButton = controls.querySelector("[data-action='quality']");
  const goLiveButton = controls.querySelector("[data-action='go-live']");
  const fullscreenButton = controls.querySelector("[data-action='fullscreen']");

  playButton.addEventListener("click", event => {
    event.stopPropagation();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    updatePlayerUi();
  });

  muteButton.addEventListener("click", event => {
    event.stopPropagation();
    video.muted = !video.muted;
    updatePlayerUi();
  });

  volumeInput.addEventListener("input", event => {
    event.stopPropagation();
    video.volume = Number(volumeInput.value);
    video.muted = video.volume === 0;
    updatePlayerUi();
  });

  goLiveButton.addEventListener("click", event => {
    event.stopPropagation();
    seekToConfiguredLivePosition();
    video.play().catch(() => {});
  });

  qualityButton.addEventListener("click", event => {
    event.stopPropagation();
    qualityMenu.classList.toggle("open");
  });

  fullscreenButton.addEventListener("click", event => {
    event.stopPropagation();
    toggleFullscreen();
  });

  shell.addEventListener("dblclick", event => {
    if (event.target.closest(".gmax-player-controls")) return;
    toggleFullscreen();
  });

  shell.addEventListener("mousemove", showPlayerControlsTemporarily, { passive: true });
  shell.addEventListener("touchstart", showPlayerControlsTemporarily, { passive: true });

  ["play", "pause", "loadedmetadata", "volumechange", "durationchange", "progress", "canplay"].forEach(eventName => {
    video.addEventListener(eventName, updatePlayerUi);
  });

  document.addEventListener("click", event => {
    if (!qualityMenu || event.target.closest(".gmax-quality-wrap")) return;
    qualityMenu.classList.remove("open");
  });

  window.addEventListener("keydown", handlePlayerKeyboard);
  setupAspectControls();
}

function setupAspectControls() {
  const buttons = [
    ...(staticAspectControls ? staticAspectControls.querySelectorAll("[data-aspect]") : []),
  ];

  if (!buttons.length) return;
  aspectControls = buttons;
  if (aspectControlsBound) return;
  aspectControlsBound = true;

  buttons.forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      const mode = button.dataset.aspect;
      setAspectMode(mode);
      buttons.forEach(item => item.classList.toggle("active", item === button));
    });
  });
}

function setAspectMode(mode) {
  const selected = String(mode || "normal");
  video.dataset.aspect = selected;
  video.style.objectFit = selected === "fill" ? "cover" : selected === "stretch" ? "fill" : "contain";
}

/* =========================================================
   PLAYER IDENTITY / RECENTS
========================================================= */

function updatePlayerIdentity() {
  if (!playerShell || !currentChannel) return;

  const art = playerShell.querySelector("[data-role='channel-art']");
  const title = playerShell.querySelector("[data-role='channel-title']");
  const meta = playerShell.querySelector("[data-role='channel-meta']");
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
  if (meta) meta.textContent = `${getCategory(currentChannel)} • ${getChannelSources(currentChannel).length} sources`;
}

/* =========================================================
   LIVE RANGE
========================================================= */

function getLiveSeekRange() {
  if (!shakaPlayer?.seekRange) return null;
  try {
    const range = shakaPlayer.seekRange();
    return Number.isFinite(range?.end) ? range : null;
  } catch {
    return null;
  }
}

function getCurrentLiveLag() {
  const range = getLiveSeekRange();
  if (!range || !Number.isFinite(video.currentTime)) return null;
  return Math.max(0, range.end - video.currentTime);
}

function seekToConfiguredLivePosition() {
  const range = getLiveSeekRange();
  if (!range) return seekNativeHlsToDelayedLive();

  const target = Math.max(range.start, range.end - LIVE_DELAY_SECONDS);
  try {
    shakaPlayer.seek(target);
    return true;
  } catch {
    try {
      video.currentTime = target;
      return true;
    } catch {
      return false;
    }
  }
}

function seekNativeHlsToDelayedLive() {
  try {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return false;
    video.currentTime = Math.max(0, video.duration - LIVE_DELAY_SECONDS);
    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   PLAYBACK
========================================================= */

async function openChannel(channel, requestedSourceIndex = 0) {
  if (!channel) return;

  currentAttemptToken += 1;
  const token = currentAttemptToken;
  currentChannel = channel;
  currentSourceIndex = requestedSourceIndex;
  playerReady = false;

  const id = getChannelId(channel);
  const sources = getChannelSources(channel);

  if (!sources.length) {
    setLoadingText("Reconnecting to live stream…");
    showPlayerLoading(true);
    return;
  }

  const safeIndex = Math.min(Math.max(Number(requestedSourceIndex) || 0, 0), sources.length - 1);
  currentSourceIndex = safeIndex;
  const source = sources[safeIndex];

  clearPlayerError();
  playerSection.classList.remove("hidden");
  playerEmpty.classList.add("hidden");
  playingTitle.textContent = channel.name || "Channel";
  playingMeta.textContent = `${getCategory(channel)} • ${sources.length} playback sources`;

  updatePlayerIdentity();
  ensurePlayerShell();
  setSourceStatus(source, safeIndex, sources.length, safeIndex === 0 ? "Connecting" : "Reconnecting");
  showPlayerLoading(true);

  history.replaceState(null, "", `?id=${encodeURIComponent(id || "")}`);
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (safeIndex === 0) rememberRecent(channel);

  await destroyPlayer();
  if (token !== currentAttemptToken || currentChannel !== channel) return;

  const streamUrl = appendCookieToUrl(source.stream_url, source.cookie);
  lastStreamUrl = streamUrl;
  lastStreamType = sourceType(source);

  try {
    if (lastStreamType === "dash") {
      await playWithShaka(streamUrl, source, token);
    } else if (lastStreamType === "hls") {
      await playHls(streamUrl, source, token);
    } else {
      throw new Error("Unsupported stream");
    }

    if (token !== currentAttemptToken) return;
    playerReady = true;
    setLoadingText(`${sourceLabel(source, safeIndex, sources.length)} • Connected`);
    showPlayerLoading(false);
    updatePlayerUi();
  } catch (error) {
    if (token !== currentAttemptToken) return;
    handlePlaybackFailure(error);
  }
}

async function playWithShaka(streamUrl, source, token) {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    throw new Error("Shaka unsupported");
  }

  shakaPlayer = new shaka.Player();
  shakaPlayer.configure({
    streaming: {
      bufferingGoal: BUFFERING_GOAL_SECONDS,
      rebufferingGoal: REBUFFERING_GOAL_SECONDS,
      bufferBehind: BUFFER_BEHIND_SECONDS,
      lowLatencyMode: false,
    },
    abr: { enabled: true },
  });

  configureClearKey(shakaPlayer, source);
  configureNetworking(shakaPlayer, source);

  await shakaPlayer.attach(video);
  await shakaPlayer.load(streamUrl);
  if (token !== currentAttemptToken) return;

  shakaPlayer.addEventListener("error", event => {
    if (token !== currentAttemptToken) return;
    handlePlaybackFailure(event?.detail || "stream error");
  });

  video.controls = false;
  setupPlayerUiOnce();
  seekToConfiguredLivePosition();
  updateQualityOptions();
  startLiveStatusTimer();
  video.play().catch(() => {});
}

async function playHls(streamUrl, source, token) {
  if (window.shaka && shaka.Player.isBrowserSupported()) {
    try {
      await playWithShaka(streamUrl, source, token);
      return;
    } catch (error) {
      if (token !== currentAttemptToken) throw error;
      await destroyPlayer();
    }
  }

  if (!video.canPlayType("application/vnd.apple.mpegurl")) {
    throw new Error("HLS unsupported");
  }

  video.controls = false;
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.src = streamUrl;
  video.load();
  setupPlayerUiOnce();
  updateQualityOptions();
  startLiveStatusTimer();
  const ready = await waitForVideoReady();
  if (token !== currentAttemptToken) return;
  if (!ready) throw new Error("HLS stream did not become ready");
  seekNativeHlsToDelayedLive();
  video.play().catch(() => {});

  const onError = () => {
    video.removeEventListener("error", onError);
    if (token === currentAttemptToken) handlePlaybackFailure(video.error || "HLS error");
  };
  video.addEventListener("error", onError, { once: true });
}

function waitForVideoReady() {
  return new Promise(resolve => {
    if (video.readyState >= 2) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("canplay", finish);
      resolve(true);
    };

    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("canplay", finish, { once: true });
    setTimeout(() => {
      if (done) return;
      done = true;
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("canplay", finish);
      resolve(video.readyState >= 2);
    }, 6000);
  });
}

function setupPlayerUiOnce() {
  ensurePlayerShell();
  updatePlayerIdentity();
  setupAspectControls();
}

/* =========================================================
   QUALITY
========================================================= */

function updateQualityOptions() {
  if (!qualityMenu) return;

  if (!shakaPlayer?.getVariantTracks) {
    qualityMenu.innerHTML = `<button class="gmax-quality-item active" type="button" disabled>Auto (native)</button>`;
    return;
  }

  const tracks = shakaPlayer.getVariantTracks().filter(track => track?.video && track?.height);
  const byHeight = new Map();

  for (const track of tracks) {
    const height = Number(track.height);
    const existing = byHeight.get(height);
    if (!existing || Number(track.bandwidth || 0) > Number(existing.bandwidth || 0)) {
      byHeight.set(height, track);
    }
  }

  const uniqueTracks = [...byHeight.values()].sort((a, b) => Number(b.height) - Number(a.height));

  qualityMenu.innerHTML = `
    <button class="gmax-quality-item active" data-quality="auto" type="button">Auto</button>
    ${uniqueTracks
      .map(track => `<button class="gmax-quality-item" data-quality-track="${Number(track.id)}" type="button">${Number(track.height)}p${track.frameRate ? ` • ${Math.round(track.frameRate)}fps` : ""}</button>`)
      .join("")}
  `;

  qualityMenu.querySelector("[data-quality='auto']")?.addEventListener("click", event => {
    event.stopPropagation();
    shakaPlayer.configure({ abr: { enabled: true } });
    setActiveQualityButton(event.currentTarget);
    qualityMenu.classList.remove("open");
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
  qualityMenu?.querySelectorAll(".gmax-quality-item").forEach(item => item.classList.toggle("active", item === activeButton));
}

/* =========================================================
   ASPECT + FULLSCREEN + KEYBOARD
========================================================= */

function toggleFullscreen() {
  const element = playerShell || videoContainer;
  if (!element) return;

  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    return;
  }

  if (element.requestFullscreen) {
    element.requestFullscreen().catch(() => {});
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
  }
}

function handlePlayerKeyboard(event) {
  if (!playerShell || playerSection.classList.contains("hidden")) return;
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "BUTTON"].includes(tag)) return;

  if (event.code === "Space") {
    event.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  } else if (event.key.toLowerCase() === "m") {
    video.muted = !video.muted;
  } else if (event.key.toLowerCase() === "f") {
    toggleFullscreen();
  }

  updatePlayerUi();
}

function showPlayerControlsTemporarily() {
  if (!playerShell) return;
  playerShell.classList.remove("gmax-controls-hidden");
  clearTimeout(playerShell._controlsTimer);
  playerShell._controlsTimer = setTimeout(() => {
    if (!qualityMenu?.classList.contains("open") && playerReady) playerShell.classList.add("gmax-controls-hidden");
  }, 3500);
}

/* =========================================================
   UI UPDATE
========================================================= */

function updatePlayerUi() {
  if (!playerControls) return;

  const playButton = playerControls.querySelector("[data-action='play']");
  const muteButton = playerControls.querySelector("[data-action='mute']");
  const volumeInput = playerControls.querySelector("[data-action='volume']");

  if (playButton) playButton.textContent = video.paused ? "▶" : "Ⅱ";
  if (muteButton) muteButton.textContent = video.muted || video.volume === 0 ? "🔇" : "🔊";
  if (volumeInput) volumeInput.value = String(video.volume);
  updateLiveStatus();
}

function startLiveStatusTimer() {
  if (liveStatusTimer) clearInterval(liveStatusTimer);
  liveStatusTimer = setInterval(updateLiveStatus, 1000);
  updateLiveStatus();
}

function updateLiveStatus() {
  const lagElement = playerControls?.querySelector("[data-role='live-lag']");
  if (!lagElement) return;

  const lag = getCurrentLiveLag();
  lagElement.textContent = lag == null ? `LIVE • -${LIVE_DELAY_SECONDS}s` : `LIVE • -${Math.max(0, Math.round(lag))}s`;
}

/* =========================================================
   CHANNEL DATA
========================================================= */

async function fetchChannels() {
  const response = await fetch(`${CHANNELS_URL}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`channels.json ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("channels.json is not an array");

  return data.filter(channel => channel && (channel.name || channel.stream_url || channel.url || channel.sources?.length));
}

async function loadChannels(initial = false) {
  try {
    const data = await fetchChannels();
    const previousCount = allChannels.length;

    allChannels = data;
    filteredChannels = [...data];

    channelCount.textContent = `${allChannels.length.toLocaleString()} channels`;
    resultsCount.textContent = `${allChannels.length.toLocaleString()} channels`;
    sourceCount.textContent = `${getUniqueM3uCount(allChannels)} M3Us loaded`;

    buildCategories();
    renderRecentChannels();
    applyFilters();

    if (initial) openRequestedChannel();
    if (!initial && previousCount !== allChannels.length) {
      renderRecentChannels();
    }
  } catch (error) {
    console.warn("Channel refresh failed:", error);
    if (initial) {
      channelCount.textContent = "Unable to load";
      sourceCount.textContent = "Retrying…";
      resultsCount.textContent = "0 channels";
      channelsGrid.innerHTML = `<div class="empty-grid"><strong>Live channels are reconnecting…</strong><br><br><span>Please try again in a moment.</span></div>`;
    }
  }
}

function startChannelRefresh() {
  if (channelRefreshTimer) clearInterval(channelRefreshTimer);
  channelRefreshTimer = setInterval(() => loadChannels(false), CHANNEL_REFRESH_MS);
}

function getRequestedChannelId() {
  return new URLSearchParams(window.location.search).get("id");
}

function openRequestedChannel() {
  const id = getRequestedChannelId();
  if (!id) return;

  const channel = allChannels.find(item => getChannelId(item) === String(id));
  if (!channel) return;

  setTimeout(() => openChannel(channel, 0), 150);
}

/* =========================================================
   CLOSE PLAYER
========================================================= */

closePlayerButton?.addEventListener("click", async () => {
  currentAttemptToken += 1;
  currentChannel = null;
  await destroyPlayer();

  video.pause();
  video.removeAttribute("src");
  video.load();
  playerSection.classList.add("hidden");
  playerEmpty.classList.remove("hidden");
  showPlayerLoading(false);
  clearPlayerError();

  history.replaceState(null, "", window.location.pathname);
});

/* =========================================================
   SEARCH / START
========================================================= */

searchInput?.addEventListener("input", () => {
  visibleCount = CHANNELS_PER_PAGE;
  resetInfiniteScroll();
  applyFilters();
});

loadMoreButton?.addEventListener("click", () => {
  visibleCount += CHANNELS_PER_PAGE;
  renderChannels();
});

window.addEventListener("beforeunload", () => {
  if (channelRefreshTimer) clearInterval(channelRefreshTimer);
  if (liveStatusTimer) clearInterval(liveStatusTimer);
});

document.addEventListener("DOMContentLoaded", () => {
  hideLoadMore();
  setAspectMode("normal");
  loadChannels(true);
  startChannelRefresh();
});
