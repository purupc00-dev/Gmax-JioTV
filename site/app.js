"use strict";

/* =========================================================
   CONFIG
========================================================= */

const CHANNELS_URL = "./channels.json";

const CHANNELS_PER_PAGE = 60;

/*
 * Keep playback approximately this far behind
 * the current live edge.
 */
/*
 * Live edge safety offset (seconds behind real-time).
 * Slightly higher = fewer freezes on unstable networks.
 */
const LIVE_DELAY_SECONDS = 12;

/*
 * If actual playback falls this many seconds further behind
 * LIVE_DELAY_SECONDS than intended, nudge playbackRate up to
 * catch back up instead of permanently trailing the live edge.
 * (Fixes: "loaded/buffered part is far ahead of the playing part".)
 */
const LIVE_CATCHUP_TRIGGER_SECONDS = 3;
const LIVE_CATCHUP_HARD_RESYNC_SECONDS = 15;
const LIVE_CATCHUP_PLAYBACK_RATE = 1.12;

/*
 * Buffer targets (seconds of media held in memory).
 * Higher bufferingGoal = less rebuffering, more startup delay.
 * Tuned for Jio live DASH (short segments, token CDNs).
 */
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

// Tracks current fallback stream index (0 = primary)
let currentFallbackIndex = 0;

// Prevent concurrent reconnect storms
let reconnectInFlight = false;

// Recently watched (compact slider, max 12)
const RECENT_KEY = "gmax-jiotv-recent";
const RECENT_MAX = 12;
let recentIds = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");


/* =========================================================
   FAVORITES
========================================================= */

const favorites =
  new Set(
    JSON.parse(
      localStorage.getItem(
        "gmax-jiotv-favorites"
      ) || "[]"
    )
  );


/* =========================================================
   DOM
========================================================= */

const channelsGrid =
  document.getElementById(
    "channels-grid"
  );

const categoryList =
  document.getElementById(
    "category-list"
  );

const searchInput =
  document.getElementById(
    "search-input"
  );

const channelCount =
  document.getElementById(
    "channel-count"
  );

const resultsCount =
  document.getElementById(
    "results-count"
  );

const loadMore =
  document.getElementById(
    "load-more"
  );

const loadMoreButton =
  document.getElementById(
    "load-more-button"
  );

const playerSection =
  document.getElementById(
    "player-section"
  );

const video =
  document.getElementById(
    "video"
  );

const playingTitle =
  document.getElementById(
    "playing-title"
  );

const playingMeta =
  document.getElementById(
    "playing-meta"
  );

const playerLoading =
  document.getElementById(
    "player-loading"
  );

const playerEmpty =
  document.getElementById(
    "player-empty"
  );

const playerError =
  document.getElementById(
    "player-error"
  );

const closePlayerButton =
  document.getElementById(
    "close-player"
  );


/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(value) {

  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );

}


function normalize(value) {

  return String(
    value ?? ""
  )
    .trim()
    .toLowerCase();

}


function streamType(channel) {

  const url =
    String(
      channel?.stream_url ||
      channel?.url ||
      ""
    ).toLowerCase();


  if (
    url.includes(
      ".mpd"
    )
  ) {

    return "dash";

  }


  if (
    url.includes(
      ".m3u8"
    )
  ) {

    return "hls";

  }


  return "unknown";

}


function getStreamUrl(channel) {

  return (
    channel?.stream_url ||
    channel?.url ||
    ""
  );

}


/* Main categories only (~10) — matches GMAXHUB-style filters */
const MAIN_CATEGORIES = [
  "Entertainment",
  "Movies",
  "Sports",
  "News",
  "Kids",
  "Music",
  "Information",
  "Religious",
];

function normalizeCategory(group, name) {
  const text = `${group || ""} ${name || ""}`.toLowerCase();

  if (/sport|cricket|football|fifa|tennis|kabaddi|nba|nfl|racing|formula/.test(text))
    return "Sports";
  if (/news|headline|breaking|current affairs/.test(text))
    return "News";
  if (/movie|cinema|film|bollywood|hollywood|picture/.test(text))
    return "Movies";
  if (/kid|cartoon|animation|junior|children|nick|hungama/.test(text))
    return "Kids";
  if (/music|mtv|radio|songs|fm /.test(text))
    return "Music";
  if (/relig|devotional|spiritual|bhakti|temple|islam|quran|church|gospel|hindu|sikh/.test(text))
    return "Religious";
  if (/info|document|education|knowledge|science|tech|history|nature|travel|lifestyle|business|weather|health|food/.test(text))
    return "Information";
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

function isPrimaryJioSource(channel) {
  const m3u = String(channel?.source_m3u || "").toLowerCase();
  const server = String(
    (channel?.sources && channel.sources[0] && channel.sources[0].m3u) || ""
  ).toLowerCase();
  return m3u.includes("jtvplus6") || server.includes("jtvplus6");
}


function saveFavorites() {

  localStorage.setItem(
    "gmax-jiotv-favorites",
    JSON.stringify(
      [
        ...favorites
      ]
    )
  );

}


function getChannelLogo(channel) {

  return (
    channel?.logo ||
    channel?.tvg_logo ||
    ""
  );

}


function getChannelId(channel) {

  return String(
    channel?.id ||
    channel?.tvgId ||
    ""
  );

}



function extractHdneaToken(value) {
  if (!value) return "";
  const s = String(value);
  // Prefer full __hdnea__=... token
  const m = s.match(/__hdnea__=[^&\s"']+/i);
  if (m) return m[0];
  // Bare token without prefix
  if (/^st=\d+~exp=\d+~/.test(s.trim())) {
    return "__hdnea__=" + s.trim();
  }
  return "";
}

/** Remove every __hdnea__ query param so we never stack two channel tokens. */
function stripHdneaFromUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url, "https://dummy.local");
    const keys = [];
    u.searchParams.forEach((_, k) => {
      if (k.toLowerCase() === "__hdnea__") keys.push(k);
    });
    keys.forEach((k) => u.searchParams.delete(k));
    // Also strip raw duplicates that URLSearchParams might miss
    let out = u.origin === "https://dummy.local"
      ? u.pathname + u.search + u.hash
      : u.toString();
    out = out.replace(/([?&])__hdnea__=[^&]*/gi, (match, sep) => (sep === "?" ? "?" : ""));
    out = out.replace(/\?&/, "?").replace(/\?$/, "").replace(/&&+/g, "&");
    return out;
  } catch (_) {
    return String(url)
      .replace(/([?&])__hdnea__=[^&]*/gi, "$1")
      .replace(/\?&/, "?")
      .replace(/[?&]$/, "")
      .replace(/&&+/g, "&");
  }
}

/** Apply exactly one __hdnea__ token for this channel. */
function applyHdneaToUrl(url, cookieOrToken) {
  const clean = stripHdneaFromUrl(url);
  const token = extractHdneaToken(cookieOrToken);
  if (!token || !clean) return clean || url;
  const sep = clean.includes("?") ? "&" : "?";
  return clean + sep + token;
}


// Active stream from primary (index 0) or fallbacks / sources array
function getActiveStreamConfig() {
  const ch = currentChannel;
  if (!ch) return { url: "", cookie: "", kid: "", key: "" };

  // Prefer ordered `sources` (jtvplus6→7→8→star→sony→…) when present
  const sources = Array.isArray(ch.sources) && ch.sources.length
    ? ch.sources
    : null;

  if (sources) {
    const idx = Math.min(Math.max(currentFallbackIndex, 0), sources.length - 1);
    const s = sources[idx] || sources[0];
    return {
      url: s.stream_url || getStreamUrl(ch),
      cookie: s.cookie || ch.cookie || "",
      kid: s.key_id || ch.key_id || "",
      key: s.key || ch.key || "",
    };
  }

  let url = getStreamUrl(ch);
  let cookie = ch.cookie || "";
  let kid = ch.key_id || "";
  let key = ch.key || "";

  if (
    currentFallbackIndex > 0 &&
    ch.fallbacks &&
    ch.fallbacks[currentFallbackIndex - 1]
  ) {
    const fb = ch.fallbacks[currentFallbackIndex - 1];
    url = fb.stream_url || url;
    cookie = fb.cookie || cookie;
    kid = fb.key_id || kid;
    key = fb.key || key;
  }
  return { url, cookie, kid, key };
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

  } catch (
    error
  ) {

    return null;

  }

}


function getCurrentLiveLag() {

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


  if (
    !range
  ) {

    return null;

  }


  return Math.max(
    range.start,
    range.end -
      LIVE_DELAY_SECONDS
  );

}


/*
 * Recover from drift instead of trailing the live edge forever.
 * Any stall/pause used to permanently increase the gap between the
 * loaded buffer and the actual playhead, because nothing ever sped
 * playback back up. This runs once a second from updateLiveStatus().
 */
function applyLiveCatchup(lag) {

  if (!video || video.paused || video.seeking) {
    return;
  }

  // Way too far behind (segments may be close to expiring from the
  // DVR window) — hard resync instead of a slow catch-up.
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

  // Back within the target window — return to normal speed.
  if (video.playbackRate !== 1) {
    video.playbackRate = 1;
  }

}


function seekToConfiguredLivePosition() {

  const target =
    getTargetLiveTime();


  if (
    target ===
    null
  ) {

    return false;

  }


  try {

    shakaPlayer.seek(
      target
    );

    return true;

  } catch (
    error
  ) {

    try {

      video.currentTime =
        target;

      return true;

    } catch (
      fallbackError
    ) {

      return false;

    }

  }

}


/* =========================================================
   FAVORITES
========================================================= */

function toggleFavorite(
  channelId
) {

  const key =
    String(
      channelId
    );


  if (
    favorites.has(
      key
    )
  ) {

    favorites.delete(
      key
    );

  } else {

    favorites.add(
      key
    );

  }


  saveFavorites();

  renderChannels();

}


/* =========================================================
   CATEGORIES — fixed main list only (no 80+ group titles)
========================================================= */

function buildCategories() {
  categoryList.innerHTML = "";
  categoryList.appendChild(createCategoryButton("ALL", true));
  for (const category of MAIN_CATEGORIES) {
    categoryList.appendChild(createCategoryButton(category, false));
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


  button.type =
    "button";


  button.className =
    "category-button" +
    (
      active
        ? " active"
        : ""
    );


  button.textContent =
    String(
      category
    );


  button.addEventListener(
    "click",
    () => {

      activeCategory =
        category;


      visibleCount =
        CHANNELS_PER_PAGE;


      if (
        infiniteScrollObserver
      ) {

        infiniteScrollObserver.disconnect();

        infiniteScrollObserver =
          null;

      }


      const oldSentinel =
        document.getElementById(
          "gmax-infinite-scroll-sentinel"
        );


      if (
        oldSentinel
      ) {

        oldSentinel.remove();

      }


      document
        .querySelectorAll(
          ".category-button"
        )
        .forEach(
          item => {

            item.classList.toggle(
              "active",
              item.textContent ===
                String(
                  category
                )
            );

          }
        );


      applyFilters();

    }
  );


  return button;

}


/* =========================================================
   FILTERING
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
          getCategory(
            channel
          );


        const matchesCategory =
          activeCategory ===
            "ALL" ||
          normalize(
            category
          ) ===
            normalize(
              activeCategory
            );


        if (
          !matchesCategory
        ) {

          return false;

        }


        if (
          !query
        ) {

          return true;

        }


        const searchable =
          [
            channel.name,
            channel.id,
            channel.group,
            channel.category,
            channel.language,
            channel.country
          ]
            .map(
              normalize
            )
            .join(
              " "
            );


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
   CHANNEL RENDERING
========================================================= */

function renderChannels() {

  const visible =
    filteredChannels.slice(
      0,
      visibleCount
    );


  channelsGrid.innerHTML =
    "";


  if (
    visible.length ===
    0
  ) {

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

    const card =
      createChannelCard(
        channel
      );


    fragment.appendChild(
      card
    );

  }


  channelsGrid.appendChild(
    fragment
  );


  hideLoadMore();

  ensureInfiniteScrollObserver();

}


/* =========================================================
   CHANNEL CARD
========================================================= */

function createChannelCard(
  channel
) {

  const card =
    document.createElement(
      "article"
    );


  card.className =
    "channel-card";


  const id =
    getChannelId(
      channel
    ) ||
    String(
      Math.random()
    );


  const favorite =
    favorites.has(
      id
    );


  const logo =
    getChannelLogo(
      channel
    );


  const group =
    channel.group ||
    channel.groupTitle ||
    getCategory(
      channel
    );


  card.innerHTML = `

    <button
      class="favorite-button ${
        favorite
          ? "active"
          : ""
      }"
      type="button"
      aria-label="Favorite"
    >
      ${
        favorite
          ? "♥"
          : "♡"
      }
    </button>


    <div class="channel-logo-wrap">

      ${
        logo
          ? `
            <img
              class="channel-logo"
              src="${escapeHtml(
                logo
              )}"
              alt="${escapeHtml(
                channel.name
              )}"
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
          channel.name ||
          "Unknown Channel"
        )}
      </div>


      <div class="channel-meta">
        JIO TV
        •
        ${escapeHtml(
          channel.country ||
          "INDIA"
        )}
        •
        ${escapeHtml(
          group
        )}
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


      toggleFavorite(
        id
      );

    }
  );


  card.addEventListener(
    "click",
    () => {

      openChannel(
        channel, 0
      );

    }
  );


  return card;

}


/* =========================================================
   PLAYER DESTROY
========================================================= */

async function destroyPlayer() {

  stopLiveStatusTimer();

  hidePlayerErrorOverlay();

  if (
    shakaPlayer
  ) {

    try {

      await shakaPlayer.destroy();

    } catch (
      error
    ) {

      console.warn(
        "Shaka destroy failed:",
        error
      );

    }


    shakaPlayer =
      null;

  }


  if (
    playerUiShell
  ) {

    playerUiShell.classList.remove(
      "gmax-controls-hidden"
    );

  }

}


/* =========================================================
   ORIGINAL PLAYER MESSAGE FUNCTIONS
========================================================= */

function showPlayerLoading(state) {
  // Keep external loading UI
  if (playerLoading) {
    playerLoading.classList.toggle("hidden", !state);
  }
  
  // Show dedicated Reconnecting orange overlay when falling back
  if (playerUiShell) {
    const reconnectOverlay = playerUiShell.querySelector('[data-role="reconnect-overlay"]');
    if (reconnectOverlay) {
      if (state && reconnectInFlight) {
        reconnectOverlay.style.display = "flex";
      } else {
        reconnectOverlay.style.display = "none";
      }
    }
  }

  hidePlayerSpinner();
  if (playerError) {
    playerError.classList.add("hidden");
    playerError.textContent = "";
  }
}

function totalSourceCount(channel) {
  if (!channel) return 1;
  if (Array.isArray(channel.sources) && channel.sources.length) {
    return channel.sources.length;
  }
  const fb = channel.fallbacks || [];
  return 1 + fb.length;
}

function setLoadingSourceMessage(index, total) {
  const n = index + 1;
  const t = Math.max(total, n);
  const msg = `Reconnecting... (${n}/${t})`;

  // Update new internal reconnect badge
  if (playerUiShell) {
    const reconnectText = playerUiShell.querySelector('[data-role="reconnect-text"]');
    if (reconnectText) {
      reconnectText.textContent = msg;
    }
  }

  // Update existing span as fallback
  const loadingSpan =
    document.querySelector("#player-loading-text") ||
    document.querySelector("#player-loading span");
  if (loadingSpan) {
    loadingSpan.textContent = msg;
  }
}

// SILENT RECONNECT — never show raw error text to the user
async function handleStreamError(err) {
  console.warn("Silent reconnect:", err);
  if (reconnectInFlight || !currentChannel) return;
  reconnectInFlight = true;

  try {
    const total = totalSourceCount(currentChannel);
    const maxIdx = total - 1;

    if (currentFallbackIndex < maxIdx) {
      const nextIdx = currentFallbackIndex + 1;
      setLoadingSourceMessage(nextIdx, total);
      showPlayerLoading(true);
      hidePlayerErrorOverlay();
      await openChannel(currentChannel, nextIdx);
    } else {
      setLoadingSourceMessage(0, total);
      showPlayerLoading(true);
      hidePlayerErrorOverlay();
      await new Promise((r) => setTimeout(r, 2500));
      await openChannel(currentChannel, 0);
    }
  } finally {
    reconnectInFlight = false;
  }
}

function showPlayerError(message) {
  // Never expose raw bug text — always silent reconnect UI
  handleStreamError(message);
}


function clearPlayerError() {

  playerError.textContent =
    "";


  playerError.classList.add(
    "hidden"
  );


  hidePlayerErrorOverlay();

}


/* =========================================================
   OPEN CHANNEL
========================================================= */

async function openChannel(
  channel, fallbackIdx = 0
) {

  currentChannel =
    channel;

  currentFallbackIndex = fallbackIdx;

  const id =
    channel.id ||
    channel.tvgId;


  const config = getActiveStreamConfig();

  // Always strip old __hdnea__ then apply THIS channel's token only (fixes 403 double-token)
  let streamUrl = applyHdneaToUrl(config.url, config.cookie);


  if (
    !streamUrl
  ) {

    showPlayerError(
      "This channel does not contain a playable stream URL."
    );


    return;

  }


  lastStreamUrl =
    streamUrl;


  lastStreamType =
    streamType(
      { stream_url: streamUrl }
    );


  playerSection.classList.remove(
    "hidden"
  );


  playerEmpty.classList.add(
    "hidden"
  );


  playingTitle.textContent =
    channel.name ||
    "Channel";


  playingMeta.textContent =
    [
      "JIO TV",
      channel.country ||
        "INDIA",
      getCategory(
        channel
      )
    ]
      .filter(
        Boolean
      )
      .join(
        " • "
      );


  clearPlayerError();
  hidePlayerErrorOverlay();

  setLoadingSourceMessage(fallbackIdx, totalSourceCount(channel));
  showPlayerLoading(true);

  // Track recently watched (compact slider)
  try {
    const cid = String(channel.id || channel.tvgId || "");
    if (cid) {
      recentIds = [cid, ...recentIds.filter((x) => x !== cid)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
      renderRecentSlider();
    }
  } catch (_) {}


  history.replaceState(
    null,
    "",
    `?id=${encodeURIComponent(
      id || ""
    )}`
  );


  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });


  await destroyPlayer();


  try {

    if (
      lastStreamType ===
      "dash"
    ) {

      await playDash(
        streamUrl, config.cookie, config.kid, config.key
      );

    } else if (
      lastStreamType ===
      "hls"
    ) {

      await playHls(
        streamUrl, config.cookie
      );

    } else {

      throw new Error(
        `Unsupported stream format:\n${streamUrl}`
      );

    }

  } catch (
    error
  ) {

    console.error(
      "Playback failed:",
      error
    );


    showPlayerError(
      error instanceof Error
        ? error.message
        : String(
            error
          )
    );

  } finally {

    showPlayerLoading(
      false
    );

  }

}



function getShakaStreamingConfig() {
  return {
    streaming: {
      bufferingGoal: BUFFERING_GOAL_SECONDS,
      rebufferingGoal: REBUFFERING_GOAL_SECONDS,
      bufferBehind: BUFFER_BEHIND_SECONDS,
      // Prefer stability over chasing live edge
      lowLatencyMode: false,
      inaccurateManifestTolerance: 2,
      segmentPrefetchLimit: 3,
      retryParameters: {
        maxAttempts: 5,
        baseDelay: 400,
        backoffFactor: 1.6,
        timeout: 20000,
      },
      stallEnabled: true,
      stallThreshold: 1.5,
      stallSkip: 0.1,
      jumpLargeGaps: true,
    },
    abr: {
      enabled: true,
      useNetworkInformation: true,
      // Re-evaluate less often so it doesn't flap between renditions.
      switchInterval: 8,
      // NOTE: downgradeTarget must be >= upgradeTarget, otherwise ABR
      // downgrades the instant a track uses >70% of estimated bandwidth
      // but only allows upgrading once there's >85% headroom — a gap
      // that causes constant down/up thrashing and keeps playback
      // stuck on a lower rendition even on a good connection. This was
      // inverted; restored to Shaka's sane defaults.
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
      restrictions: {
        minWidth: 0,
        minHeight: 0,
      },
    },
    manifest: {
      retryParameters: {
        maxAttempts: 4,
        baseDelay: 300,
        backoffFactor: 1.5,
        timeout: 15000,
      },
      dash: {
        ignoreMinBufferTime: true,
      },
    },
  };
}

/* =========================================================
   DASH
========================================================= */

async function playDash(
  streamUrl, hdneaCookie, keyId, keyVal
) {

  if (
    !window.shaka
  ) {

    throw new Error(
      "Shaka Player has not loaded yet."
    );

  }


  if (
    !shaka.Player.isBrowserSupported()
  ) {

    throw new Error(
      "This browser does not support Shaka Player."
    );

  }


  shakaPlayer =
    new shaka.Player();

  shakaPlayer.configure(getShakaStreamingConfig());


  await shakaPlayer.attach(
    video
  );


  shakaPlayer.addEventListener(
    "error",
    event => {

      console.error(
        "Shaka error:",
        event.detail
      );
      handleStreamError(event.detail);

    }
  );

  const hdneaToken = extractHdneaToken(hdneaCookie);
  if (hdneaToken) {
    const networkingEngine = shakaPlayer.getNetworkingEngine();
    if (networkingEngine) {
      networkingEngine.registerRequestFilter((requestType, request) => {
        const isManifest =
          requestType === shaka.net.NetworkingEngine.RequestType.MANIFEST;
        const isSegment =
          requestType === shaka.net.NetworkingEngine.RequestType.SEGMENT;
        if (!isManifest && !isSegment) return;
        request.uris = request.uris.map((uri) => {
          if (!uri) return uri;
          // Always replace with the current channel token — never stack
          return applyHdneaToUrl(uri, hdneaToken);
        });
      });
    }
  }

  if (
    keyId &&
    keyVal
  ) {

    const clearKeys =
      {};


    clearKeys[
      keyId
    ] =
      keyVal;


    shakaPlayer.configure({
      drm: {
        clearKeys
      }
    });

  }

  await shakaPlayer.load(
    streamUrl
  );

  seekToConfiguredLivePosition();


  video.controls =
    false;


  setupCinematicPlayer();

  updateQualityOptions();
  // Refresh quality list when variants become available
  try {
    shakaPlayer.addEventListener("trackschanged", () => updateQualityOptions());
    shakaPlayer.addEventListener("adaptation", () => updateQualityOptions());
  } catch (_) {}
  setTimeout(() => updateQualityOptions(), 800);
  setTimeout(() => updateQualityOptions(), 2500);

  startLiveStatusTimer();

  updatePlayerUi();


  await video.play().catch(
    () => {}
  );

}


/* =========================================================
   HLS
========================================================= */

async function playHls(
  streamUrl, hdneaCookie
) {

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      streamUrl;


    video.controls =
      false;


    setupCinematicPlayer();

    updateQualityOptions();

    startLiveStatusTimer();


    await waitForVideoReady();


    seekNativeHlsToDelayedLive();


    updatePlayerUi();

    video.addEventListener("error", () => handleStreamError(video.error));

    await video.play().catch(
      () => {}
    );


    return;

  }


  if (
    window.shaka &&
    shaka.Player.isBrowserSupported()
  ) {

    shakaPlayer =
      new shaka.Player();

    shakaPlayer.configure(getShakaStreamingConfig());


    await shakaPlayer.attach(
      video
    );


    shakaPlayer.addEventListener(
      "error",
      event => {

        console.error(
          "Shaka HLS error:",
          event.detail
        );
        handleStreamError(event.detail);

      }
    );

    const hdneaTokenHls = extractHdneaToken(hdneaCookie);
    if (hdneaTokenHls) {
      const networkingEngine = shakaPlayer.getNetworkingEngine();
      if (networkingEngine) {
        networkingEngine.registerRequestFilter((requestType, request) => {
          const isManifest =
            requestType === shaka.net.NetworkingEngine.RequestType.MANIFEST;
          const isSegment =
            requestType === shaka.net.NetworkingEngine.RequestType.SEGMENT;
          if (!isManifest && !isSegment) return;
          request.uris = request.uris.map((uri) => {
            if (!uri) return uri;
            return applyHdneaToUrl(uri, hdneaTokenHls);
          });
        });
      }
    }


    await shakaPlayer.load(
      streamUrl
    );


    seekToConfiguredLivePosition();


    video.controls =
      false;


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


    await video.play().catch(
      () => {}
    );


    return;

  }


  throw new Error(
    "This browser cannot play HLS."
  );

}


/* =========================================================
   NATIVE HLS SEEK
========================================================= */

function seekNativeHlsToDelayedLive() {

  try {

    const duration =
      video.duration;


    if (
      !Number.isFinite(
        duration
      ) ||
      duration <=
        0
    ) {

      return false;

    }

    const target =
      Math.max(
        0,
        duration -
          LIVE_DELAY_SECONDS
      );


    video.currentTime =
      target;


    return true;

  } catch (
    error
  ) {

    return false;

  }

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


      let settled =
        false;


      const finish =
        () => {

          if (
            settled
          ) {

            return;

          }


          settled =
            true;


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
          once:
            true
        }
      );


      video.addEventListener(
        "canplay",
        finish,
        {
          once:
            true
        }
      );


      setTimeout(
        finish,
        5000
      );

    }
  );

}


/* =========================================================
   PLAYER STYLE INJECTION
========================================================= */

function injectCinematicPlayerStyles() {

  if (
    document.getElementById(
      "gmax-cinematic-player-styles"
    )
  ) {

    return;

  }


  const style =
    document.createElement(
      "style"
    );


  style.id =
    "gmax-cinematic-player-styles";

  // NEW: Android layout fix implemented inside the media query
  style.textContent = `

    .gmax-player-shell {

      position:
        relative;

      width:
        100%;

      aspect-ratio:
        16 / 9;

      min-height:
        280px;

      background:
        #000;

      overflow:
        hidden;

      border-radius:
        18px;

      box-shadow:
        0
        30px
        90px
        rgba(
          0,
          0,
          0,
          .55
        );

      isolation:
        isolate;

      user-select:
        none;

    }


    .gmax-player-shell video {

      position:
        absolute;

      inset:
        0;

      width:
        100%;

      height:
        100%;
      
      max-width:
        100%;
      
      max-height:
        100%;

      object-fit:
        contain;

      background:
        #000;

    }


    .gmax-player-gradient {

      position:
        absolute;

      inset:
        auto
        0
        0;

      height:
        210px;

      pointer-events:
        none;

      background:
        linear-gradient(
          to bottom,
          transparent 0%,
          rgba(
            0,
            0,
            0,
            .08
          ) 20%,
          rgba(
            0,
            0,
            0,
            .82
          ) 100%
        );

      z-index:
        3;

    }


    .gmax-player-top {

      position:
        absolute;

      top:
        0;

      left:
        0;

      right:
        0;

      padding:
        20px;

      display:
        flex;

      align-items:
        flex-start;

      gap:
        12px;

      z-index:
        6;

      background:
        linear-gradient(
          to bottom,
          rgba(
            0,
            0,
            0,
            .7
          ),
          transparent
        );

      pointer-events:
        none;

    }


    .gmax-now-playing {

      display:
        flex;

      align-items:
        center;

      gap:
        12px;

      min-width:
        0;

    }


    .gmax-channel-art {

      width:
        54px;

      height:
        54px;

      border-radius:
        12px;

      object-fit:
        contain;

      background:
        rgba(
          255,
          255,
          255,
          .08
        );

      padding:
        5px;

      border:
        1px
        solid
        rgba(
          255,
          255,
          255,
          .1
        );

      flex:
        0
        0
        auto;

    }


    .gmax-now-copy {

      min-width:
        0;

    }


    .gmax-now-label {

      font:
        800
        10px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .12em;

      text-transform:
        uppercase;

      color:
        #ff2b83;

      margin-bottom:
        6px;

    }


    .gmax-now-title {

      color:
        #fff;

      font:
        800
        clamp(
          15px,
          2vw,
          22px
        )/1.2
        system-ui,
        sans-serif;

      white-space:
        nowrap;

      overflow:
        hidden;

      text-overflow:
        ellipsis;

      max-width:
        min(
          55vw,
          520px
        );

    }


    .gmax-now-meta {

      color:
        rgba(
          255,
          255,
          255,
          .65
        );

      font:
        500
        11px/1.3
        system-ui,
        sans-serif;

      margin-top:
        4px;

    }


    .gmax-live-badge {

      margin-left:
        auto;

      pointer-events:
        auto;

      display:
        inline-flex;

      align-items:
        center;

      gap:
        7px;

      padding:
        8px
        11px;

      border-radius:
        999px;

      color:
        #fff;

      background:
        rgba(
          229,
          9,
          20,
          .95
        );

      font:
        900
        10px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .08em;

      box-shadow:
        0
        8px
        28px
        rgba(
          229,
          9,
          20,
          .35
        );

    }


    .gmax-live-dot {

      width:
        7px;

      height:
        7px;

      border-radius:
        50%;

      background:
        #fff;

      box-shadow:
        0
        0
        0
        5px
        rgba(
          255,
          255,
          255,
          .08
        );

    }

    .gmax-reconnect-overlay {
      position: absolute;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      border: 1px solid rgba(255, 152, 0, 0.3);
      padding: 6px 14px;
      border-radius: 20px;
      color: #ff9800;
      font: 600 13px/1 system-ui, sans-serif;
      display: flex;
      align-items: center;
      gap: 8px;
      z-index: 50;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    
    .gmax-reconnect-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 152, 0, 0.3);
      border-top-color: #ff9800;
      border-radius: 50%;
      animation: gmaxSpin 0.8s linear infinite;
    }


    .gmax-player-controls {

      position:
        absolute;

      left:
        0;

      right:
        0;

      bottom:
        0;

      z-index:
        8;

      display:
        flex;

      align-items:
        center;

      gap:
        9px;

      padding:
        70px
        18px
        16px;

      color:
        #fff;

      background:
        linear-gradient(
          transparent,
          rgba(
            0,
            0,
            0,
            .92
          )
        );

      transition:
        opacity
        .2s ease,
        transform
        .2s ease;

    }


    .gmax-player-shell.gmax-controls-hidden
      .gmax-player-controls,
    .gmax-player-shell.gmax-controls-hidden
      .gmax-player-top,
    .gmax-player-shell.gmax-controls-hidden
      .gmax-player-gradient {

      opacity:
        0;

      pointer-events:
        none;

    }

    .gmax-player-gradient {
      transition: opacity .25s ease;
    }


    .gmax-player-button {

      min-width:
        38px;

      height:
        38px;

      padding:
        0 8px;

      border:
        0;

      border-radius:
        11px;

      display:
        grid;

      place-items:
        center;

      background:
        rgba(
          255,
          255,
          255,
          .1
        );

      color:
        #fff;

      cursor:
        pointer;

      font:
        700
        15px/1
        system-ui,
        sans-serif;

      transition:
        .15s
        ease;

      flex:
        0
        0
        auto;

    }
    
    #gmax-aspect-btn {
      width: auto;
      padding: 0 12px;
      font-size: 13px;
    }


    .gmax-player-button:hover {

      background:
        rgba(
          255,
          43,
          131,
          .28
        );

      transform:
        translateY(
          -1px
        );

    }


    .gmax-player-spacer {

      flex:
        1;

    }


    .gmax-live-lag {

      color:
        rgba(
          255,
          255,
          255,
          .88
        );

      font:
        700
        12px/1
        system-ui,
        sans-serif;

      white-space:
        nowrap;

    }


    .gmax-go-live {

      border:
        1px
        solid
        rgba(
          255,
          43,
          131,
          .5
        );

      background:
        rgba(
          255,
          43,
          131,
          .12
        );

      color:
        #fff;

      padding:
        9px
        12px;

      border-radius:
        10px;

      font:
        800
        10px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .06em;

      cursor:
        pointer;

    }


    .gmax-go-live:hover {

      background:
        rgba(
          255,
          43,
          131,
          .28
        );

    }


    .gmax-volume {

      width:
        86px;

      accent-color:
        #ff2b83;

      cursor:
        pointer;

    }


    .gmax-quality-wrap {

      position:
        relative;

    }


    .gmax-quality-menu {

      position:
        absolute;

      right:
        0;

      bottom:
        50px;

      width:
        180px;

      max-height:
        280px;

      overflow-y:
        auto;

      padding:
        7px;

      display:
        none;

      background:
        rgba(
          15,
          15,
          18,
          .97
        );

      border:
        1px
        solid
        rgba(
          255,
          255,
          255,
          .11
        );

      border-radius:
        14px;

      box-shadow:
        0
        20px
        60px
        rgba(
          0,
          0,
          0,
          .65
        );

      backdrop-filter:
        blur(
          18px
        );

      z-index:
        30;

    }


    .gmax-quality-menu.open {

      display:
        block;

    }


    .gmax-quality-item {

      display:
        block;

      width:
        100%;

      border:
        0;

      border-radius:
        9px;

      background:
        transparent;

      color:
        rgba(
          255,
          255,
          255,
          .76
        );

      text-align:
        left;

      padding:
        10px
        11px;

      cursor:
        pointer;

      font:
        700
        12px/1
        system-ui,
        sans-serif;

    }


    .gmax-quality-item:hover,
    .gmax-quality-item.active {

      color:
        #fff;

      background:
        rgba(
          255,
          43,
          131,
          .16
        );

    }


    .gmax-spinner {

      position:
        absolute;

      left:
        50%;

      top:
        50%;

      width:
        46px;

      height:
        46px;

      margin:
        -23px
        0
        0
        -23px;

      border:
        3px
        solid
        rgba(
          255,
          255,
          255,
          .18
        );

      border-top-color:
        #ff2b83;

      border-radius:
        50%;

      animation:
        gmaxSpin
        .8s
        linear
        infinite;

      z-index:
        10;

    }


    @keyframes gmaxSpin {

      to {

        transform:
          rotate(
            360deg
          );

      }

    }


    .gmax-player-error {

      position:
        absolute;

      inset:
        0;

      display:
        none;

      align-items:
        center;

      justify-content:
        center;

      flex-direction:
        column;

      gap:
        10px;

      text-align:
        center;

      padding:
        24px;

      background:
        radial-gradient(
          circle at center,
          rgba(
            60,
            10,
            35,
            .75
          ),
          rgba(
            0,
            0,
            0,
            .96
          )
        );

      color:
        #fff;

      z-index:
        20;

    }


    .gmax-player-error.open {

      display:
        none; /* Modified to stay hidden for silent fallback */

    }


    .gmax-error-title {

      font:
        800
        20px/1.2
        system-ui,
        sans-serif;

    }


    .gmax-error-message {

      max-width:
        520px;

      color:
        rgba(
          255,
          255,
          255,
          .6
        );

      font:
        500
        12px/1.5
        system-ui,
        sans-serif;

    }


    .gmax-retry-button {

      margin-top:
        7px;

      border:
        0;

      border-radius:
        10px;

      background:
        #ff2b83;

      color:
        #fff;

      padding:
        11px
        16px;

      cursor:
        pointer;

      font:
        800
        11px/1
        system-ui,
        sans-serif;

    }


    .gmax-player-info {

      margin-top:
        16px;

      display:
        grid;

      gap:
        16px;

    }


    .gmax-player-info-main {

      display:
        flex;

      align-items:
        center;

      gap:
        13px;

      }


    .gmax-info-logo {

      width:
        52px;

      height:
        52px;

      border-radius:
        12px;

      object-fit:
        contain;

      background:
        rgba(
          255,
          255,
          255,
          .05
        );

      padding:
        5px;

    }


    .gmax-info-label {

      color:
        #ff2b83;

      font:
        900
        10px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .1em;

      text-transform:
        uppercase;

      margin-bottom:
        5px;

    }


    .gmax-info-title {

      color:
        #fff;

      font:
        900
        20px/1.2
        system-ui,
        sans-serif;

    }


    .gmax-info-meta {

      margin-top:
        4px;

      color:
        rgba(
          255,
          255,
          255,
          .5
        );

      font:
        500
        12px/1.3
        system-ui,
        sans-serif;

    }


    .gmax-related-title {

      color:
        #fff;

      font:
        900
        17px/1.2
        system-ui,
        sans-serif;

      margin-bottom:
        9px;

    }


    .gmax-related-row {

      display:
        flex;

      gap:
        11px;

      overflow-x:
        auto;

      scrollbar-width:
        thin;

      padding-bottom:
        4px;

    }


    .gmax-related-card {

      flex:
        0
        0
        155px;

      min-height:
        92px;

      border:
        1px
        solid
        rgba(
          255,
          255,
          255,
          .07
        );

      background:
        linear-gradient(
          145deg,
          rgba(
            255,
            255,
            255,
            .06
          ),
          rgba(
            255,
            255,
            255,
            .025
          )
        );

      border-radius:
        12px;

      overflow:
        hidden;

      cursor:
        pointer;

      transition:
        .18s
        ease;

    }


    .gmax-related-card:hover {

      transform:
        translateY(
          -2px
        );

      border-color:
        rgba(
          255,
          43,
          131,
          .35
        );

    }


    .gmax-related-image {

      width:
        100%;

      height:
        55px;

      object-fit:
        contain;

      background:
        #0b0b0e;

      padding:
        8px;

    }


    .gmax-related-name {

      padding:
        7px
        9px;

      color:
        rgba(
          255,
          255,
          255,
          .9
        );

      font:
        800
        11px/1.2
        system-ui,
        sans-serif;

      white-space:
        nowrap;

      overflow:
        hidden;

      text-overflow:
        ellipsis;

    }


    @media (
      max-width:
        700px
    ) {

      .gmax-player-shell {
        border-radius: 10px;
        min-height: 0;
        aspect-ratio: 16 / 9;
        max-height: min(56vw, 70vh);
        position: relative;
        overflow: hidden;
      }

      .gmax-player-shell video {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .gmax-player-top {
        padding: 8px 10px;
        z-index: 10;
      }

      .gmax-channel-art {
        width: 36px;
        height: 36px;
        border-radius: 8px;
      }

      .gmax-now-title {
        max-width: 42vw;
        font-size: 14px !important;
      }

      .gmax-now-meta {
        display: none;
      }

      .gmax-live-badge {
        padding: 6px 8px;
        font-size: 9px !important;
      }

      /* Android / mobile: keep controls fully on-screen & tappable */
      .gmax-player-controls {
        gap: 4px;
        padding: 28px 6px calc(10px + env(safe-area-inset-bottom, 0px));
        flex-wrap: wrap;
        justify-content: center;
        align-items: center;
        z-index: 12;
        background: linear-gradient(to top, rgba(0,0,0,.85) 0%, transparent 100%);
        pointer-events: auto;
      }

      .gmax-volume {
        display: none;
      }

      .gmax-live-lag {
        display: none;
      }

      .gmax-player-button {
        width: 40px;
        min-width: 40px;
        height: 40px;
        font-size: 14px;
        touch-action: manipulation;
      }

      .gmax-go-live {
        padding: 8px 10px;
        font-size: 10px;
      }

      .gmax-related-card {
        flex-basis: 120px;
      }
    }

    /* Extra-small / Android TV lean-back */
    @media (max-width: 480px) {
      .gmax-player-shell {
        aspect-ratio: 16 / 9;
        max-height: 48vh;
        border-radius: 8px;
      }
      .gmax-player-controls {
        padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      }
    }

  `;


  document.head.appendChild(
    style
  );

}


/* =========================================================
   CINEMATIC PLAYER SETUP
========================================================= */

function setupCinematicPlayer() {

  injectCinematicPlayerStyles();


  let shell =
    video.closest(
      ".gmax-player-shell"
    );


  if (
    !shell
  ) {

    const parent =
      video.parentElement;


    if (
      !parent
    ) {

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


  playerUiShell =
    shell;


  /*
   * Make sure we only create the
   * controls once.
   */

  if (
    !playerControls
  ) {

    createPlayerControls(
      shell
    );

  }


  updatePlayerIdentity();

  buildRelatedChannels();

  hidePlayerErrorOverlay();

}


/* =========================================================
   CREATE CONTROLS
========================================================= */

function createPlayerControls(
  shell
) {

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

        <div
          class="gmax-now-label"
        >
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
          JIO TV
        </div>

      </div>

    </div>


    <div
      class="gmax-live-badge"
      title="Live"
    >
      <span
        class="gmax-live-dot"
      ></span>

      LIVE

    </div>

  `;


  shell.appendChild(
    top
  );

  // Dedicated Silent Reconnect Overlay
  const reconnectOverlay = document.createElement("div");
  reconnectOverlay.className = "gmax-reconnect-overlay";
  reconnectOverlay.dataset.role = "reconnect-overlay";
  reconnectOverlay.style.display = "none";
  reconnectOverlay.innerHTML = `
    <span class="gmax-reconnect-spinner"></span>
    <span data-role="reconnect-text">Reconnecting...</span>
  `;
  shell.appendChild(reconnectOverlay);

  // No second spinner here — #player-loading already has one.
  // A hidden marker keeps showPlayerSpinner/hidePlayerSpinner safe.
  const spinner =
    document.createElement(
      "div"
    );
  spinner.className =
    "gmax-spinner";
  spinner.dataset.role =
    "spinner";
  spinner.style.display =
    "none";
  shell.appendChild(
    spinner
  );


  const errorOverlay =
    document.createElement(
      "div"
    );


  errorOverlay.className =
    "gmax-player-error";


  errorOverlay.dataset.role =
    "error";


  errorOverlay.innerHTML = `

    <div
      class="gmax-error-title"
    >
      Playback problem
    </div>

    <div
      class="gmax-error-message"
      data-role="error-message"
    >
      The channel could not be played.
    </div>

    <button
      class="gmax-retry-button"
      data-action="retry"
      type="button"
    >
      RECONNECT
    </button>

  `;


  shell.appendChild(
    errorOverlay
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
      title="Play / Pause"
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
      LIVE • -15s
    </span>


    <button
      class="gmax-go-live"
      data-action="go-live"
      type="button"
      title="Return to the live safety position"
    >
      GO LIVE
    </button>


    <span
      class="gmax-player-spacer"
    ></span>


    <div
      class="gmax-quality-wrap"
    >

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
      data-action="aspect"
      type="button"
      title="Fit / Fill / Stretch"
      id="gmax-aspect-btn"
    >
      Fit ⛶
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


  const playButton =
    controls.querySelector(
      '[data-action="play"]'
    );


  const muteButton =
    controls.querySelector(
      '[data-action="mute"]'
    );


  const volumeInput =
    controls.querySelector(
      '[data-action="volume"]'
    );


  const qualityButton =
    controls.querySelector(
      '[data-action="quality"]'
    );


  const goLiveButton =
    controls.querySelector(
      '[data-action="go-live"]'
    );


  const fullscreenButton =
    controls.querySelector(
      '[data-action="fullscreen"]'
    );


  const retryButton =
    errorOverlay.querySelector(
      '[data-action="retry"]'
    );

  // Single aspect button: Normal → Zoom → Stretch → Normal…
  // (same idea as 16:9 / zoom controls on reference players)
  const aspectButton = controls.querySelector('[data-action="aspect"]');
  const aspectModes = [
    { fit: "contain", label: "Fit ⛶", title: "Normal / Fit" },
    { fit: "cover", label: "Zoom ⛶", title: "Fill / Zoom" },
    { fit: "fill", label: "Stretch ⛶", title: "Stretch" },
  ];
  let currentAspect = 0;
  video.style.objectFit = aspectModes[0].fit;
  if (aspectButton) {
    aspectButton.textContent = aspectModes[0].label;
    aspectButton.title = aspectModes[0].title;
  }

  aspectButton.addEventListener("click", (event) => {
    event.stopPropagation();
    currentAspect = (currentAspect + 1) % aspectModes.length;
    const mode = aspectModes[currentAspect];
    video.style.objectFit = mode.fit;
    aspectButton.textContent = mode.label;
    aspectButton.title = mode.title;
  });


  playButton.addEventListener(
    "click",
    async event => {

      event.stopPropagation();


      if (
        video.paused
      ) {

        await video
          .play()
          .catch(
            () => {}
          );

      } else {

        video.pause();

      }


      updatePlayerUi();

    }
  );


  muteButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      video.muted =
        !video.muted;


      updatePlayerUi();

    }
  );


  volumeInput.addEventListener(
    "input",
    event => {

      event.stopPropagation();


      video.volume =
        Number(
          volumeInput.value
        );


      video.muted =
        video.volume ===
        0;


      updatePlayerUi();

    }
  );


  goLiveButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      if (
        seekToConfiguredLivePosition()
      ) {

        video.playbackRate = 1;

        video.play().catch(
          () => {}
        );

      }


      updatePlayerUi();

    }
  );


  qualityButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      qualityMenu.classList.toggle(
        "open"
      );

    }
  );


  fullscreenButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      toggleFullscreen();

    }
  );


  retryButton.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      retryCurrentChannel();

    }
  );


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


  shell.addEventListener(
    "click",
    event => {

      if (
        event.target !==
        video
      ) {

        return;

      }


      if (
        video.paused
      ) {

        video
          .play()
          .catch(
            () => {}
          );

      } else {

        video.pause();

      }

    }
  );


  [
    "play",
    "pause",
    "timeupdate",
    "loadedmetadata",
    "volumechange",
    "durationchange",
    "progress",
    "canplay"
  ].forEach(
    eventName => {

      video.addEventListener(
        eventName,
        updatePlayerUi
      );

    }
  );


  shell.addEventListener(
    "mousemove",
    () => {

      showPlayerControlsTemporarily();

    }
  );


  shell.addEventListener(
    "touchstart",
    () => {

      showPlayerControlsTemporarily();

    },
    {
      passive:
        true
    }
  );


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


  window.addEventListener(
    "keydown",
    handlePlayerKeyboard
  );

}


/* =========================================================
   PLAYER IDENTITY
========================================================= */

function updatePlayerIdentity() {

  if (
    !playerUiShell ||
    !currentChannel
  ) {

    return;

  }


  const art =
    playerUiShell.querySelector(
      '[data-role="channel-art"]'
    );


  const title =
    playerUiShell.querySelector(
      '[data-role="channel-title"]'
    );


  const meta =
    playerUiShell.querySelector(
      '[data-role="channel-meta"]'
    );


  const logo =
    getChannelLogo(
      currentChannel
    );


  if (
    art
  ) {

    if (
      logo
    ) {

      art.src =
        logo;

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


  if (
    title
  ) {

    title.textContent =
      currentChannel.name ||
      "Live TV";

  }


  if (
    meta
  ) {

    meta.textContent =
      [
        "JIO TV",
        currentChannel.country ||
          "INDIA",
        getCategory(
          currentChannel
        )
      ]
        .filter(
          Boolean
        )
        .join(
          " • "
        );

  }

}


/* =========================================================
   RELATED CHANNELS
========================================================= */

function buildRelatedChannels() {

  if (
    !playerSection ||
    !currentChannel
  ) {

    return;

  }


  let info =
    playerSection.querySelector(
      ".gmax-player-info"
    );


  if (
    !info
  ) {

    info =
      document.createElement(
        "div"
      );


    info.className =
      "gmax-player-info";


    playerSection.appendChild(
      info
    );

  }


  const logo =
    getChannelLogo(
      currentChannel
    );


  const related =
    allChannels
      .filter(
        channel =>
          getChannelId(
            channel
          ) !==
          getChannelId(
            currentChannel
          )
      )
      .filter(
        channel =>
          normalize(
            getCategory(
              channel
            )
          ) ===
          normalize(
            getCategory(
              currentChannel
            )
          )
      )
      .slice(
        0,
        12
      );


  info.innerHTML = `

    <div
      class="gmax-player-info-main"
    >

      ${
        logo
          ? `
            <img
              class="gmax-info-logo"
              src="${escapeHtml(
                logo
              )}"
              alt=""
              referrerpolicy="no-referrer"
            >
          `
          : ""
      }


      <div>

        <div
          class="gmax-info-label"
        >
          NOW PLAYING
        </div>

        <div
          class="gmax-info-title"
        >
          ${escapeHtml(
            currentChannel.name ||
            "Live TV"
          )}
        </div>

        <div
          class="gmax-info-meta"
        >
          ${escapeHtml(
            [
              "JIO TV",
              currentChannel.country ||
                "INDIA",
              getCategory(
                currentChannel
              )
            ]
              .filter(
                Boolean
              )
              .join(
                " • "
              )
          )}
        </div>

      </div>

    </div>


    ${
      related.length
        ? `
          <div>

            <div
              class="gmax-related-title"
            >
              RELATED CHANNELS
            </div>

            <div
              class="gmax-related-row"
            >

              ${related
                .map(
                  channel => {

                    const channelLogo =
                      getChannelLogo(
                        channel
                      );


                    return `

                      <div
                        class="gmax-related-card"
                        data-related-channel="${escapeHtml(
                          getChannelId(
                            channel
                          )
                        )}"
                      >

                        ${
                          channelLogo
                            ? `
                              <img
                                class="gmax-related-image"
                                src="${escapeHtml(
                                  channelLogo
                                )}"
                                alt=""
                                loading="lazy"
                                referrerpolicy="no-referrer"
                              >
                            `
                            : `
                              <div
                                class="gmax-related-image"
                                style="
                                  display:grid;
                                  place-items:center;
                                  color:#777;
                                  font-weight:800;
                                "
                              >
                                TV
                              </div>
                            `
                        }


                        <div
                          class="gmax-related-name"
                        >
                          ${escapeHtml(
                            channel.name ||
                            "Channel"
                          )}
                        </div>

                      </div>

                    `;

                  }
                )
                .join(
                  ""
                )}

            </div>

          </div>
        `
        : ""
    }

  `;


  info
    .querySelectorAll(
      "[data-related-channel]"
    )
    .forEach(
      card => {

        card.addEventListener(
          "click",
          () => {

            const id =
              card.dataset.relatedChannel;


            const channel =
              allChannels.find(
                item =>
                  getChannelId(
                    item
                  ) ===
                  String(
                    id
                  )
              );


            if (
              channel
            ) {

              openChannel(
                channel, 0
              );

            }

          }
        );

      }
    );

}


/* =========================================================
   PLAYER CONTROLS
========================================================= */

function showPlayerControlsTemporarily() {

  if (
    !playerUiShell
  ) {

    return;

  }


  playerUiShell.classList.remove(
    "gmax-controls-hidden"
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

          playerUiShell.classList.add(
            "gmax-controls-hidden"
          );

        }

      },
      2800
    );

}


function toggleFullscreen() {

  if (
    !playerUiShell
  ) {

    return;

  }


  if (
    document.fullscreenElement
  ) {

    document
      .exitFullscreen()
      .catch(
        () => {}
      );

  } else {

    if (
      playerUiShell.requestFullscreen
    ) {

      playerUiShell
        .requestFullscreen()
        .catch(
          () => {}
        );

    }

  }

}


/* =========================================================
   KEYBOARD
========================================================= */

function handlePlayerKeyboard(
  event
) {

  if (
    !playerUiShell ||
    playerSection.classList.contains(
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


  if (
    key ===
    " "
  ) {

    event.preventDefault();


    if (
      video.paused
    ) {

      video.play().catch(
        () => {}
      );

    } else {

      video.pause();

    }


    updatePlayerUi();

  }


  if (
    key ===
    "m"
  ) {

    video.muted =
      !video.muted;


    updatePlayerUi();

  }


  if (
    key ===
    "f"
  ) {

    toggleFullscreen();

  }


  if (
    key ===
    "g"
  ) {

    seekToConfiguredLivePosition();

  }


  if (
    key ===
    "arrowup"
  ) {

    event.preventDefault();


    video.volume =
      Math.min(
        1,
        video.volume +
          0.05
      );


    video.muted =
      false;


    updatePlayerUi();

  }


  if (
    key ===
    "arrowdown"
  ) {

    event.preventDefault();


    video.volume =
      Math.max(
        0,
        video.volume -
          0.05
      );


    updatePlayerUi();

  }


  showPlayerControlsTemporarily();

}


/* =========================================================
   SPINNER
========================================================= */

function showPlayerSpinner() {
  // Only the HTML overlay spinner is shown (avoids double rings)
  if (playerLoading) {
    playerLoading.classList.remove("hidden");
  }
  if (playerUiShell) {
    const spinner = playerUiShell.querySelector('[data-role="spinner"]');
    if (spinner) spinner.style.display = "none";
  }
}


function hidePlayerSpinner() {
  if (playerUiShell) {
    const spinner = playerUiShell.querySelector('[data-role="spinner"]');
    if (spinner) spinner.style.display = "none";
  }
}


/* =========================================================
   ERROR OVERLAY
========================================================= */

function showPlayerErrorOverlay(
  message
) {

  if (
    !playerUiShell
  ) {

    return;

  }


  const overlay =
    playerUiShell.querySelector(
      '[data-role="error"]'
    );


  if (
    !overlay
  ) {

    return;

  }


  const messageElement =
    overlay.querySelector(
      '[data-role="error-message"]'
    );


  if (
    messageElement
  ) {

    messageElement.textContent =
      message ||
      "The channel could not be played.";

  }


  overlay.classList.add(
    "open"
  );

}


function hidePlayerErrorOverlay() {

  if (
    !playerUiShell
  ) {

    return;

  }


  const overlay =
    playerUiShell.querySelector(
      '[data-role="error"]'
    );


  if (
    overlay
  ) {

    overlay.classList.remove(
      "open"
    );

  }

}


/* =========================================================
   RETRY
========================================================= */

async function retryCurrentChannel() {

  if (
    isPlayerRetrying ||
    !currentChannel
  ) {

    return;

  }


  isPlayerRetrying =
    true;


  showPlayerLoading(
    true
  );


  clearPlayerError();


  try {

    await destroyPlayer();


    /*
     * Rebuild the same channel
     * without changing the channel data.
     */

    if (
      lastStreamType ===
      "dash"
    ) {

      await playDash(
        lastStreamUrl
      );

    } else if (
      lastStreamType ===
      "hls"
    ) {

      await playHls(
        lastStreamUrl
      );

    } else {

      throw new Error(
        "Unsupported stream format."
      );

    }

  } catch (
    error
  ) {

    showPlayerError(
      error instanceof Error
        ? error.message
        : String(
            error
          )
    );

  } finally {

    isPlayerRetrying =
      false;


    showPlayerLoading(
      false
    );

  }

}


/* =========================================================
   LIVE STATUS
========================================================= */

function startLiveStatusTimer() {

  stopLiveStatusTimer();


  liveStatusTimer =
    setInterval(
      () => {

        updateLiveStatus();

      },
      1000
    );


  updateLiveStatus();

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


function updateLiveStatus() {

  if (
    !playerControls
  ) {

    return;

  }


  const lagElement =
    playerControls.querySelector(
      '[data-role="live-lag"]'
    );


  if (
    !lagElement
  ) {

    return;

  }


  const lag =
    getCurrentLiveLag();


  if (
    lag ===
    null
  ) {

    lagElement.textContent =
      `LIVE • -${LIVE_DELAY_SECONDS}s`;

    return;

  }


  applyLiveCatchup(lag);


  /*
   * Round to whole seconds.
   * This displays how far behind the
   * currently published live edge playback is.
   */

  const rounded =
    Math.max(
      0,
      Math.round(
        lag
      )
    );


  lagElement.textContent =
    `LIVE • -${rounded}s`;

}


/* =========================================================
   QUALITY
========================================================= */

function formatBandwidthMbps(bw) {
  const n = Number(bw) || 0;
  if (n <= 0) return "";
  const mbps = n / 1e6;
  if (mbps >= 10) return `${Math.round(mbps)} Mbps`;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${Math.round(n / 1e3)} Kbps`;
}

function updateQualityOptions() {

  if (!qualityMenu) {
    return;
  }

  if (
    !shakaPlayer ||
    typeof shakaPlayer.getVariantTracks !== "function"
  ) {
    qualityMenu.innerHTML = `
      <button class="gmax-quality-item active" type="button">Auto</button>
    `;
    return;
  }

  // Real tracks from the loaded stream (DASH/HLS variants)
  let tracks = shakaPlayer.getVariantTracks().filter((track) => {
    if (!track) return false;
    // Accept any video variant with height or bandwidth
    const h = Number(track.height) || 0;
    const bw = Number(track.bandwidth) || 0;
    return h > 0 || bw > 0;
  });

  // Keep distinct height+bandwidth combos (like 576p 2.7Mbps + 576p 1.7Mbps)
  const seen = new Set();
  const uniqueTracks = [];
  for (const track of tracks) {
    const h = Number(track.height) || 0;
    const bw = Number(track.bandwidth) || 0;
    const key = `${h}|${Math.round(bw / 50000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTracks.push(track);
  }

  uniqueTracks.sort((a, b) => {
    const dh = (Number(b.height) || 0) - (Number(a.height) || 0);
    if (dh !== 0) return dh;
    return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0);
  });

  qualityMenu.innerHTML = `
    <div style="padding:6px 10px 4px;font:700 11px/1 system-ui;opacity:.55;letter-spacing:.04em;">Resolution</div>
    <button
      class="gmax-quality-item active"
      data-quality="auto"
      type="button"
    >
      Auto
    </button>
    ${uniqueTracks
      .map((track) => {
        const h = Number(track.height) || 0;
        const label = h > 0 ? `${h}p` : "Video";
        const bwLabel = formatBandwidthMbps(track.bandwidth);
        const text = bwLabel ? `${label} (${bwLabel})` : label;
        return `
          <button
            class="gmax-quality-item"
            data-quality-track="${track.id}"
            type="button"
          >
            ${text}
          </button>
        `;
      })
      .join("")}
  `;


  qualityMenu
    .querySelectorAll(
      "[data-quality]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          event => {

            event.stopPropagation();


            if (
              button.dataset.quality ===
              "auto"
            ) {

              shakaPlayer.configure({
                abr: {
                  enabled:
                    true
                }
              });


              setActiveQualityButton(
                button
              );


              qualityMenu.classList.remove(
                "open"
              );


              return;

            }

          }
        );

      }
    );


  qualityMenu
    .querySelectorAll(
      "[data-quality-track]"
    )
    .forEach(
      button => {

        button.addEventListener(
          "click",
          event => {

            event.stopPropagation();


            const trackId =
              Number(
                button.dataset.qualityTrack
              );


            const selected =
              tracks.find(
                track =>
                  Number(
                    track.id
                  ) ===
                  trackId
              );


            if (
              !selected
            ) {

              return;

            }


            shakaPlayer.configure({
              abr: {
                enabled:
                  false
              }
            });


            shakaPlayer.selectVariantTrack(
              selected,
              true,
              0
            );


            setActiveQualityButton(
              button
            );


            qualityMenu.classList.remove(
              "open"
            );

          }
        );

      }
    );

}


function setActiveQualityButton(
  activeButton
) {

  if (
    !qualityMenu
  ) {

    return;

  }


  qualityMenu
    .querySelectorAll(
      ".gmax-quality-item"
    )
    .forEach(
      item => {

        item.classList.toggle(
          "active",
          item ===
            activeButton
        );

      }
    );

}


/* =========================================================
   UI UPDATE
========================================================= */

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


  const volumeInput =
    playerControls.querySelector(
      '[data-action="volume"]'
    );


  if (
    playButton
  ) {

    playButton.textContent =
      video.paused
        ? "▶"
        : "Ⅱ";

  }


  if (
    muteButton
  ) {

    muteButton.textContent =
      video.muted ||
      video.volume ===
        0
        ? "🔇"
        : "🔊";

  }


  if (
    volumeInput
  ) {

    volumeInput.value =
      String(
        video.volume
      );

  }


  updateLiveStatus();

}


/* =========================================================
   INFINITE SCROLL
========================================================= */

function ensureInfiniteScrollObserver() {

  if (
    infiniteScrollObserver
  ) {

    return;

  }


  let sentinel =
    document.getElementById(
      "gmax-infinite-scroll-sentinel"
    );


  if (
    !sentinel
  ) {

    sentinel =
      document.createElement(
        "div"
      );


    sentinel.id =
      "gmax-infinite-scroll-sentinel";


    sentinel.style.height =
      "1px";


    sentinel.style.width =
      "100%";


    channelsGrid.insertAdjacentElement(
      "afterend",
      sentinel
    );

  }


  infiniteScrollObserver =
    new IntersectionObserver(
      entries => {

        const entry =
          entries[0];


        if (
          !entry.isIntersecting ||
          infiniteScrollBusy ||
          visibleCount >=
            filteredChannels.length
        ) {

          return;

        }


        infiniteScrollBusy =
          true;


        visibleCount +=
          CHANNELS_PER_PAGE;


        renderChannels();


        requestAnimationFrame(
          () => {

            infiniteScrollBusy =
              false;

          }
        );

      },
      {
        root:
          null,

        rootMargin:
          "1000px 0px",

        threshold:
          0
      }
    );


  infiniteScrollObserver.observe(
    sentinel
  );

}


/* =========================================================
   HIDE OLD LOAD MORE
========================================================= */

function hideLoadMore() {

  if (
    loadMore
  ) {

    loadMore.classList.add(
      "hidden"
    );


    loadMore.style.display =
      "none";

  }


  if (
    loadMoreButton
  ) {

    loadMoreButton.style.display =
      "none";

  }

}


/* =========================================================
   SEARCH
========================================================= */

searchInput.addEventListener(
  "input",
  () => {

    visibleCount =
      CHANNELS_PER_PAGE;


    if (
      infiniteScrollObserver
    ) {

      infiniteScrollObserver.disconnect();

      infiniteScrollObserver =
        null;

    }


    const oldSentinel =
      document.getElementById(
        "gmax-infinite-scroll-sentinel"
      );


    if (
      oldSentinel
    ) {

      oldSentinel.remove();

    }


    applyFilters();

  }
);


/* =========================================================
   URL ID
========================================================= */

function getRequestedChannelId() {

  return new URLSearchParams(
    window.location.search
  ).get(
    "id"
  );

}


function openRequestedChannel() {

  const id =
    getRequestedChannelId();


  if (
    !id
  ) {

    return;

  }


  const channel =
    allChannels.find(
      item =>
        String(
          item.id ??
          item.tvgId
        ) ===
        String(
          id
        )
    );


  if (
    !channel
  ) {

    console.warn(
      "Channel ID not found:",
      id
    );


    return;

  }


  setTimeout(
    () => {

      openChannel(
        channel, 0
      );

    },
    200
  );

}


/* =========================================================
   CLOSE PLAYER
========================================================= */

closePlayerButton.addEventListener(
  "click",
  async () => {

    await destroyPlayer();


    video.pause();


    video.removeAttribute(
      "src"
    );


    video.load();


    playerSection.classList.add(
      "hidden"
    );


    playerEmpty.classList.remove(
      "hidden"
    );


    clearPlayerError();


    currentChannel =
      null;


    lastStreamUrl =
      "";


    lastStreamType =
      "";


    const info =
      playerSection.querySelector(
        ".gmax-player-info"
      );


    if (
      info
    ) {

      info.remove();

    }


    const cleanUrl =
      window.location.pathname;


    history.replaceState(
      null,
      "",
      cleanUrl
    );

  }
);


/* =========================================================
   DYNAMIC M3U PARSER
========================================================= */

function parseM3U(text) {
  const lines = text.split('\n');
  const channels = [];
  let currentChannel = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      // New channel block
      currentChannel = {};
      
      // Extract tvg-id
      const idMatch = line.match(/tvg-id="([^"]+)"/);
      if (idMatch) currentChannel.id = idMatch[1];
      
      // Extract tvg-name
      const nameMatch = line.match(/tvg-name="([^"]+)"/);
      if (nameMatch) currentChannel.name = nameMatch[1];
      
      // Extract tvg-logo
      const logoMatch = line.match(/tvg-logo="([^"]+)"/);
      if (logoMatch) currentChannel.logo = logoMatch[1];
      
      // Extract group-title
      const groupMatch = line.match(/group-title="([^"]+)"/);
      if (groupMatch) currentChannel.group = groupMatch[1];
      
      // Fallback name if tvg-name is missing
      if (!currentChannel.name && line.includes(',')) {
        currentChannel.name = line.substring(line.indexOf(',') + 1).trim();
      }
    } 
    else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
      const keyStr = line.split('=')[1];
      if (keyStr && keyStr.includes(':')) {
        const parts = keyStr.split(':');
        // Ensure whitespace is trimmed to prevent DRM crash
        currentChannel.key_id = parts[0].trim();
        currentChannel.key = parts[1].trim();
      }
    }
    else if (line.startsWith('#EXTHTTP:')) {
      try {
        const jsonStr = line.substring(9);
        const httpProps = JSON.parse(jsonStr);
        if (httpProps.cookie) {
          currentChannel.cookie = httpProps.cookie;
        }
      } catch (e) {
        console.warn("Failed to parse EXTHTTP JSON", e);
      }
    }
    else if (!line.startsWith('#')) {
      // It's the URL
      currentChannel.stream_url = line;
      channels.push(currentChannel);
      currentChannel = {}; // Reset for next
    }
  }

  return channels;
}


/* =========================================================
   RECENTLY WATCHED SLIDER
========================================================= */

function renderRecentSlider() {
  const section = document.getElementById("recent-section");
  const slider = document.getElementById("recent-slider");
  if (!section || !slider || !allChannels.length) return;

  const items = recentIds
    .map((id) =>
      allChannels.find(
        (c) => String(c.id || c.tvgId || "") === String(id)
      )
    )
    .filter(Boolean)
    .slice(0, RECENT_MAX);

  if (!items.length) {
    section.classList.add("hidden");
    slider.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  slider.innerHTML = items
    .map((ch) => {
      const logo = getChannelLogo(ch);
      const name = escapeHtml(ch.name || "Channel");
      const id = escapeHtml(String(ch.id || ""));
      return `
        <button type="button" class="recent-card" data-recent-id="${id}" title="${name}">
          ${
            logo
              ? `<img src="${escapeHtml(logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`
              : `<div class="channel-fallback" style="display:flex;width:56px;height:56px;margin:0 auto 6px;border-radius:10px;align-items:center;justify-content:center;background:rgba(255,255,255,.08);font-size:12px;">TV</div>`
          }
          <div class="recent-card-name">${name}</div>
        </button>
      `;
    })
    .join("");

  slider.querySelectorAll("[data-recent-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-recent-id");
      const ch = allChannels.find(
        (c) => String(c.id || c.tvgId || "") === String(id)
      );
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

async function loadChannels() {
  try {
    const response = await fetch(CHANNELS_URL, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`channels.json returned HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("channels.json is not an array.");
    }

    allChannels = data
      .filter(
        (channel) =>
          channel &&
          (channel.name || channel.stream_url || channel.url)
      )
      .map((ch) => {
        // Decode &amp; etc. and force main category
        const name = decodeHtmlEntities(ch.name || "");
        const category = normalizeCategory(
          ch.category || ch.group || "",
          name
        );
        return { ...ch, name, category };
      });

    // jtvplus6 first (original playlist order), then 7/8, then other M3Us at the bottom
    allChannels.sort((a, b) => {
      const rank = (c) => {
        const m = String(
          c.source_m3u ||
            (c.sources && c.sources[0] && c.sources[0].m3u) ||
            ""
        ).toLowerCase();
        if (m.includes("jtvplus6")) return 0;
        if (m.includes("jtvplus7")) return 1;
        if (m.includes("jtvplus8")) return 2;
        if (m.includes("jtv")) return 3;
        return 4;
      };
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      const oa = Number(a.sort_order);
      const ob = Number(b.sort_order);
      if (Number.isFinite(oa) && Number.isFinite(ob) && oa !== ob) return oa - ob;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    filteredChannels = [...allChannels];

    // Header: only channel count (no "0 M3Us loaded")
    if (channelCount) {
      channelCount.textContent = `${allChannels.length.toLocaleString()} channels`;
    }
    if (resultsCount) {
      resultsCount.textContent = `${allChannels.length.toLocaleString()} channels`;
    }

    buildCategories();
    applyFilters();
    renderRecentSlider();
    bindRecentNav();
    openRequestedChannel();

  } catch (error) {
    console.error("Channel loading failed:", error);
    channelCount.textContent = "Failed to load";
    resultsCount.textContent = "0 channels";
    channelsGrid.innerHTML = `
      <div class="empty-grid">
        <strong>Failed to load Jio TV channels</strong>
        <br><br>
        <span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>
      </div>
    `;
  }
}

/* =========================================================
   START
========================================================= */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    hideLoadMore();

    loadChannels();

  }
);
