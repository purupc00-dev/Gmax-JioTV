"use strict";

/* =========================================================
   GMAX JIOTV PLAYER
   ========================================================= */

const CHANNELS_URL = "./channels.json";

const CHANNELS_PER_PAGE = 60;
const CHANNEL_REFRESH_MS = 10 * 60 * 1000;

const LIVE_DELAY_SECONDS = 15;

const BUFFERING_GOAL_SECONDS = 25;
const REBUFFERING_GOAL_SECONDS = 6;
const BUFFER_BEHIND_SECONDS = 45;

const RETRY_DELAY_MS = 1200;
const MAX_FULL_RETRY_CYCLES = 2;

/*
 * Preferred fallback order.
 *
 * First:
 *   JioTV 6
 *   JioTV 7
 *   JioTV 8
 *
 * Then:
 *   Star
 *   Sony
 *   Voot
 *   Sports
 *   etc.
 */
const SOURCE_PRIORITY = [
  "jtvplus6",
  "jtvplus7",
  "jtvplus8"
];

/* =========================================================
   STATE
   ========================================================= */

let allChannels = [];
let filteredChannels = [];

let activeCategory = "ALL";
let visibleCount = CHANNELS_PER_PAGE;

let currentChannel = null;

let shakaPlayer = null;

let currentSource = null;
let playbackCandidates = [];
let playbackIndex = 0;
let retryCycle = 0;

let isOpeningChannel = false;
let isRetrying = false;

let playerShell = null;
let playerControls = null;
let qualityMenu = null;

let playerUiTimer = null;
let liveStatusTimer = null;
let refreshTimer = null;

let infiniteScrollObserver = null;
let infiniteScrollBusy = false;

let selectedFitMode =
  localStorage.getItem("gmax-player-fit-mode") || "normal";

/* =========================================================
   FAVORITES
   ========================================================= */

const favorites = new Set(
  JSON.parse(
    localStorage.getItem("gmax-jiotv-favorites") || "[]"
  )
);

/* =========================================================
   DOM
   ========================================================= */

const channelsGrid =
  document.getElementById("channels-grid");

const categoryList =
  document.getElementById("category-list");

const searchInput =
  document.getElementById("search-input");

const channelCount =
  document.getElementById("channel-count");

const resultsCount =
  document.getElementById("results-count");

const loadMore =
  document.getElementById("load-more");

const loadMoreButton =
  document.getElementById("load-more-button");

const playerSection =
  document.getElementById("player-section");

const video =
  document.getElementById("video");

const playingTitle =
  document.getElementById("playing-title");

const playingMeta =
  document.getElementById("playing-meta");

const playerLoading =
  document.getElementById("player-loading");

const playerLoadingText =
  document.getElementById("player-loading-text") ||
  playerLoading?.querySelector("span");

const playerEmpty =
  document.getElementById("player-empty");

const playerError =
  document.getElementById("player-error");

const closePlayerButton =
  document.getElementById("close-player");

/* =========================================================
   BASIC HELPERS
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
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function getChannelId(channel) {
  return String(
    channel?.id ??
    channel?.tvgId ??
    channel?.tvg_id ??
    channel?.name ??
    ""
  );
}

function getChannelName(channel) {
  return (
    channel?.name ||
    channel?.tvg_name ||
    "Unknown Channel"
  );
}

function getChannelLogo(channel) {
  return (
    channel?.logo ||
    channel?.tvg_logo ||
    ""
  );
}

function getCategory(channel) {
  return (
    channel?.category ||
    channel?.group ||
    channel?.groupTitle ||
    "Entertainment"
  );
}

function getStreamUrl(source) {
  return (
    source?.stream_url ||
    source?.url ||
    ""
  );
}

function getStreamType(source) {
  const url = String(
    getStreamUrl(source)
  ).toLowerCase();

  if (url.includes(".mpd")) {
    return "dash";
  }

  if (url.includes(".m3u8")) {
    return "hls";
  }

  return "unknown";
}

/* =========================================================
   COOKIE / URL HELPERS
   ========================================================= */

function addCookieToUrl(url, cookie) {
  if (!url || !cookie) {
    return url;
  }

  if (
    url.includes("__hdnea__=") ||
    url.includes(cookie)
  ) {
    return url;
  }

  const separator =
    url.includes("?") ? "&" : "?";

  return `${url}${separator}${cookie}`;
}

function cleanSource(source) {
  if (!source) {
    return null;
  }

  const streamUrl =
    getStreamUrl(source);

  if (!streamUrl) {
    return null;
  }

  return {
    server:
      source.server ||
      source.source ||
      source.name ||
      "Unknown",

    m3u:
      source.m3u ||
      "",

    stream_url:
      streamUrl,

    cookie:
      source.cookie ||
      "",

    key_id:
      source.key_id ||
      "",

    key:
      source.key ||
      "",

    referrer:
      source.referrer ||
      source.referer ||
      "",

    user_agent:
      source.user_agent ||
      ""
  };
}

/* =========================================================
   SOURCE PRIORITY
   ========================================================= */

function sourceRank(source) {
  const server = normalize(
    source?.server || ""
  );

  const index =
    SOURCE_PRIORITY.findIndex(
      item =>
        normalize(item) === server
    );

  if (index >= 0) {
    return index;
  }

  return 1000;
}

function sourceSort(a, b) {
  const rankA = sourceRank(a);
  const rankB = sourceRank(b);

  if (rankA !== rankB) {
    return rankA - rankB;
  }

  return String(a.server || "")
    .localeCompare(
      String(b.server || "")
    );
}

/* =========================================================
   BUILD ALL PLAYBACK CANDIDATES
   ========================================================= */

function buildPlaybackCandidates(channel) {
  const candidates = [];

  /*
   * 1. New format:
   *
   * channel.sources = [
   *   { server, stream_url, ... }
   * ]
   */
  if (
    Array.isArray(channel?.sources)
  ) {
    for (
      const source of channel.sources
    ) {
      const cleaned =
        cleanSource(source);

      if (cleaned) {
        candidates.push(cleaned);
      }
    }
  }

  /*
   * 2. Older format:
   *
   * channel.stream_url = ...
   */
  if (
    channel?.stream_url ||
    channel?.url
  ) {
    const primary =
      cleanSource({
        server:
          channel.source_m3u ||
          "jtvplus6",

        m3u:
          channel.source_m3u ||
          "",

        stream_url:
          channel.stream_url ||
          channel.url,

        cookie:
          channel.cookie,

        key_id:
          channel.key_id,

        key:
          channel.key,

        referrer:
          channel.referrer ||
          channel.referer,

        user_agent:
          channel.user_agent
      });

    if (primary) {
      candidates.push(primary);
    }
  }

  /*
   * 3. Older fallbacks array.
   */
  if (
    Array.isArray(channel?.fallbacks)
  ) {
    for (
      const fallback of channel.fallbacks
    ) {
      const cleaned =
        cleanSource(fallback);

      if (cleaned) {
        candidates.push(cleaned);
      }
    }
  }

  /*
   * Remove duplicates.
   */
  const unique = [];
  const seen = new Set();

  for (
    const source of candidates
  ) {
    const key = [
      normalize(source.server),
      getStreamUrl(source)
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(source);
  }

  /*
   * Preferred order:
   *
   * 6 → 7 → 8 → all other M3Us
   */
  unique.sort(sourceSort);

  return unique;
}

/* =========================================================
   FAVORITES
   ========================================================= */

function saveFavorites() {
  localStorage.setItem(
    "gmax-jiotv-favorites",
    JSON.stringify(
      [...favorites]
    )
  );
}

function toggleFavorite(id) {
  const key = String(id);

  if (favorites.has(key)) {
    favorites.delete(key);
  } else {
    favorites.add(key);
  }

  saveFavorites();
  renderChannels();
}

/* =========================================================
   CATEGORIES
   ========================================================= */

function buildCategories() {
  const categories = new Set();

  for (
    const channel of allChannels
  ) {
    const category =
      getCategory(channel);

    if (category) {
      categories.add(category);
    }
  }

  const sorted =
    [...categories].sort(
      (a, b) =>
        String(a).localeCompare(
          String(b)
        )
    );

  categoryList.innerHTML = "";

  categoryList.appendChild(
    createCategoryButton(
      "ALL",
      activeCategory === "ALL"
    )
  );

  for (
    const category of sorted
  ) {
    categoryList.appendChild(
      createCategoryButton(
        category,
        normalize(category) ===
          normalize(activeCategory)
      )
    );
  }
}

function createCategoryButton(
  category,
  active
) {
  const button =
    document.createElement(
      "button"
    );

  button.type = "button";

  button.className =
    "category-button" +
    (active ? " active" : "");

  button.textContent =
    String(category);

  button.addEventListener(
    "click",
    () => {
      activeCategory = category;
      visibleCount =
        CHANNELS_PER_PAGE;

      if (
        infiniteScrollObserver
      ) {
        infiniteScrollObserver.disconnect();
        infiniteScrollObserver = null;
      }

      const oldSentinel =
        document.getElementById(
          "gmax-infinite-scroll-sentinel"
        );

      if (oldSentinel) {
        oldSentinel.remove();
      }

      buildCategories();
      applyFilters();
    }
  );

  return button;
}

/* =========================================================
   FILTERS
   ========================================================= */

function applyFilters() {
  const query =
    normalize(
      searchInput.value
    );

  filteredChannels =
    allChannels.filter(
      channel => {
        const category =
          getCategory(channel);

        const matchesCategory =
          activeCategory === "ALL" ||
          normalize(category) ===
            normalize(activeCategory);

        if (!matchesCategory) {
          return false;
        }

        if (!query) {
          return true;
        }

        const searchable = [
          channel?.name,
          channel?.id,
          channel?.group,
          channel?.category,
          channel?.language,
          channel?.country
        ]
          .map(normalize)
          .join(" ");

        return searchable.includes(
          query
        );
      }
    );

  resultsCount.textContent =
    `${filteredChannels.length.toLocaleString()} channels`;

  visibleCount =
    Math.min(
      visibleCount,
      filteredChannels.length
    );

  renderChannels();
}

/* =========================================================
   CHANNEL RENDER
   ========================================================= */

function renderChannels() {
  if (!channelsGrid) {
    return;
  }

  const visible =
    filteredChannels.slice(
      0,
      visibleCount
    );

  channelsGrid.innerHTML = "";

  if (!visible.length) {
    channelsGrid.innerHTML = `
      <div class="empty-grid">
        No channels found.
      </div>
    `;

    hideLoadMore();
    return;
  }

  const fragment =
    document.createDocumentFragment();

  for (
    const channel of visible
  ) {
    fragment.appendChild(
      createChannelCard(channel)
    );
  }

  channelsGrid.appendChild(
    fragment
  );

  hideLoadMore();

  setupInfiniteScroll();
}

function createChannelCard(channel) {
  const card =
    document.createElement(
      "article"
    );

  card.className =
    "channel-card";

  const id =
    getChannelId(channel);

  const favorite =
    favorites.has(id);

  const logo =
    getChannelLogo(channel);

  const group =
    getCategory(channel);

  card.innerHTML = `
    <button
      class="favorite-button ${
        favorite ? "active" : ""
      }"
      type="button"
      aria-label="Favorite"
    >
      ${favorite ? "♥" : "♡"}
    </button>

    <div class="channel-logo-wrap">
      ${
        logo
          ? `
            <img
              class="channel-logo"
              src="${escapeHtml(logo)}"
              alt="${escapeHtml(getChannelName(channel))}"
              loading="lazy"
              referrerpolicy="no-referrer"
              onerror="
                this.style.display='none';
                this.nextElementSibling.style.display='flex';
              "
            >
          `
          : ""
      }

      <div
        class="channel-fallback"
        style="
          display:${
            logo
              ? "none"
              : "flex"
          };
        "
      >
        TV
      </div>
    </div>

    <div class="channel-info">
      <div class="channel-name">
        ${escapeHtml(
          getChannelName(channel)
        )}
      </div>

      <div class="channel-meta">
        LIVE •
        ${escapeHtml(
          channel?.country ||
          "INDIA"
        )}
        •
        ${escapeHtml(group)}
      </div>
    </div>
  `;

  const favoriteButton =
    card.querySelector(
      ".favorite-button"
    );

  favoriteButton.addEventListener(
    "click",
    event => {
      event.stopPropagation();
      toggleFavorite(id);
    }
  );

  card.addEventListener(
    "click",
    () => {
      openChannel(channel);
    }
  );

  return card;
}

/* =========================================================
   INFINITE SCROLL
   ========================================================= */

function setupInfiniteScroll() {
  if (
    infiniteScrollObserver
  ) {
    infiniteScrollObserver.disconnect();
    infiniteScrollObserver = null;
  }

  const oldSentinel =
    document.getElementById(
      "gmax-infinite-scroll-sentinel"
    );

  if (oldSentinel) {
    oldSentinel.remove();
  }

  if (
    visibleCount >=
    filteredChannels.length
  ) {
    return;
  }

  const sentinel =
    document.createElement(
      "div"
    );

  sentinel.id =
    "gmax-infinite-scroll-sentinel";

  sentinel.style.height = "1px";

  channelsGrid.parentElement.appendChild(
    sentinel
  );

  infiniteScrollObserver =
    new IntersectionObserver(
      entries => {
        const entry =
          entries[0];

        if (
          !entry.isIntersecting ||
          infiniteScrollBusy
        ) {
          return;
        }

        if (
          visibleCount >=
          filteredChannels.length
        ) {
          return;
        }

        infiniteScrollBusy = true;

        visibleCount +=
          CHANNELS_PER_PAGE;

        renderChannels();

        requestAnimationFrame(
          () => {
            infiniteScrollBusy = false;
          }
        );
      },
      {
        root: null,
        rootMargin:
          "1000px 0px",
        threshold: 0
      }
    );

  infiniteScrollObserver.observe(
    sentinel
  );
}

function hideLoadMore() {
  if (loadMore) {
    loadMore.classList.add(
      "hidden"
    );

    loadMore.style.display =
      "none";
  }

  if (loadMoreButton) {
    loadMoreButton.style.display =
      "none";
  }
}

/* =========================================================
   LIVE HELPERS
   ========================================================= */

function getLiveSeekRange() {
  if (
    !shakaPlayer ||
    typeof shakaPlayer.seekRange !==
      "function"
  ) {
    return null;
  }

  try {
    const range =
      shakaPlayer.seekRange();

    if (
      !range ||
      !Number.isFinite(
        range.end
      )
    ) {
      return null;
    }

    return range;
  } catch {
    return null;
  }
}

function getLiveLag() {
  const range =
    getLiveSeekRange();

  if (
    !range ||
    !Number.isFinite(
      video.currentTime
    )
  ) {
    return null;
  }

  return Math.max(
    0,
    range.end -
      video.currentTime
  );
}

function getTargetLiveTime() {
  const range =
    getLiveSeekRange();

  if (!range) {
    return null;
  }

  return Math.max(
    range.start,
    range.end -
      LIVE_DELAY_SECONDS
  );
}

function seekToConfiguredLivePosition() {
  const target =
    getTargetLiveTime();

  if (target === null) {
    return false;
  }

  try {
    shakaPlayer.seek(
      target
    );

    return true;
  } catch {
    try {
      video.currentTime =
        target;

      return true;
    } catch {
      return false;
    }
  }
}

/* =========================================================
   PLAYER UI
   ========================================================= */

function setLoadingText(text) {
  if (
    playerLoadingText
  ) {
    playerLoadingText.textContent =
      text;
  }
}

function showLoading(
  show,
  text = "Connecting…"
) {
  if (!playerLoading) {
    return;
  }

  playerLoading.classList.toggle(
    "hidden",
    !show
  );

  if (show) {
    setLoadingText(text);
  }
}

function showPlayerError(message) {
  /*
   * DO NOT expose technical
   * Shaka / HTTP errors.
   */
  const safeMessage =
    message ||
    "The channel could not be played.";

  if (playerError) {
    playerError.textContent =
      safeMessage;

    playerError.classList.remove(
      "hidden"
    );
  }

  if (playerShell) {
    const overlay =
      playerShell.querySelector(
        '[data-role="error"]'
      );

    if (overlay) {
      const text =
        overlay.querySelector(
          '[data-role="error-message"]'
        );

      if (text) {
        text.textContent =
          safeMessage;
      }

      overlay.classList.add(
        "open"
      );
    }
  }
}

function clearPlayerError() {
  if (playerError) {
    playerError.textContent =
      "";

    playerError.classList.add(
      "hidden"
    );
  }

  if (playerShell) {
    const overlay =
      playerShell.querySelector(
        '[data-role="error"]'
      );

    if (overlay) {
      overlay.classList.remove(
        "open"
      );
    }
  }
}

/* =========================================================
   PLAYER STYLES
   ========================================================= */

function injectPlayerStyles() {
  if (
    document.getElementById(
      "gmax-player-styles"
    )
  ) {
    return;
  }

  const style =
    document.createElement(
      "style"
    );

  style.id =
    "gmax-player-styles";

  style.textContent = `
    .gmax-player-shell {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 9;
      min-height: 260px;
      background: #000;
      overflow: hidden;
      border-radius: 18px;
      isolation: isolate;
      touch-action: manipulation;
    }

    .gmax-player-shell video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      background: #000;
      object-fit: contain;
    }

    .gmax-player-gradient {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 180px;
      pointer-events: none;
      background:
        linear-gradient(
          to bottom,
          transparent,
          rgba(0,0,0,.88)
        );
      z-index: 2;
    }

    .gmax-player-top {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      z-index: 5;
      padding: 16px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
      background:
        linear-gradient(
          to bottom,
          rgba(0,0,0,.72),
          transparent
        );
      pointer-events: none;
    }

    .gmax-now-playing {
      display: flex;
      gap: 10px;
      min-width: 0;
    }

    .gmax-channel-art {
      width: 44px;
      height: 44px;
      object-fit: contain;
      border-radius: 10px;
      background: rgba(255,255,255,.08);
      padding: 4px;
    }

    .gmax-now-copy {
      min-width: 0;
    }

    .gmax-now-label {
      color: #ff2b83;
      font: 900 9px/1 system-ui;
      letter-spacing: .12em;
      margin-bottom: 4px;
    }

    .gmax-now-title {
      color: #fff;
      font: 800 16px/1.2 system-ui;
      max-width: 55vw;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }

    .gmax-now-meta {
      color: rgba(255,255,255,.65);
      font: 500 10px/1.3 system-ui;
      margin-top: 3px;
    }

    .gmax-live-badge {
      margin-left: auto;
      color: #fff;
      background: rgba(229,9,20,.95);
      border-radius: 999px;
      padding: 7px 10px;
      font: 900 9px/1 system-ui;
      pointer-events: none;
    }

    .gmax-player-controls {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 8;
      display: flex;
      align-items: center;
      gap: 8px;
      padding:
        58px 14px
        13px;
      color: #fff;
      background:
        linear-gradient(
          transparent,
          rgba(0,0,0,.94)
        );
      transition:
        opacity .2s,
        transform .2s;
    }

    .gmax-player-shell
      .gmax-player-controls {
      opacity: 1;
      transform: translateY(0);
    }

    .gmax-player-shell
      .gmax-player-controls.hidden-controls {
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
    }

    .gmax-player-button {
      width: 38px;
      height: 38px;
      border: 0;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: rgba(255,255,255,.12);
      color: #fff;
      cursor: pointer;
      font: 700 15px/1 system-ui;
      flex: 0 0 auto;
      -webkit-tap-highlight-color: transparent;
    }

    .gmax-volume {
      width: 78px;
      max-width: 20vw;
    }

    .gmax-live-lag {
      color: rgba(255,255,255,.8);
      font: 700 11px/1 system-ui;
      white-space: nowrap;
    }

    .gmax-player-spacer {
      flex: 1;
    }

    .gmax-go-live {
      border: 1px solid rgba(255,43,131,.5);
      background: rgba(255,43,131,.12);
      color: #fff;
      padding: 9px 11px;
      border-radius: 10px;
      font: 800 10px/1 system-ui;
      cursor: pointer;
    }

    .gmax-quality-wrap {
      position: relative;
    }

    .gmax-quality-menu {
      position: absolute;
      bottom: 48px;
      right: 0;
      width: 180px;
      max-height: 280px;
      overflow-y: auto;
      background: rgba(15,15,18,.97);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 13px;
      padding: 6px;
      display: none;
      z-index: 100;
    }

    .gmax-quality-menu.open {
      display: block;
    }

    .gmax-quality-item {
      width: 100%;
      border: 0;
      padding: 9px 10px;
      text-align: left;
      border-radius: 8px;
      color: #fff;
      background: transparent;
      cursor: pointer;
      font: 700 12px system-ui;
    }

    .gmax-quality-item:hover,
    .gmax-quality-item.active {
      background: rgba(255,43,131,.18);
    }

    .gmax-spinner {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 36px;
      height: 36px;
      margin: -18px 0 0 -18px;
      border-radius: 50%;
      border: 3px solid rgba(255,255,255,.15);
      border-top-color: #fff;
      animation: gmaxSpin .8s linear infinite;
      z-index: 9;
      display: none;
    }

    @keyframes gmaxSpin {
      to {
        transform: rotate(360deg);
      }
    }

    .gmax-player-error {
      position: absolute;
      inset: 0;
      z-index: 20;
      display: none;
      place-items: center;
      padding: 20px;
      text-align: center;
      background: rgba(0,0,0,.74);
    }

    .gmax-player-error.open {
      display: grid;
    }

    .gmax-error-box {
      max-width: 340px;
    }

    .gmax-error-title {
      color: #fff;
      font: 900 18px system-ui;
      margin-bottom: 8px;
    }

    .gmax-error-message {
      color: rgba(255,255,255,.7);
      font: 500 12px/1.4 system-ui;
      margin-bottom: 15px;
    }

    .gmax-retry-button {
      border: 0;
      border-radius: 10px;
      padding: 10px 15px;
      color: #fff;
      background: #ff2b83;
      font: 800 11px system-ui;
      cursor: pointer;
    }

    /* ============================
       VIDEO MODES
       ============================ */

    .gmax-fit-normal {
      object-fit: contain !important;
    }

    .gmax-fit-fit {
      object-fit: contain !important;
    }

    .gmax-fit-fill {
      object-fit: cover !important;
    }

    .gmax-fit-stretch {
      object-fit: fill !important;
    }

    /* ============================
       MOBILE / ANDROID
       ============================ */

    @media (max-width: 700px) {
      .gmax-player-shell {
        aspect-ratio: 16 / 9;
        min-height: 210px;
        border-radius: 12px;
      }

      .gmax-player-controls {
        gap: 5px;
        padding:
          50px 8px
          9px;
      }

      .gmax-player-button {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        font-size: 13px;
      }

      .gmax-volume {
        display: none;
      }

      .gmax-live-lag {
        display: none;
      }

      .gmax-go-live {
        padding: 8px;
        font-size: 9px;
      }

      .gmax-channel-art {
        width: 36px;
        height: 36px;
      }

      .gmax-now-title {
        font-size: 13px;
        max-width: 46vw;
      }

      .gmax-now-meta {
        font-size: 9px;
      }

      .gmax-live-badge {
        padding: 6px 8px;
        font-size: 8px;
      }
    }
  `;

  document.head.appendChild(
    style
  );
}

/* =========================================================
   PLAYER SETUP
   ========================================================= */

function setupPlayer() {
  if (!video) {
    return;
  }

  injectPlayerStyles();

  let shell =
    video.closest(
      ".gmax-player-shell"
    );

  if (!shell) {
    const parent =
      video.parentElement;

    if (!parent) {
      return;
    }

    shell =
      document.createElement(
        "div"
      );

    shell.className =
      "gmax-player-shell";

    parent.insertBefore(
      shell,
      video
    );

    shell.appendChild(
      video
    );
  }

  playerShell = shell;

  applyFitMode();

  if (!playerControls) {
    createPlayerControls(
      shell
    );
  }

  updatePlayerIdentity();
}

function createPlayerControls(shell) {
  const gradient =
    document.createElement(
      "div"
    );

  gradient.className =
    "gmax-player-gradient";

  shell.appendChild(
    gradient
  );

  const top =
    document.createElement(
      "div"
    );

  top.className =
    "gmax-player-top";

  top.innerHTML = `
    <div class="gmax-now-playing">
      <img
        class="gmax-channel-art"
        data-role="channel-art"
        alt=""
      >

      <div class="gmax-now-copy">
        <div class="gmax-now-label">
          NOW PLAYING
        </div>

        <div
          class="gmax-now-title"
          data-role="channel-title"
        >
          Live TV
        </div>

        <div
          class="gmax-now-meta"
          data-role="channel-meta"
        >
          LIVE
        </div>
      </div>
    </div>

    <div class="gmax-live-badge">
      ● LIVE
    </div>
  `;

  shell.appendChild(
    top
  );

  const spinner =
    document.createElement(
      "div"
    );

  spinner.className =
    "gmax-spinner";

  spinner.dataset.role =
    "spinner";

  shell.appendChild(
    spinner
  );

  const error =
    document.createElement(
      "div"
    );

  error.className =
    "gmax-player-error";

  error.dataset.role =
    "error";

  error.innerHTML = `
    <div class="gmax-error-box">
      <div class="gmax-error-title">
        Reconnecting…
      </div>

      <div
        class="gmax-error-message"
        data-role="error-message"
      >
        Trying another stream…
      </div>

      <button
        class="gmax-retry-button"
        type="button"
        data-action="retry"
      >
        RECONNECT
      </button>
    </div>
  `;

  shell.appendChild(
    error
  );

  const controls =
    document.createElement(
      "div"
    );

  controls.className =
    "gmax-player-controls";

  controls.innerHTML = `
    <button
      class="gmax-player-button"
      data-action="play"
      type="button"
      title="Play"
    >
      ▶
    </button>

    <button
      class="gmax-player-button"
      data-action="mute"
      type="button"
      title="Mute"
    >
      🔊
    </button>

    <input
      class="gmax-volume"
      data-action="volume"
      type="range"
      min="0"
      max="1"
      step="0.05"
      value="1"
      aria-label="Volume"
    >

    <span
      class="gmax-live-lag"
      data-role="live-lag"
    >
      LIVE
    </span>

    <button
      class="gmax-go-live"
      data-action="go-live"
      type="button"
    >
      GO LIVE
    </button>

    <span class="gmax-player-spacer"></span>

    <div class="gmax-quality-wrap">
      <button
        class="gmax-player-button"
        data-action="quality"
        type="button"
        title="Quality"
      >
        ⚙
      </button>

      <div
        class="gmax-quality-menu"
        data-role="quality-menu"
      ></div>
    </div>

    <button
      class="gmax-player-button"
      data-action="fit"
      type="button"
      title="Video fit"
    >
      FIT
    </button>

    <button
      class="gmax-player-button"
      data-action="fullscreen"
      type="button"
      title="Fullscreen"
    >
      ⛶
    </button>
  `;

  shell.appendChild(
    controls
  );

  playerControls =
    controls;

  qualityMenu =
    controls.querySelector(
      '[data-role="quality-menu"]'
    );

  /* PLAY */

  controls
    .querySelector(
      '[data-action="play"]'
    )
    .addEventListener(
      "click",
      async event => {
        event.stopPropagation();

        if (video.paused) {
          await video
            .play()
            .catch(() => {});
        } else {
          video.pause();
        }

        updatePlayerUi();
      }
    );

  /* MUTE */

  controls
    .querySelector(
      '[data-action="mute"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        video.muted =
          !video.muted;

        updatePlayerUi();
      }
    );

  /* VOLUME */

  controls
    .querySelector(
      '[data-action="volume"]'
    )
    .addEventListener(
      "input",
      event => {
        event.stopPropagation();

        video.volume =
          Number(
            event.target.value
          );

        video.muted =
          video.volume === 0;

        updatePlayerUi();
      }
    );

  /* GO LIVE */

  controls
    .querySelector(
      '[data-action="go-live"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        if (
          seekToConfiguredLivePosition()
        ) {
          video
            .play()
            .catch(() => {});
        }

        updatePlayerUi();
      }
    );

  /* QUALITY */

  controls
    .querySelector(
      '[data-action="quality"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        qualityMenu.classList.toggle(
          "open"
        );
      }
    );

  /* FIT */

  controls
    .querySelector(
      '[data-action="fit"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        cycleFitMode();
      }
    );

  /* FULLSCREEN */

  controls
    .querySelector(
      '[data-action="fullscreen"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        toggleFullscreen();
      }
    );

  /* RETRY */

  error
    .querySelector(
      '[data-action="retry"]'
    )
    .addEventListener(
      "click",
      event => {
        event.stopPropagation();

        reconnectCurrentChannel();
      }
    );

  /* VIDEO EVENTS */

  [
    "play",
    "pause",
    "loadedmetadata",
    "volumechange",
    "durationchange",
    "progress",
    "canplay",
    "waiting",
    "playing"
  ].forEach(
    eventName => {
      video.addEventListener(
        eventName,
        updatePlayerUi
      );
    }
  );

  /* TOUCH */

  shell.addEventListener(
    "touchstart",
    () => {
      showControlsTemporarily();
    },
    {
      passive: true
    }
  );

  shell.addEventListener(
    "mousemove",
    () => {
      showControlsTemporarily();
    }
  );

  /* DOUBLE CLICK */

  shell.addEventListener(
    "dblclick",
    event => {
      if (
        event.target.closest(
          ".gmax-player-controls"
        )
      ) {
        return;
      }

      toggleFullscreen();
    }
  );

  /* CLOSE QUALITY */

  document.addEventListener(
    "click",
    event => {
      if (
        !qualityMenu
      ) {
        return;
      }

      if (
        !event.target.closest(
          ".gmax-quality-wrap"
        )
      ) {
        qualityMenu.classList.remove(
          "open"
        );
      }
    }
  );

  /* KEYBOARD */

  window.addEventListener(
    "keydown",
    handleKeyboard
  );

  updatePlayerUi();
}

/* =========================================================
   FIT / STRETCH / FILL
   ========================================================= */

function applyFitMode() {
  if (!video) {
    return;
  }

  video.classList.remove(
    "gmax-fit-normal",
    "gmax-fit-fit",
    "gmax-fit-fill",
    "gmax-fit-stretch"
  );

  video.classList.add(
    `gmax-fit-${selectedFitMode}`
  );
}

function cycleFitMode() {
  const modes = [
    "normal",
    "fit",
    "fill",
    "stretch"
  ];

  const currentIndex =
    modes.indexOf(
      selectedFitMode
    );

  selectedFitMode =
    modes[
      (currentIndex + 1) %
      modes.length
    ];

  localStorage.setItem(
    "gmax-player-fit-mode",
    selectedFitMode
  );

  applyFitMode();

  const button =
    playerControls?.querySelector(
      '[data-action="fit"]'
    );

  if (button) {
    button.textContent =
      selectedFitMode.toUpperCase();
  }
}

/* =========================================================
   PLAYER IDENTITY
   ========================================================= */

function updatePlayerIdentity() {
  if (
    !playerShell ||
    !currentChannel
  ) {
    return;
  }

  const art =
    playerShell.querySelector(
      '[data-role="channel-art"]'
    );

  const title =
    playerShell.querySelector(
      '[data-role="channel-title"]'
    );

  const meta =
    playerShell.querySelector(
      '[data-role="channel-meta"]'
    );

  const logo =
    getChannelLogo(
      currentChannel
    );

  if (art) {
    if (logo) {
      art.src = logo;
      art.style.display =
        "block";
    } else {
      art.removeAttribute(
        "src"
      );

      art.style.display =
        "none";
    }
  }

  if (title) {
    title.textContent =
      getChannelName(
        currentChannel
      );
  }

  if (meta) {
    meta.textContent =
      [
        "LIVE",
        currentSource?.server ||
          "JIO TV",
        getCategory(
          currentChannel
        )
      ]
        .filter(Boolean)
        .join(" • ");
  }
}

/* =========================================================
   CONTROLS
   ========================================================= */

function showControlsTemporarily() {
  if (!playerControls) {
    return;
  }

  playerControls.classList.remove(
    "hidden-controls"
  );

  clearTimeout(
    playerUiTimer
  );

  playerUiTimer =
    setTimeout(
      () => {
        if (
          !video.paused
        ) {
          playerControls.classList.add(
            "hidden-controls"
          );
        }
      },
      3000
    );
}

function updatePlayerUi() {
  if (
    !playerControls
  ) {
    return;
  }

  const playButton =
    playerControls.querySelector(
      '[data-action="play"]'
    );

  const muteButton =
    playerControls.querySelector(
      '[data-action="mute"]'
    );

  const volume =
    playerControls.querySelector(
      '[data-action="volume"]'
    );

  const lag =
    playerControls.querySelector(
      '[data-role="live-lag"]'
    );

  const fitButton =
    playerControls.querySelector(
      '[data-action="fit"]'
    );

  if (playButton) {
    playButton.textContent =
      video.paused
        ? "▶"
        : "⏸";
  }

  if (muteButton) {
    muteButton.textContent =
      video.muted
        ? "🔇"
        : "🔊";
  }

  if (volume) {
    volume.value =
      video.muted
        ? "0"
        : String(
            video.volume
          );
  }

  if (fitButton) {
    fitButton.textContent =
      selectedFitMode.toUpperCase();
  }

  if (lag) {
    const liveLag =
      getLiveLag();

    if (
      liveLag === null
    ) {
      lag.textContent =
        "LIVE";
    } else {
      lag.textContent =
        `LIVE • -${Math.round(
          liveLag
        )}s`;
    }
  }

  updatePlayerIdentity();
}

function handleKeyboard(
  event
) {
  if (
    !playerShell ||
    playerSection?.classList.contains(
      "hidden"
    )
  ) {
    return;
  }

  const target =
    event.target;

  if (
    target &&
    (
      target.tagName ===
        "INPUT" ||
      target.tagName ===
        "TEXTAREA" ||
      target.isContentEditable
    )
  ) {
    return;
  }

  const key =
    String(
      event.key
    ).toLowerCase();

  if (key === " ") {
    event.preventDefault();

    if (video.paused) {
      video
        .play()
        .catch(() => {});
    } else {
      video.pause();
    }
  }

  if (key === "m") {
    video.muted =
      !video.muted;
  }

  if (key === "f") {
    toggleFullscreen();
  }

  if (key === "g") {
    seekToConfiguredLivePosition();
  }

  if (key === "arrowup") {
    event.preventDefault();

    video.volume =
      Math.min(
        1,
        video.volume + 0.05
      );

    video.muted =
      false;
  }

  if (key === "arrowdown") {
    event.preventDefault();

    video.volume =
      Math.max(
        0,
        video.volume - 0.05
      );
  }

  updatePlayerUi();
  showControlsTemporarily();
}

async function toggleFullscreen() {
  if (!playerShell) {
    return;
  }

  try {
    if (
      document.fullscreenElement
    ) {
      await document.exitFullscreen();
      return;
    }

    if (
      playerShell.requestFullscreen
    ) {
      await playerShell.requestFullscreen();
    }
  } catch {
    /* Ignore mobile fullscreen quirks */
  }
}

/* =========================================================
   QUALITY
   ========================================================= */

function updateQualityOptions() {
  if (!qualityMenu) {
    return;
  }

  qualityMenu.innerHTML =
    "";

  if (
    !shakaPlayer
  ) {
    qualityMenu.innerHTML = `
      <button
        class="gmax-quality-item active"
        type="button"
      >
        Auto
      </button>
    `;

    return;
  }

  const tracks =
    shakaPlayer
      .getVariantTracks?.() ||
    [];

  if (!tracks.length) {
    qualityMenu.innerHTML = `
      <button
        class="gmax-quality-item active"
        type="button"
      >
        Auto
      </button>
    `;

    return;
  }

  const qualities =
    new Map();

  for (
    const track of tracks
  ) {
    const height =
      track.height ||
      0;

    if (
      !qualities.has(height)
    ) {
      qualities.set(
        height,
        track
      );
    }
  }

  const auto =
    document.createElement(
      "button"
    );

  auto.type =
    "button";

  auto.className =
    "gmax-quality-item active";

  auto.textContent =
    "Auto";

  auto.addEventListener(
    "click",
    () => {
      shakaPlayer.setConfig({
        abr: {
          enabled: true
        }
      });

      qualityMenu.classList.remove(
        "open"
      );
    }
  );

  qualityMenu.appendChild(
    auto
  );

  [
    ...qualities.entries()
  ]
    .sort(
      (a, b) =>
        a[0] - b[0]
    )
    .forEach(
      ([height, track]) => {
        const button =
          document.createElement(
            "button"
          );

        button.type =
          "button";

        button.className =
          "gmax-quality-item";

        button.textContent =
          height
            ? `${height}p`
            : "Unknown";

        button.addEventListener(
          "click",
          () => {
            shakaPlayer.setConfig({
              abr: {
                enabled: false
              }
            });

            shakaPlayer.selectVariantTrack(
              track,
              true
            );

            qualityMenu.classList.remove(
              "open"
            );
          }
        );

        qualityMenu.appendChild(
          button
        );
      }
    );
}

/* =========================================================
   PLAYER SPINNER
   ========================================================= */

function showSpinner() {
  const spinner =
    playerShell?.querySelector(
      '[data-role="spinner"]'
    );

  if (spinner) {
    spinner.style.display =
      "block";
  }
}

function hideSpinner() {
  const spinner =
    playerShell?.querySelector(
      '[data-role="spinner"]'
    );

  if (spinner) {
    spinner.style.display =
      "none";
  }
}

/* =========================================================
   REQUEST FILTER
   ========================================================= */

function installRequestFilter(
  player,
  source
) {
  if (
    !player ||
    !source
  ) {
    return;
  }

  const engine =
    player.getNetworkingEngine?.();

  if (!engine) {
    return;
  }

  engine.registerRequestFilter(
    (
      requestType,
      request
    ) => {
      const isManifest =
        requestType ===
        shaka.net.NetworkingEngine.RequestType.MANIFEST;

      const isSegment =
        requestType ===
        shaka.net.NetworkingEngine.RequestType.SEGMENT;

      if (
        !isManifest &&
        !isSegment
      ) {
        return;
      }

      const cookie =
        String(
          source.cookie || ""
        ).trim();

      const referrer =
        String(
          source.referrer ||
            ""
        ).trim();

      const userAgent =
        String(
          source.user_agent ||
            ""
        ).trim();

      request.uris =
        request.uris.map(
          uri => {
            if (
              cookie &&
              !uri.includes(
                "__hdnea__="
              )
            ) {
              return addCookieToUrl(
                uri,
                cookie
              );
            }

            return uri;
          }
        );

      /*
       * Only use custom headers
       * when supplied by your
       * source configuration.
       */
      if (
        referrer
      ) {
        request.headers =
          request.headers ||
          {};

        request.headers.Referer =
          referrer;
      }

      if (
        userAgent
      ) {
        request.headers =
          request.headers ||
          {};

        request.headers[
          "User-Agent"
        ] =
          userAgent;
      }
    }
  );
}

/* =========================================================
   CLEAR KEY
   ========================================================= */

function configureClearKey(
  player,
  source
) {
  const keyId =
    String(
      source?.key_id || ""
    ).trim();

  const key =
    String(
      source?.key || ""
    ).trim();

  if (
    !keyId ||
    !key
  ) {
    return;
  }

  /*
   * ClearKey expects hexadecimal
   * KID + KEY values.
   *
   * Do not blindly treat something
   * like "https://..." as a ClearKey.
   */
  const isHexKid =
    /^[0-9a-fA-F]{32}$/.test(
      keyId
    );

  const isHexKey =
    /^[0-9a-fA-F]{32}$/.test(
      key
    );

  if (
    !isHexKid ||
    !isHexKey
  ) {
    return;
  }

  const clearKeys = {};

  clearKeys[keyId] =
    key;

  player.configure({
    drm: {
      clearKeys
    }
  });
}

/* =========================================================
   DESTROY PLAYER
   ========================================================= */

async function destroyPlayer() {
  stopLiveStatusTimer();

  hideSpinner();

  if (
    shakaPlayer
  ) {
    try {
      await shakaPlayer.destroy();
    } catch {
      /* Ignore destroy errors */
    }

    shakaPlayer =
      null;
  }

  video.pause();

  video.removeAttribute(
    "src"
  );

  try {
    video.load();
  } catch {
    /* Ignore */
  }

  currentSource =
    null;
}

/* =========================================================
   DASH
   ========================================================= */

async function playDash(
  source
) {
  if (
    !window.shaka
  ) {
    throw new Error(
      "Shaka unavailable"
    );
  }

  if (
    !shaka.Player.isBrowserSupported()
  ) {
    throw new Error(
      "Browser unsupported"
    );
  }

  const rawUrl =
    getStreamUrl(
      source
    );

  const finalUrl =
    addCookieToUrl(
      rawUrl,
      source.cookie
    );

  shakaPlayer =
    new shaka.Player();

  shakaPlayer.configure({
    streaming: {
      bufferingGoal:
        BUFFERING_GOAL_SECONDS,

      rebufferingGoal:
        REBUFFERING_GOAL_SECONDS,

      bufferBehind:
        BUFFER_BEHIND_SECONDS,

      lowLatencyMode:
        false,

      retryParameters: {
        timeout:
          10000,

        maxAttempts:
          2,

        baseDelay:
          500,

        backoffFactor:
          1.4,

        fuzzFactor:
          0.2
      }
    }
  });

  await shakaPlayer.attach(
    video
  );

  shakaPlayer.addEventListener(
    "error",
    event => {
      console.warn(
        "Playback error:",
        event.detail?.code
      );
    }
  );

  installRequestFilter(
    shakaPlayer,
    source
  );

  configureClearKey(
    shakaPlayer,
    source
  );

  await shakaPlayer.load(
    finalUrl
  );

  setupPlayer();

  seekToConfiguredLivePosition();

  video.controls =
    false;

  startLiveStatusTimer();

  updateQualityOptions();

  updatePlayerUi();

  await video
    .play()
    .catch(() => {});
}

/* =========================================================
   HLS
   ========================================================= */

async function playHls(
  source
) {
  /*
   * Prefer Shaka first.
   *
   * This gives Android,
   * Windows and other MSE
   * browsers consistent handling.
   */
  if (
    window.shaka &&
    shaka.Player.isBrowserSupported()
  ) {
    shakaPlayer =
      new shaka.Player();

    shakaPlayer.configure({
      streaming: {
        bufferingGoal:
          BUFFERING_GOAL_SECONDS,

        rebufferingGoal:
          REBUFFERING_GOAL_SECONDS,

        bufferBehind:
          BUFFER_BEHIND_SECONDS,

        retryParameters: {
          timeout:
            10000,

          maxAttempts:
            2,

          baseDelay:
            500,

          backoffFactor:
            1.4,

          fuzzFactor:
            0.2
        }
      }
    });

    await shakaPlayer.attach(
      video
    );

    shakaPlayer.addEventListener(
      "error",
      event => {
        console.warn(
          "HLS error:",
          event.detail?.code
        );
      }
    );

    installRequestFilter(
      shakaPlayer,
      source
    );

    configureClearKey(
      shakaPlayer,
      source
    );

    const rawUrl =
      getStreamUrl(
        source
      );

    const finalUrl =
      addCookieToUrl(
        rawUrl,
        source.cookie
      );

    await shakaPlayer.load(
      finalUrl
    );

    setupPlayer();

    seekToConfiguredLivePosition();

    video.controls =
      false;

    startLiveStatusTimer();

    updateQualityOptions();

    updatePlayerUi();

    await video
      .play()
      .catch(() => {});

    return;
  }

  /*
   * Native HLS fallback,
   * especially useful for
   * Safari/iOS.
   */

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {
    const rawUrl =
      getStreamUrl(
        source
      );

    const finalUrl =
      addCookieToUrl(
        rawUrl,
        source.cookie
      );

    video.src =
      finalUrl;

    video.controls =
      false;

    setupPlayer();

    startLiveStatusTimer();

    await waitForVideoReady();

    seekNativeHls();

    updatePlayerUi();

    await video
      .play()
      .catch(() => {});

    return;
  }

  throw new Error(
    "HLS unsupported"
  );
}

function waitForVideoReady() {
  return new Promise(
    resolve => {
      if (
        video.readyState >=
        2
      ) {
        resolve();
        return;
      }

      let done = false;

      const finish =
        () => {
          if (done) {
            return;
          }

          done = true;

          video.removeEventListener(
            "loadedmetadata",
            finish
          );

          video.removeEventListener(
            "canplay",
            finish
          );

          resolve();
        };

      video.addEventListener(
        "loadedmetadata",
        finish,
        {
          once: true
        }
      );

      video.addEventListener(
        "canplay",
        finish,
        {
          once: true
        }
      );

      setTimeout(
        finish,
        7000
      );
    }
  );
}

function seekNativeHls() {
  try {
    const duration =
      video.duration;

    if (
      !Number.isFinite(
        duration
      ) ||
      duration <= 0
    ) {
      return;
    }

    video.currentTime =
      Math.max(
        0,
        duration -
          LIVE_DELAY_SECONDS
      );
  } catch {
    /* Ignore */
  }
}

/* =========================================================
   PLAY ONE SOURCE
   ========================================================= */

async function playSource(
  source
) {
  currentSource =
    source;

  updatePlayerIdentity();

  showLoading(
    true,
    `Connecting • ${
      source.server || "stream"
    }`
  );

  showSpinner();

  const type =
    getStreamType(
      source
    );

  if (
    type === "dash"
  ) {
    await playDash(
      source
    );
    return;
  }

  if (
    type === "hls"
  ) {
    await playHls(
      source
    );
    return;
  }

  throw new Error(
    "Unknown stream type"
  );
}

/* =========================================================
   MAIN FALLBACK ENGINE
   ========================================================= */

async function playChannelCandidates(
  channel,
  options = {}
) {
  if (isOpeningChannel) {
    return;
  }

  isOpeningChannel =
    true;

  clearPlayerError();

  playbackCandidates =
    buildPlaybackCandidates(
      channel
    );

  playbackIndex = 0;

  retryCycle = 0;

  if (
    !playbackCandidates.length
  ) {
    isOpeningChannel =
      false;

    showLoading(
      false
    );

    showPlayerError(
      "No playable source available"
    );

    return;
  }

  /*
   * Try:
   *
   * 6
   * 7
   * 8
   * Star
   * Sony
   * Voot
   * etc.
   */
  while (
    retryCycle <=
      MAX_FULL_RETRY_CYCLES
  ) {
    for (
      let i = 0;
      i <
      playbackCandidates.length;
      i++
    ) {
      playbackIndex =
        i;

      const source =
        playbackCandidates[i];

      try {
        await destroyPlayer();

        clearPlayerError();

        updateLoadingStatus(
          source,
          i,
          playbackCandidates.length
        );

        await playSource(
          source
        );

        /*
         * Playback successfully loaded.
         */
        isOpeningChannel =
          false;

        hideSpinner();

        showLoading(
          false
        );

        clearPlayerError();

        return;
      } catch (error) {
        console.warn(
          "Source failed:",
          source.server,
          error
        );

        await destroyPlayer();

        /*
         * Continue to next M3U.
         */
        if (
          i <
          playbackCandidates.length -
            1
        ) {
          setLoadingText(
            `Reconnecting • trying ${
              playbackCandidates[
                i + 1
              ]?.server ||
              "next source"
            }`
          );

          await sleep(
            RETRY_DELAY_MS
          );
        }
      }
    }

    retryCycle++;

    if (
      retryCycle <=
      MAX_FULL_RETRY_CYCLES
    ) {
      setLoadingText(
        `Reconnecting • retry ${retryCycle}`
      );

      await sleep(
        RETRY_DELAY_MS
      );
    }
  }

  isOpeningChannel =
    false;

  hideSpinner();

  showLoading(
    false
  );

  showPlayerError(
    "Unable to connect to this channel"
  );
}

/* =========================================================
   LOADING STATUS
   ========================================================= */

function updateLoadingStatus(
  source,
  index,
  total
) {
  const name =
    source?.server ||
    "stream";

  setLoadingText(
    `Connecting • ${name} • ${index + 1}/${total}`
  );
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

/* =========================================================
   OPEN CHANNEL
   ========================================================= */

async function openChannel(
  channel
) {
  currentChannel =
    channel;

  const id =
    getChannelId(
      channel
    );

  playerSection.classList.remove(
    "hidden"
  );

  playerEmpty.classList.add(
    "hidden"
  );

  playingTitle.textContent =
    getChannelName(
      channel
    );

  playingMeta.textContent =
    [
      "LIVE",
      "JIO TV",
      getCategory(
        channel
      )
    ]
      .filter(Boolean)
      .join(" • ");

  history.replaceState(
    null,
    "",
    `?id=${encodeURIComponent(
      id
    )}`
  );

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });

  setupPlayer();

  showLoading(
    true,
    "Connecting…"
  );

  await playChannelCandidates(
    channel
  );
}

/* =========================================================
   MANUAL RECONNECT
   ========================================================= */

async function reconnectCurrentChannel() {
  if (
    !currentChannel ||
    isRetrying
  ) {
    return;
  }

  isRetrying =
    true;

  clearPlayerError();

  showLoading(
    true,
    "Reconnecting…"
  );

  try {
    await destroyPlayer();

    /*
     * Start from the next source
     * rather than constantly
     * hammering the same one.
     */
    const candidates =
      buildPlaybackCandidates(
        currentChannel
      );

    if (
      candidates.length
    ) {
      const currentServer =
        currentSource?.server;

      const currentIndex =
        candidates.findIndex(
          source =>
            normalize(
              source.server
            ) ===
            normalize(
              currentServer
            )
        );

      if (
        currentIndex >=
        0 &&
        currentIndex <
          candidates.length -
            1
      ) {
        candidates.push(
          ...candidates.splice(
            0,
            currentIndex + 1
          )
        );
      }

      playbackCandidates =
        candidates;
    }

    await playChannelCandidates(
      currentChannel,
      {
        manualRetry: true
      }
    );
  } finally {
    isRetrying =
      false;
  }
}

/* =========================================================
   LIVE STATUS
   ========================================================= */

function startLiveStatusTimer() {
  stopLiveStatusTimer();

  liveStatusTimer =
    setInterval(
      updatePlayerUi,
      1000
    );

  updatePlayerUi();
}

function stopLiveStatusTimer() {
  if (
    liveStatusTimer
  ) {
    clearInterval(
      liveStatusTimer
    );

    liveStatusTimer =
      null;
  }
}

/* =========================================================
   CHANNEL JSON
   ========================================================= */

async function loadChannels(
  silent = false
) {
  try {
    const response =
      await fetch(
        `${CHANNELS_URL}?t=${Date.now()}`,
        {
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !Array.isArray(data)
    ) {
      throw new Error(
        "channels.json is not an array"
      );
    }

    allChannels =
      data.filter(
        channel =>
          channel &&
          (
            channel.name ||
            channel.stream_url ||
            channel.url ||
            Array.isArray(
              channel.sources
            )
          )
      );

    filteredChannels =
      [...allChannels];

    channelCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;

    resultsCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;

    buildCategories();
    applyFilters();

    /*
     * Preserve currently playing
     * channel after JSON refresh.
     */
    if (
      currentChannel
    ) {
      const same =
        allChannels.find(
          channel =>
            getChannelId(
              channel
            ) ===
            getChannelId(
              currentChannel
            )
        );

      if (same) {
        currentChannel =
          same;

        updatePlayerIdentity();
      }
    }

    if (!silent) {
      console.log(
        `Loaded ${allChannels.length} channels`
      );
    }
  } catch (error) {
    console.error(
      "Channel loading failed:",
      error
    );

    if (!silent) {
      channelCount.textContent =
        "Unable to load";

      resultsCount.textContent =
        "0 channels";

      channelsGrid.innerHTML = `
        <div class="empty-grid">
          Unable to load channels right now.
        </div>
      `;
    }
  }
}

/* =========================================================
   AUTO REFRESH CHANNELS
   ========================================================= */

function startChannelRefresh() {
  if (
    refreshTimer
  ) {
    clearInterval(
      refreshTimer
    );
  }

  refreshTimer =
    setInterval(
      async () => {
        console.log(
          "Refreshing channels.json..."
        );

        await loadChannels(
          true
        );

        /*
         * Reconnect only if the
         * current source has changed
         * or token data changed.
         *
         * This avoids unnecessarily
         * restarting playback every
         * 10 minutes.
         */
        if (
          currentChannel &&
          !isOpeningChannel
        ) {
          const refreshed =
            allChannels.find(
              channel =>
                getChannelId(
                  channel
                ) ===
                getChannelId(
                  currentChannel
                )
            );

          if (
            refreshed &&
            JSON.stringify(
              refreshed.sources ||
                []
            ) !==
              JSON.stringify(
                currentChannel.sources ||
                  []
              )
          ) {
            console.log(
              "Current channel source data changed"
            );

            currentChannel =
              refreshed;
          }
        }
      },
      CHANNEL_REFRESH_MS
    );
}

/* =========================================================
   QUERY STRING
   ========================================================= */

function openRequestedChannel() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const id =
    params.get("id");

  if (!id) {
    return;
  }

  const channel =
    allChannels.find(
      item =>
        getChannelId(item) ===
        String(id)
    );

  if (!channel) {
    return;
  }

  setTimeout(
    () => {
      openChannel(
        channel
      );
    },
    250
  );
}

/* =========================================================
   SEARCH
   ========================================================= */

searchInput.addEventListener(
  "input",
  () => {
    visibleCount =
      CHANNELS_PER_PAGE;

    applyFilters();
  }
);

/* =========================================================
   CLOSE PLAYER
   ========================================================= */

closePlayerButton.addEventListener(
  "click",
  async () => {
    await destroyPlayer();

    currentChannel =
      null;

    playbackCandidates =
      [];

    playbackIndex =
      0;

    playerSection.classList.add(
      "hidden"
    );

    playerEmpty.classList.remove(
      "hidden"
    );

    clearPlayerError();

    showLoading(
      false
    );

    history.replaceState(
      null,
      "",
      window.location.pathname
    );
  }
);

/* =========================================================
   VIDEO ERROR HANDLING
   ========================================================= */

video.addEventListener(
  "error",
  () => {
    if (
      !currentChannel ||
      isRetrying
    ) {
      return;
    }

    /*
     * Automatically move to
     * the next available source.
     */
    if (
      !isOpeningChannel
    ) {
      reconnectCurrentChannel();
    }
  }
);

video.addEventListener(
  "waiting",
  () => {
    if (
      currentChannel &&
      !video.paused
    ) {
      showLoading(
        true,
        "Reconnecting…"
      );
    }
  }
);

video.addEventListener(
  "playing",
  () => {
    showLoading(
      false
    );

    hideSpinner();

    clearPlayerError();

    showControlsTemporarily();
  }
);

/* =========================================================
   VISIBILITY / MOBILE RESUME
   ========================================================= */

document.addEventListener(
  "visibilitychange",
  () => {
    if (
      document.visibilityState ===
        "visible" &&
      currentChannel &&
      video.paused
    ) {
      /*
       * Android browsers may pause
       * media when the page loses
       * visibility.
       *
       * Don't restart automatically
       * while the user intentionally
       * paused the stream.
       */
      return;
    }
  }
);

/* =========================================================
   INITIALIZATION
   ========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  async () => {
    hideLoadMore();

    setupPlayer();

    await loadChannels();

    startChannelRefresh();

    openRequestedChannel();

    /*
     * Periodically update the
     * player UI.
     */
    setInterval(
      updatePlayerUi,
      1000
    );
  }
);
