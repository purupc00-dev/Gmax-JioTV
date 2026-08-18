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
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    url.includes(".mpd")
  ) {
    return "dash";
  }

  if (
    url.includes(".m3u8")
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
      [...favorites]
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
    String(channelId);

  if (
    favorites.has(key)
  ) {

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

  const categories =
    new Set();

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
    [...categories]
      .sort(
        (a, b) =>
          String(a).localeCompare(
            String(b)
          )
      );

  categoryList.innerHTML = "";

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
    String(category);

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
                String(category)
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
          activeCategory === "ALL" ||
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

        if (!query) {
          return true;
        }

        const searchable = [
          channel.name,
          channel.id,
          channel.group,
          channel.category,
          channel.language,
          channel.country,
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
   CHANNEL RENDERING
========================================================= */

function renderChannels() {

  const visible =
    filteredChannels.slice(
      0,
      visibleCount
    );

  channelsGrid.innerHTML = "";

  if (
    visible.length === 0
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


  if (
    visibleCount <
    filteredChannels.length
  ) {

    loadMore.classList.remove(
      "hidden"
    );

    loadMoreButton.textContent =
      `LOAD MORE CHANNELS (${(
        filteredChannels.length -
        visibleCount
      ).toLocaleString()} REMAINING)`;

  } else {

    loadMore.classList.add(
      "hidden"
    );

  }

}


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
    favorites.has(id);


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

    } catch (error) {

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


  // Append __hdnea__ cookie to the MPD URL (from jtvplus6 / Geoplus)
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

    streamUrl = `${streamUrl}${separator}${channel.cookie}`;

  }


  if (!streamUrl) {

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


  playingMeta.textContent = [
    "JIO TV",
    channel.country ||
      "INDIA",
    getCategory(channel)
  ]
    .filter(Boolean)
    .join(" • ");


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
    behavior: "smooth",
  });


  await destroyPlayer();


  const type =
    streamType(
      channel
    );


  try {

    if (
      type === "dash"
    ) {

      await playDash(
        streamUrl
      );

    } else if (
      type === "hls"
    ) {

      await playHls(
        streamUrl
      );

    } else {

      throw new Error(
        `Unsupported stream format:\n${streamUrl}`
      );

    }

  } catch (error) {

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


  /*
   * =========================================================
   * HDNEA AUTH
   * Add the same cookie/token to MPD,
   * audio segments and video segments.
   * =========================================================
   */

  let hdneaCookie = null;


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


  /*
   * =========================================================
   * SHAKA REQUEST FILTER
   * =========================================================
   */

  if (
    hdneaCookie
  ) {

    const networkingEngine =
      shakaPlayer.getNetworkingEngine();


    if (
      networkingEngine
    ) {

      networkingEngine.registerRequestFilter(
        (requestType, request) => {

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


  /*
   * =========================================================
   * CLEARKEY DRM
   * =========================================================
   */

  if (
    currentChannel &&
    currentChannel.key_id &&
    currentChannel.key
  ) {

    const clearKeys = {};


    clearKeys[
      currentChannel.key_id
    ] =
      currentChannel.key;


    shakaPlayer.configure({

      drm: {

        clearKeys:
          clearKeys

      }

    });

  }


  /*
   * =========================================================
   * LOAD MPD
   * =========================================================
   */

  await shakaPlayer.load(
    streamUrl
  );


  video.controls =
    true;


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
   * Safari / browsers with native HLS
   */

  if (
    video.canPlayType(
      "application/vnd.apple.mpegurl"
    )
  ) {

    video.src =
      streamUrl;

    video.controls =
      true;

    await video.play().catch(
      () => {}
    );

    return;
  }


  /*
   * Shaka can also handle
   * browser-playable HLS.
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


    await shakaPlayer.load(
      streamUrl
    );


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
   LOAD MORE
========================================================= */

loadMoreButton.addEventListener(
  "click",
  () => {

    visibleCount +=
      CHANNELS_PER_PAGE;

    renderChannels();

  }
);


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
   URL ID
========================================================= */

function getRequestedChannelId() {

  return new URLSearchParams(
    window.location.search
  ).get("id");

}


function openRequestedChannel() {

  const id =
    getRequestedChannelId();

  if (!id) {
    return;
  }


  const channel =
    allChannels.find(
      item =>
        String(
          item.id ??
          item.tvgId
        ) === String(id)
    );


  if (!channel) {

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
          cache: "no-store",
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
      !Array.isArray(data)
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
      [...allChannels];


    channelCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;


    resultsCount.textContent =
      `${allChannels.length.toLocaleString()} channels`;


    buildCategories();

    applyFilters();

    openRequestedChannel();


  } catch (error) {

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
              : String(error)
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

    loadChannels();

  }
);
