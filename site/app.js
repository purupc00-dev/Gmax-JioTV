"use strict";


/* =========================================================
   CONFIG
========================================================= */

const CHANNELS_URL = "./channels.json";

const CHANNELS_PER_PAGE = 60;


/* =========================================================
   STATE
========================================================= */

let allChannels = [];

let filteredChannels = [];

let activeCategory = "ALL";

let visibleCount = CHANNELS_PER_PAGE;

let shakaPlayer = null;

let currentChannel = null;

let playerUiStartTime = 0;

let customPlayerControls = null;

let qualityMenu = null;

let playerUiTimer = null;

let infiniteScrollObserver = null;

let infiniteScrollBusy = false;


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


function getCategory(channel) {

  return (
    channel?.category ||
    channel?.group ||
    "Entertainment"
  );

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
   CATEGORIES
========================================================= */

function buildCategories() {

  const categories =
    new Set();


  for (
    const channel of allChannels
  ) {

    const category =
      getCategory(
        channel
      );


    if (
      category
    ) {

      categories.add(
        category
      );

    }

  }


  const sorted =
    [
      ...categories
    ]
      .sort(
        (
          a,
          b
        ) =>
          String(a).localeCompare(
            String(b)
          )
      );


  categoryList.innerHTML =
    "";


  const allButton =
    createCategoryButton(
      "ALL",
      true
    );


  categoryList.appendChild(
    allButton
  );


  for (
    const category of sorted
  ) {

    categoryList.appendChild(
      createCategoryButton(
        category,
        false
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


    loadMore.classList.add(
      "hidden"
    );


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


  /*
   * Infinite scrolling replaces
   * the old LOAD MORE button.
   */

  loadMore.classList.add(
    "hidden"
  );


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
    String(
      channel.id ||
      channel.tvgId ||
      Math.random()
    );


  const favorite =
    favorites.has(
      id
    );


  const logo =
    channel.logo ||
    channel.tvg_logo ||
    "";


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
        channel
      );

    }
  );


  return card;

}


/* =========================================================
   PLAYER
========================================================= */

async function destroyPlayer() {

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

}


function showPlayerLoading(
  state
) {

  playerLoading.classList.toggle(
    "hidden",
    !state
  );

}


function showPlayerError(
  message
) {

  playerError.textContent =
    message;


  playerError.classList.remove(
    "hidden"
  );

}


function clearPlayerError() {

  playerError.textContent =
    "";


  playerError.classList.add(
    "hidden"
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
    channel.id ||
    channel.tvgId;


  let streamUrl =
    getStreamUrl(
      channel
    );


  /*
   * Append __hdnea__ to the
   * initial MPD URL.
   */

  if (
    channel.cookie &&
    channel.cookie.includes(
      "__hdnea__="
    )
  ) {

    const separator =
      streamUrl.includes(
        "?"
      )
        ? "&"
        : "?";


    streamUrl =
      `${streamUrl}${separator}${channel.cookie}`;

  }


  if (
    !streamUrl
  ) {

    showPlayerError(
      "This channel does not contain a playable stream URL."
    );

    return;

  }


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


  showPlayerLoading(
    true
  );


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


  const type =
    streamType(
      channel
    );


  try {

    if (
      type ===
      "dash"
    ) {

      await playDash(
        streamUrl
      );

    } else if (
      type ===
      "hls"
    ) {

      await playHls(
        streamUrl
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
        : String(error)
    );

  } finally {

    showPlayerLoading(
      false
    );

  }

}


/* =========================================================
   DASH
========================================================= */

async function playDash(
  streamUrl
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

    }
  );


  /* =========================================================
     HDNEA AUTH
     Keep same token on MPD,
     audio and video segments.
  ========================================================= */

  let hdneaCookie =
    null;


  if (
    currentChannel &&
    currentChannel.cookie &&
    currentChannel.cookie.includes(
      "__hdnea__="
    )
  ) {

    hdneaCookie =
      currentChannel.cookie;

  }


  if (
    hdneaCookie
  ) {

    const networkingEngine =
      shakaPlayer.getNetworkingEngine();


    if (
      networkingEngine
    ) {

      networkingEngine.registerRequestFilter(
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
            isManifest ||
            isSegment
          ) {

            request.uris =
              request.uris.map(
                uri => {

                  if (
                    !uri ||
                    uri.includes(
                      "__hdnea__="
                    )
                  ) {

                    return uri;

                  }


                  const separator =
                    uri.includes(
                      "?"
                    )
                      ? "&"
                      : "?";


                  return (
                    uri +
                    separator +
                    hdneaCookie
                  );

                }
              );

          }

        }
      );

    }

  }


  /* =========================================================
     CLEARKEY DRM
  ========================================================= */

  if (
    currentChannel &&
    currentChannel.key_id &&
    currentChannel.key
  ) {

    const clearKeys =
      {};


    clearKeys[
      currentChannel.key_id
    ] =
      currentChannel.key;


    shakaPlayer.configure({
      drm: {
        clearKeys
      }
    });

  }


  /* =========================================================
     LOAD MPD
  ========================================================= */

  await shakaPlayer.load(
    streamUrl
  );


  /*
   * IMPORTANT:
   * Keep real live position.
   * Only our UI timer starts at 00:00.
   */

  playerUiStartTime =
    Number.isFinite(
      video.currentTime
    )
      ? video.currentTime
      : 0;


  video.controls =
    false;


  setupCustomPlayerControls();

  updateQualityOptions();

  updatePlayerUi();


  await video.play().catch(
    () => {}
  );

}


/* =========================================================
   HLS
========================================================= */

async function playHls(
  streamUrl
) {

  /*
   * Native HLS
   */

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      streamUrl;


    video.controls =
      false;


    playerUiStartTime =
      Number.isFinite(
        video.currentTime
      )
        ? video.currentTime
        : 0;


    setupCustomPlayerControls();

    updateQualityOptions();

    updatePlayerUi();


    await video.play().catch(
      () => {}
    );


    return;

  }


  /*
   * Shaka HLS
   */

  if (
    window.shaka &&
    shaka.Player.isBrowserSupported()
  ) {

    shakaPlayer =
      new shaka.Player();


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

      }
    );


    /*
     * If the HLS stream also provides
     * the channel cookie, apply it to
     * manifest + segments.
     */

    if (
      currentChannel &&
      currentChannel.cookie &&
      currentChannel.cookie.includes(
        "__hdnea__="
      )
    ) {

      const hdneaCookie =
        currentChannel.cookie;


      const networkingEngine =
        shakaPlayer.getNetworkingEngine();


      if (
        networkingEngine
      ) {

        networkingEngine.registerRequestFilter(
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
              isManifest ||
              isSegment
            ) {

              request.uris =
                request.uris.map(
                  uri => {

                    if (
                      !uri ||
                      uri.includes(
                        "__hdnea__="
                      )
                    ) {

                      return uri;

                    }


                    const separator =
                      uri.includes(
                        "?"
                      )
                        ? "&"
                        : "?";


                    return (
                      uri +
                      separator +
                      hdneaCookie
                    );

                  }
                );

            }

          }
        );

      }

    }


    await shakaPlayer.load(
      streamUrl
    );


    playerUiStartTime =
      Number.isFinite(
        video.currentTime
      )
        ? video.currentTime
        : 0;


    video.controls =
      false;


    setupCustomPlayerControls();

    updateQualityOptions();

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
   CUSTOM PLAYER UI
========================================================= */

function ensurePlayerShell() {

  if (
    !video
  ) {

    return null;

  }


  let shell =
    video.closest(
      ".gmax-player-shell"
    );


  if (
    shell
  ) {

    return shell;

  }


  const parent =
    video.parentElement;


  if (
    !parent
  ) {

    return null;

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


  injectPlayerStyles();


  return shell;

}


/* =========================================================
   PLAYER STYLES
========================================================= */

function injectPlayerStyles() {

  if (
    document.getElementById(
      "gmax-iptv-player-styles"
    )
  ) {

    return;

  }


  const style =
    document.createElement(
      "style"
    );


  style.id =
    "gmax-iptv-player-styles";


  style.textContent = `

    .gmax-player-shell {

      position: relative;

      width: 100%;

      aspect-ratio: 16 / 9;

      min-height: 240px;

      background: #000;

      overflow: hidden;

      border-radius: 16px;

      box-shadow:
        0 24px 80px
        rgba(
          0,
          0,
          0,
          .45
        );

      user-select: none;

    }


    .gmax-player-shell video {

      display: block;

      width: 100%;

      height: 100%;

      object-fit: contain;

      background: #000;

    }


    .gmax-player-controls {

      position: absolute;

      left: 0;

      right: 0;

      bottom: 0;

      padding:
        34px
        18px
        14px;

      display: flex;

      align-items: center;

      gap: 10px;

      color: #fff;

      background:
        linear-gradient(
          transparent,
          rgba(
            0,
            0,
            0,
            .88
          )
        );

      opacity: 1;

      transition:
        opacity
        .2s ease;

      z-index: 20;

    }


    .gmax-player-shell.gmax-controls-hidden
      .gmax-player-controls {

      opacity: 0;

      pointer-events: none;

    }


    .gmax-player-btn {

      width: 36px;

      height: 36px;

      border: 0;

      border-radius: 10px;

      background:
        rgba(
          255,
          255,
          255,
          .09
        );

      color: #fff;

      cursor: pointer;

      display: grid;

      place-items: center;

      font-size: 16px;

      transition:
        background
        .15s ease,
        transform
        .15s ease;

      flex:
        0 0 auto;

    }


    .gmax-player-btn:hover {

      background:
        rgba(
          255,
          255,
          255,
          .18
        );

      transform:
        translateY(-1px);

    }


    .gmax-player-time {

      min-width: 64px;

      font:
        600
        13px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .02em;

      opacity:
        .92;

    }


    .gmax-live-pill {

      font:
        800
        11px/1
        system-ui,
        sans-serif;

      letter-spacing:
        .08em;

      padding:
        6px
        8px;

      border-radius:
        999px;

      background:
        rgba(
          229,
          9,
          20,
          .96
        );

      color:
        #fff;

    }


    .gmax-player-spacer {

      flex: 1;

    }


    .gmax-volume {

      width:
        90px;

      accent-color:
        #fff;

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
        48px;

      min-width:
        150px;

      max-height:
        260px;

      overflow-y:
        auto;

      padding:
        7px;

      border:
        1px solid
        rgba(
          255,
          255,
          255,
          .12
        );

      border-radius:
        12px;

      background:
        rgba(
          18,
          18,
          18,
          .97
        );

      box-shadow:
        0
        20px
        50px
        rgba(
          0,
          0,
          0,
          .55
        );

      display:
        none;

      backdrop-filter:
        blur(
          14px
        );

      z-index:
        50;

    }


    .gmax-quality-menu.open {

      display:
        block;

    }


    .gmax-quality-item {

      width:
        100%;

      border:
        0;

      border-radius:
        8px;

      padding:
        9px
        10px;

      background:
        transparent;

      color:
        #ddd;

      text-align:
        left;

      cursor:
        pointer;

      font:
        600
        12px
        system-ui,
        sans-serif;

    }


    .gmax-quality-item:hover,
    .gmax-quality-item.active {

      background:
        rgba(
          255,
          255,
          255,
          .1
        );

      color:
        #fff;

    }


    @media (
      max-width: 700px
    ) {

      .gmax-player-shell {

        border-radius:
          10px;

      }


      .gmax-volume {

        display:
          none;

      }


      .gmax-player-controls {

        padding:
          28px
          10px
          9px;

        gap:
          7px;

      }


      .gmax-player-btn {

        width:
          34px;

        height:
          34px;

      }

    }

  `;


  document.head.appendChild(
    style
  );

}


/* =========================================================
   TIME FORMAT
========================================================= */

function formatPlayerTime(
  seconds
) {

  const safe =
    Math.max(
      0,
      Math.floor(
        Number.isFinite(
          seconds
        )
          ? seconds
          : 0
      )
    );


  const hours =
    Math.floor(
      safe /
      3600
    );


  const minutes =
    Math.floor(
      (
        safe %
        3600
      ) /
      60
    );


  const secs =
    safe %
    60;


  if (
    hours >
    0
  ) {

    return (
      String(
        hours
      ).padStart(
        2,
        "0"
      ) +
      ":" +
      String(
        minutes
      ).padStart(
        2,
        "0"
      ) +
      ":" +
      String(
        secs
      ).padStart(
        2,
        "0"
      )
    );

  }


  return (
    String(
      minutes
    ).padStart(
      2,
      "0"
    ) +
    ":" +
    String(
      secs
    ).padStart(
      2,
      "0"
    )
  );

}


/* =========================================================
   SETUP CUSTOM CONTROLS
========================================================= */

function setupCustomPlayerControls() {

  const shell =
    ensurePlayerShell();


  if (
    !shell
  ) {

    return;

  }


  if (
    customPlayerControls
  ) {

    updatePlayerUi();

    return;

  }


  const controls =
    document.createElement(
      "div"
    );


  controls.className =
    "gmax-player-controls";


  controls.innerHTML = `

    <button
      class="gmax-player-btn"
      data-action="play"
      type="button"
      title="Play / Pause"
    >
      ▶
    </button>


    <button
      class="gmax-player-btn"
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
      class="gmax-player-time"
      data-role="time"
    >
      00:00
    </span>


    <span
      class="gmax-live-pill"
    >
      LIVE
    </span>


    <span
      class="gmax-player-spacer"
    >
    </span>


    <div
      class="gmax-quality-wrap"
    >

      <button
        class="gmax-player-btn"
        data-action="quality"
        type="button"
        title="Quality"
      >
        ⚙
      </button>


      <div
        class="gmax-quality-menu"
        data-role="quality-menu"
      >
      </div>

    </div>


    <button
      class="gmax-player-btn"
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


  customPlayerControls =
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


  const fullscreenButton =
    controls.querySelector(
      '[data-action="fullscreen"]'
    );


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


      if (
        document.fullscreenElement
      ) {

        document
          .exitFullscreen()
          .catch(
            () => {}
          );

      } else {

        shell
          .requestFullscreen()
          .catch(
            () => {}
          );

      }

    }
  );


  shell.addEventListener(
    "click",
    event => {

      if (
        event.target ===
        video
      ) {

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

    }
  );


  [
    "play",
    "pause",
    "timeupdate",
    "volumechange",
    "loadedmetadata"
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

      shell.classList.remove(
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

              shell.classList.add(
                "gmax-controls-hidden"
              );

            }

          },
          2500
        );

    }
  );


  qualityMenu.addEventListener(
    "click",
    event => {

      event.stopPropagation();


      const item =
        event.target.closest(
          "[data-quality-index]"
        );


      if (
        !item ||
        !shakaPlayer
      ) {

        return;

      }


      const index =
        item.dataset.qualityIndex;


      if (
        index ===
        "auto"
      ) {

        shakaPlayer.configure({
          abr: {
            enabled:
              true
          }
        });


      } else {

        const trackIndex =
          Number(
            index
          );


        const tracks =
          shakaPlayer.getVariantTracks();


        const track =
          tracks[
            trackIndex
          ];


        if (
          track
        ) {

          shakaPlayer.configure({
            abr: {
              enabled:
                false
            }
          });


          shakaPlayer.selectVariantTrack(
            track,
            true,
            0
          );

        }

      }


      qualityMenu.classList.remove(
        "open"
      );


      updateQualityOptions();

    }
  );


  shell.addEventListener(
    "mouseleave",
    () => {

      if (
        !video.paused
      ) {

        shell.classList.add(
          "gmax-controls-hidden"
        );

      }

    }
  );

}


/* =========================================================
   QUALITY OPTIONS
========================================================= */

function updateQualityOptions() {

  if (
    !qualityMenu
  ) {

    return;

  }


  if (
    !shakaPlayer ||
    typeof
      shakaPlayer.getVariantTracks !==
        "function"
  ) {

    qualityMenu.innerHTML =
      `
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
      .getVariantTracks()
      .filter(
        track =>
          track.video &&
          track.height
      );


  const unique =
    [];


  const seen =
    new Set();


  tracks
    .sort(
      (
        a,
        b
      ) =>
        Number(
          b.height ||
          0
        ) -
        Number(
          a.height ||
          0
        )
    )
    .forEach(
      track => {

        const label =
          `${track.height}p${
            track.frameRate
              ? ` ${Math.round(
                  track.frameRate
                )}fps`
              : ""
          }`;


        if (
          !seen.has(
            label
          )
        ) {

          seen.add(
            label
          );


          unique.push({
            label,
            index:
              tracks.indexOf(
                track
              )
          });

        }

      }
    );


  qualityMenu.innerHTML =
    `

      <button
        class="gmax-quality-item active"
        data-quality-index="auto"
        type="button"
      >
        Auto
      </button>

      ${
        unique
          .map(
            item => `
              <button
                class="gmax-quality-item"
                data-quality-index="${item.index}"
                type="button"
              >
                ${item.label}
              </button>
            `
          )
          .join(
            ""
          )
      }

    `;

}


/* =========================================================
   PLAYER UI UPDATE
========================================================= */

function updatePlayerUi() {

  if (
    !customPlayerControls
  ) {

    return;

  }


  const playButton =
    customPlayerControls.querySelector(
      '[data-action="play"]'
    );


  const muteButton =
    customPlayerControls.querySelector(
      '[data-action="mute"]'
    );


  const volumeInput =
    customPlayerControls.querySelector(
      '[data-action="volume"]'
    );


  const time =
    customPlayerControls.querySelector(
      '[data-role="time"]'
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


  if (
    time
  ) {

    const elapsed =
      Math.max(
        0,
        (
          Number.isFinite(
            video.currentTime
          )
            ? video.currentTime
            : 0
        ) -
          playerUiStartTime
      );


    time.textContent =
      formatPlayerTime(
        elapsed
      );

  }

}


/* =========================================================
   INFINITE CHANNEL SCROLL
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
        root: null,

        rootMargin:
          "900px 0px",

        threshold:
          0
      }
    );


  infiniteScrollObserver.observe(
    sentinel
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


    playerUiStartTime =
      0;


    if (
      customPlayerControls
    ) {

      const shell =
        customPlayerControls.closest(
          ".gmax-player-shell"
        );


      if (
        shell
      ) {

        shell.classList.remove(
          "gmax-controls-hidden"
        );

      }

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
   OLD LOAD MORE BUTTON
========================================================= */

/*
 * Infinite scroll now handles this.
 */

if (
  loadMoreButton
) {

  loadMoreButton.style.display =
    "none";

}


if (
  loadMore
) {

  loadMore.style.display =
    "none";

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
        channel
      );

    },
    200
  );

}


/* =========================================================
   LOAD CHANNELS
========================================================= */

async function loadChannels() {

  try {

    const response =
      await fetch(
        CHANNELS_URL,
        {
          cache:
            "no-store"
        }
      );


    if (
      !response.ok
    ) {

      throw new Error(
        `channels.json returned HTTP ${response.status}`
      );

    }


    const data =
      await response.json();


    if (
      !Array.isArray(
        data
      )
    ) {

      throw new Error(
        "channels.json is not an array."
      );

    }


    allChannels =
      data.filter(
        channel =>
          channel &&
          (
            channel.name ||
            channel.stream_url ||
            channel.url
          )
      );


    filteredChannels =
      [
        ...allChannels
      ];


    channelCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;


    resultsCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;


    buildCategories();

    applyFilters();

    openRequestedChannel();


  } catch (
    error
  ) {

    console.error(
      "Channel loading failed:",
      error
    );


    channelCount.textContent =
      "Failed to load";


    resultsCount.textContent =
      "0 channels";


    channelsGrid.innerHTML = `
      <div class="empty-grid">

        <strong>
          Failed to load Jio TV channels
        </strong>

        <br>
        <br>

        <span>
          ${escapeHtml(
            error instanceof Error
              ? error.message
              : String(
                  error
                )
          )}
        </span>

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

    if (
      loadMore
    ) {

      loadMore.style.display =
        "none";

    }


    if (
      loadMoreButton
    ) {

      loadMoreButton.style.display =
        "none";

    }


    loadChannels();

  }
);
