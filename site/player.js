/**
 * Gmax-JioTV Player — robust Shaka (no browser proxy)
 * Multi-server fallback, grey-out dead sources, pause overlay
 */

"use strict";

const CONFIG = {
  GATEWAY_BASE: "https://playlist.gmaxhub.workers.dev",
  CHANNELS_ENDPOINT: "/channels",
  SERVERS_MAP_KEY: "gmax_servers_map",
  MOST_VIEWED_KEY: "gmax_most_viewed",
  UI_HIDE_MS: 3500,
};

const $ = (s) => document.querySelector(s);
const video = $("#video");
const shell = $("#player-shell");
const stage = $("#video-stage");

let player = null;
let channel = null;
let serverIndex = 0;
let aspectMode = 0;
const ASPECT_LABELS = ["Fit", "Fill", "Stretch"];
let hideTimer = null;
let audioCtx = null;
let gainNode = null;
let boost = 1;
let reconnectAttempt = 0;
/** serverIndex → 'ok' | 'dead' | 'unknown' */
const serverStatus = new Map();

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}
function showLoading(t = "Connecting…") {
  $("#overlay-loading").classList.remove("hidden");
  $("#overlay-error").classList.add("hidden");
  $("#loading-text").textContent = t;
}
function hideLoading() {
  $("#overlay-loading").classList.add("hidden");
}
function showError(msg) {
  hideLoading();
  $("#overlay-error").classList.remove("hidden");
  $("#error-text").textContent = msg;
}
function hideError() {
  $("#overlay-error").classList.add("hidden");
}
function trackView(id) {
  try {
    const map = JSON.parse(localStorage.getItem(CONFIG.MOST_VIEWED_KEY) || "{}");
    map[String(id)] = (map[String(id)] || 0) + 1;
    localStorage.setItem(CONFIG.MOST_VIEWED_KEY, JSON.stringify(map));
  } catch (_) {}
}

function normalizeCookie(token) {
  if (!token) return token;
  let c = String(token).trim();
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(c);
      if (next === c) break;
      c = next;
    } catch (_) { break; }
  }
  if (c && !/^(hdntl|__hdnea__|hdnea)=/i.test(c) && /exp=\d+/i.test(c)) {
    c = "hdntl=" + c;
  }
  return c;
}

function base64ToHex(base64UrlStr) {
  let base64 = base64UrlStr.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const raw = atob(base64);
  let hex = "";
  for (let i = 0; i < raw.length; i++) {
    const h = raw.charCodeAt(i).toString(16);
    hex += h.length === 2 ? h : "0" + h;
  }
  return hex;
}

function normClearKey(v) {
  let s = (v || "").toString().replace(/-/g, "").toLowerCase().trim();
  if (s && !/^[0-9a-f]+$/i.test(s) && s.length < 40) {
    try { s = base64ToHex(s); } catch (_) {}
  }
  s = (s || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  if (s.length > 0 && s.length < 32) s = s.padEnd(32, "0");
  if (s.length > 32) s = s.slice(0, 32);
  return s;
}

function sanitizeUrl(url) {
  if (!url) return url;
  let cleaned = url.trim();
  cleaned = cleaned.replace(/^(https?:\/\/[^\/]+)\/*/i, "$1/");
  cleaned = cleaned.replace(/([^:]\/)\/+/g, "$1");
  cleaned = cleaned.replace(/\\/g, "/").replace(/&+$/, "");
  return cleaned;
}

function stripTokensFromUrl(url) {
  if (!url) return url;
  return url
    .replace(/([?&])(__hdnea__|hdntl|hdnea)=[^&]*/gi, "")
    .replace(/([?&])st=\d+~exp=\d+~acl=[^~]+~hmac=[a-f0-9]+/gi, "")
    .replace(/\?&/g, "?")
    .replace(/[?&]$/, "");
}

function appendToken(url, token) {
  if (!token || !url) return url;
  return url + (url.includes("?") ? "&" : "?") + token;
}

function unwrapProxyUrl(url) {
  if (!url) return url;
  let current = url;
  for (let i = 0; i < 5; i++) {
    try {
      if (!/proxy\.gmaxhub\.workers\.dev|gmaxhub\.vercel\.app\/api\/proxy|corsproxy\.io/i.test(current)) break;
      const u = new URL(current);
      const inner = u.searchParams.get("uri") || u.searchParams.get("url") || u.searchParams.get("u");
      if (!inner) break;
      current = inner;
    } catch (_) { break; }
  }
  return current;
}

/** Unwrap corsproxy / pipe so pre-proxied M3U links still work */
function splitPipeUrl(raw) {
  if (!raw) return { url: raw, headers: {} };
  let url = unwrapProxyUrl(raw);
  const headers = {};
  if (url.includes("|")) {
    const parts = url.split("|");
    url = parts[0];
    parts.slice(1).join("|").split("&").forEach((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return;
      const k = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
      const v = decodeURIComponent(pair.slice(eq + 1));
      if (k === "cookie" || k === "http-cookie") headers.cookie = v;
      else if (k === "user-agent" || k === "ua") headers.userAgent = v;
      else if (k === "referer" || k === "referrer") headers.referrer = v;
      else if (k === "origin") headers.origin = v;
    });
  }
  return { url: sanitizeUrl(url), headers };
}

function detectTokenType(cookie, url) {
  const c = (cookie || "") + " " + (url || "");
  if (/hotstar\.com|hdntl=/i.test(c)) return "HOTSTAR";
  if (/__hdnea__|jiotv|jio\.com/i.test(c)) return "JIO";
  if (/sonyliv|sliv/i.test(c)) return "SONYLIV";
  return "OTHER";
}

function parseKeyResponse(text) {
  const map = {};
  if (!text) return map;
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const jwk = JSON.parse(t);
      if (jwk.keys && Array.isArray(jwk.keys)) {
        jwk.keys.forEach((k) => {
          if (k.kid && k.k) {
            const kid = normClearKey(base64ToHex(k.kid));
            const key = normClearKey(base64ToHex(k.k));
            if (kid.length === 32 && key.length === 32) map[kid] = key;
          }
        });
      }
    } catch (_) {}
    return map;
  }
  if (t.includes(":") && !t.startsWith("<")) {
    t.split(/\r?\n/).filter(Boolean).forEach((line) => {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const kid = normClearKey(parts[0]);
        const key = normClearKey(parts[1]);
        if (kid.length === 32 && key.length === 32) map[kid] = key;
      }
    });
  }
  return map;
}

function parseLicenseField(licenseKey) {
  const out = { clearKeys: {}, licenseUrl: null };
  if (!licenseKey) return out;
  const s = String(licenseKey).trim();
  if (/^https?:\/\//i.test(s)) {
    out.licenseUrl = s;
    return out;
  }
  if (s.startsWith("{")) {
    Object.assign(out.clearKeys, parseKeyResponse(s));
    return out;
  }
  if (s.includes(":")) {
    const [kid, key] = s.split(":");
    const k1 = normClearKey(kid);
    const k2 = normClearKey(key);
    if (k1.length === 32 && k2.length === 32) out.clearKeys[k1] = k2;
  }
  return out;
}

async function fetchRemoteKeys(licenseUrl) {
  try {
    const res = await fetch(licenseUrl, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (!res.ok) return { clearKeys: {}, licenseUrl };
    const text = (await res.text()).trim();
    if (!text || text.startsWith("<!") || /^<html/i.test(text)) {
      return { clearKeys: {}, licenseUrl };
    }
    const parsed = parseKeyResponse(text);
    if (Object.keys(parsed).length) return { clearKeys: parsed, licenseUrl: null };
  } catch (_) {}
  return { clearKeys: {}, licenseUrl };
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s*\|\s*gmaxhub\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the richest multi-server list for this channel:
 * 1) localStorage (fast)
 * 2) full /channels (all playlists merged on Worker)
 * 3) if still thin, merge primary + rest scopes
 */
async function resolveChannel(id) {
  let fromCache = null;
  try {
    const raw = localStorage.getItem(CONFIG.SERVERS_MAP_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      fromCache = map[id] || Object.values(map).find((c) => String(c.id) === String(id)) || null;
    }
  } catch (_) {}

  const pick = (list) => {
    if (!list || !list.length) return null;
    return (
      list.find((c) => String(c.id) === String(id)) ||
      (fromCache
        ? list.find((c) => normalizeName(c.name) === normalizeName(fromCache.name))
        : null) ||
      null
    );
  };

  const mergeServers = (base, extraList) => {
    if (!base) return extraList;
    if (!extraList) return base;
    const out = { ...base, servers: [...(base.servers || [])] };
    const urls = new Set(out.servers.map((s) => s.url).filter(Boolean));
    for (const s of extraList) {
      if (s.url && !urls.has(s.url)) {
        urls.add(s.url);
        out.servers.push({
          ...s,
          label: s.label || `Server ${out.servers.length + 1}`,
        });
      }
    }
    return out;
  };

  // A) Full directory (best)
  try {
    const res = await fetch(CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      let found = pick(data.channels || []);
      if (found && (found.servers || []).length > 1) {
        return found;
      }
      if (found) fromCache = mergeServers(fromCache, found.servers);
      if (found && !fromCache) fromCache = found;
    }
  } catch (e) {
    console.warn("Full /channels failed", e);
  }

  // B) primary + rest scopes (explicit multi-source merge)
  try {
    const [pRes, rRes] = await Promise.all([
      fetch(CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT + "?scope=primary", { cache: "no-store" }),
      fetch(CONFIG.GATEWAY_BASE + CONFIG.CHANNELS_ENDPOINT + "?scope=rest", { cache: "no-store" }),
    ]);
    let ch = fromCache;
    if (pRes.ok) {
      const pdata = await pRes.json();
      const found = pick(pdata.channels || []);
      if (found) ch = mergeServers(ch, found.servers) || found;
    }
    if (rRes.ok) {
      const rdata = await rRes.json();
      // extraServers keyed by normalized name
      if (ch && rdata.extraServers) {
        const key = normalizeName(ch.name);
        const adds = rdata.extraServers[key] || [];
        ch = mergeServers(ch, adds);
      }
      // extraChannels — channel only on secondary playlists
      if (rdata.extraChannels) {
        const found = pick(rdata.extraChannels);
        if (found) ch = mergeServers(ch, found.servers) || found;
      }
    }
    if (ch) return ch;
  } catch (e) {
    console.warn("primary+rest merge failed", e);
  }

  if (fromCache) return fromCache;
  throw new Error("Channel not found");
}

async function createPlayer() {
  if (player) {
    try { await player.destroy(); } catch (_) {}
    player = null;
  }
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error("Browser not supported");
  player = new shaka.Player();
  await player.attach(video);
  player.addEventListener("error", onPlayerError);
  player.addEventListener("buffering", (e) => {
    if (e.buffering) showLoading("Buffering…");
    else hideLoading();
  });
  player.addEventListener("stalldetected", () => {
    try { video.currentTime = video.currentTime + 0.05; } catch (_) {}
  });
  return player;
}

function onPlayerError(event) {
  const err = event.detail;
  console.warn("Shaka error", err?.code, err);
  // Mark current server dead on network / DRM / HTTP errors
  if (err && (err.category === 1 || err.category === 4 || err.category === 6 ||
      [1001, 1002, 1003, 4012, 6001, 6007, 6012].includes(err.code))) {
    markServerDead(serverIndex);
    tryFallback(err);
  }
}

function markServerDead(idx) {
  serverStatus.set(idx, "dead");
  buildServerMenu();
}

function markServerOk(idx) {
  serverStatus.set(idx, "ok");
  buildServerMenu();
}

function nextAliveIndex(from) {
  const n = (channel.servers || []).length;
  for (let step = 1; step < n; step++) {
    const i = (from + step) % n;
    if (serverStatus.get(i) !== "dead") return i;
  }
  return -1;
}

async function tryFallback(err) {
  reconnectAttempt++;
  const next = nextAliveIndex(serverIndex);
  if (next >= 0) {
    showLoading(`Reconnecting ${reconnectAttempt}…`);
    await loadServer(next);
    return;
  }
  showError(
    reconnectAttempt > 1
      ? "Channel isn't available on any server"
      : err?.message || "Playback failed"
  );
}

async function loadServer(index) {
  if (!channel?.servers?.length) throw new Error("No servers");
  if (serverStatus.get(index) === "dead") {
    const alt = nextAliveIndex(index);
    if (alt < 0) {
      showError("Channel isn't available on any server");
      return;
    }
    index = alt;
  }

  serverIndex = index;
  let server = { ...channel.servers[serverIndex] };

  $("#server-label").textContent = server.label || `Srv ${serverIndex + 1}`;
  buildServerMenu();
  showLoading(reconnectAttempt ? `Reconnecting ${reconnectAttempt}…` : "Connecting…");
  hideError();

  const pipe = splitPipeUrl(server.url || "");
  server.url = pipe.url;
  if (pipe.headers.cookie && !server.cookie) server.cookie = pipe.headers.cookie;
  if (pipe.headers.userAgent && !server.userAgent) server.userAgent = pipe.headers.userAgent;
  if (pipe.headers.referrer && !server.referrer) server.referrer = pipe.headers.referrer;
  if (pipe.headers.origin && !server.origin) server.origin = pipe.headers.origin;
  if (server.cookie) server.cookie = normalizeCookie(server.cookie);

  const tokenType = detectTokenType(server.cookie, server.url);
  const isHotstar = tokenType === "HOTSTAR" || /hotstar\.com/i.test(server.url || "");

  if (isHotstar) {
    if (!server.userAgent || /gmaxhub/i.test(server.userAgent)) {
      server.userAgent = "Hotstar;in.startv.hotstar/25.02.24.8.11169@Premium Plugx(Android/15)";
    }
    if (!server.origin) server.origin = "https://www.hotstar.com";
    if (!server.referrer) server.referrer = "https://www.hotstar.com/";
  }
  if (tokenType === "JIO" && !isHotstar) {
    if (!server.origin) server.origin = "https://www.jiotv.com/";
    if (!server.referrer) server.referrer = "https://www.jiotv.com/";
    if (!server.userAgent) {
      server.userAgent = "plaYtv/7.1.3 (Linux;Android 13) ygx/824.1 ExoPlayerLib/824.0";
    }
  }

  await createPlayer();
  const net = player.getNetworkingEngine();
  net.clearAllRequestFilters();
  net.clearAllResponseFilters();

  // Detect HTTP 403 on manifest → kill this server
  net.registerResponseFilter((type, response) => {
    if (
      type === shaka.net.NetworkingEngine.RequestType.MANIFEST ||
      type === shaka.net.NetworkingEngine.RequestType.SEGMENT
    ) {
      if (response.status === 403 || response.status === 401) {
        markServerDead(serverIndex);
      }
      if (response.uri && /corsproxy\.io/i.test(response.uri)) {
        try {
          const real = unwrapProxyUrl(response.uri);
          if (real) response.uri = real;
        } catch (_) {}
      }
    }
  });

  net.registerRequestFilter((type, request) => {
    request.headers = request.headers || {};
    if (server.userAgent) request.headers["User-Agent"] = server.userAgent;
    if (server.origin) request.headers["Origin"] = server.origin;
    if (server.referrer) request.headers["Referer"] = server.referrer;
    if (server.cookie) request.headers["Cookie"] = server.cookie;
    if (request.method === "HEAD") request.method = "GET";

    request.uris = (request.uris || []).map((uri) => {
      try {
        let actual = unwrapProxyUrl(uri);
        if (actual.includes("?|")) actual = actual.split("?|")[0];
        else if (actual.includes("&|")) actual = actual.split("&|")[0];
        else if (actual.includes("|")) actual = actual.split("|")[0];
        actual = sanitizeUrl(actual.replace(/&+$/, ""));
        const isStream = /hotstar\.com|jio\.com|\.m4s|\.ts|\.mpd|\.m3u8|\.dash|akamai|cloudfront|slivcdn|live\.|aiv-cdn|sunnxt/i.test(actual);
        if (isStream) {
          let finalUrl = sanitizeUrl(stripTokensFromUrl(actual));
          const allowQuery = tokenType === "JIO" || tokenType === "SONYLIV";
          if (
            allowQuery &&
            server.cookie &&
            !finalUrl.includes("hdntl=") &&
            !finalUrl.includes("__hdnea__") &&
            !finalUrl.includes("hdnea=")
          ) {
            finalUrl = appendToken(finalUrl, server.cookie);
          }
          return finalUrl;
        }
        return actual;
      } catch (_) {
        return uri;
      }
    });
  });

  let parsed = parseLicenseField(server.licenseKey);
  if (parsed.licenseUrl && !Object.keys(parsed.clearKeys).length) {
    showLoading("Fetching keys…");
    parsed = await fetchRemoteKeys(parsed.licenseUrl);
  }

  const hasOfflineKeys = Object.keys(parsed.clearKeys).length > 0;
  const drmConfig = {
    clearKeys: hasOfflineKeys ? parsed.clearKeys : {},
    servers: {},
    preferredKeySystems: ["org.w3.clearkey"],
    ignoreDuplicateInitData: true,
    advanced: {
      "org.w3.clearkey": {
        audioRobustness: "",
        videoRobustness: "",
        distinctiveIdentifierRequired: false,
        persistentStateRequired: false,
        sessionType: "temporary",
      },
    },
    retryParameters: { maxAttempts: 3, baseDelay: 500, backoffFactor: 1.5, timeout: 12000 },
  };
  if (parsed.licenseUrl && !hasOfflineKeys) {
    drmConfig.servers["org.w3.clearkey"] = parsed.licenseUrl;
  }

  player.configure({
    drm: drmConfig,
    preferredVideoCodecs: ["avc1", "avc", "h264"],
    preferredAudioCodecs: ["mp4a.40.2", "mp4a", "aac"],
    manifest: {
      dash: {
        ignoreDrmInfo: hasOfflineKeys,
        defaultPresentationDelay: 3,
        ignoreMinBufferTime: true,
        autoCorrectDrift: true,
      },
      hls: { ignoreTextStreamFailures: true, ignoreManifestProgramDateTime: true },
      retryParameters: { maxAttempts: 4, baseDelay: 400, backoffFactor: 1.6, timeout: 15000 },
    },
    streaming: {
      // Keep ~6s of media buffered ahead while playing (smooth, less spin)
      bufferingGoal: 6,
      rebufferingGoal: 2,
      bufferBehind: 30,
      stallEnabled: true,
      stallThreshold: 1,
      stallSkip: 0.1,
      retryParameters: { maxAttempts: 5, baseDelay: 300, backoffFactor: 1.5, timeout: 12000 },
      failureCallback: () => { try { player.retryStreaming(); } catch (_) {} },
    },
    abr: {
      enabled: true,
      defaultBandwidthEstimate: 2500000,
      switchInterval: 4,
      bandwidthUpgradeTarget: 0.85,
      bandwidthDowngradeTarget: 0.95,
    },
  });

  let finalManifest = sanitizeUrl(stripTokensFromUrl(unwrapProxyUrl(server.url)));
  const allowQuery = tokenType === "JIO" || tokenType === "SONYLIV";
  if (
    allowQuery &&
    server.cookie &&
    !finalManifest.includes("hdntl=") &&
    !finalManifest.includes("__hdnea__")
  ) {
    finalManifest = appendToken(finalManifest, server.cookie);
  }

  try {
    console.log("[Gmax Player]", {
      server: server.label || serverIndex + 1,
      keys: Object.keys(parsed.clearKeys).length,
      tokenType,
    });
    await player.load(finalManifest);
    hideLoading();
    reconnectAttempt = 0;
    markServerOk(serverIndex);
    await video.play().catch(() => {});
    refreshTrackMenus();
    updatePlayBtn();
  } catch (err) {
    console.error("Load failed", err);
    markServerDead(serverIndex);
    await tryFallback(err);
  }
}

function refreshTrackMenus() {
  if (!player) return;
  const qList = $("#quality-list");
  const aList = $("#audio-list");
  qList.innerHTML = "";
  aList.innerHTML = "";
  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "menu-item active";
  autoBtn.textContent = "Auto";
  autoBtn.onclick = () => {
    player.configure({ abr: { enabled: true } });
    refreshTrackMenus();
  };
  qList.appendChild(autoBtn);
  const seen = new Set();
  (player.getVariantTracks() || [])
    .filter((t) => t.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .forEach((t) => {
      if (seen.has(t.height)) return;
      seen.add(t.height);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "menu-item" +
        (t.active && !player.getConfiguration().abr.enabled ? " active" : "");
      btn.textContent = t.height + "p";
      btn.onclick = () => {
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(t, true);
        refreshTrackMenus();
      };
      qList.appendChild(btn);
    });
  const langs = new Map();
  (player.getVariantTracks() || []).forEach((t) => {
    const lang = t.language || "und";
    if (!langs.has(lang)) langs.set(lang, t);
  });
  if (!langs.size) aList.innerHTML = '<div class="menu-item">Default</div>';
  else {
    langs.forEach((t, lang) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "menu-item" + (t.active ? " active" : "");
      btn.textContent = lang === "und" ? "Default" : lang.toUpperCase();
      btn.onclick = () => {
        player.selectVariantTrack(t, true);
        refreshTrackMenus();
      };
      aList.appendChild(btn);
    });
  }
}

function buildServerMenu() {
  const menu = $("#server-menu");
  if (!menu || !channel) return;
  menu.innerHTML = "";
  const total = (channel.servers || []).length;
  (channel.servers || []).forEach((s, i) => {
    const status = serverStatus.get(i) || "unknown";
    const dead = status === "dead";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "menu-item" +
      (i === serverIndex ? " active" : "") +
      (dead ? " server-dead" : "");
    btn.disabled = dead;
    const label = s.label || `Server ${i + 1}`;
    btn.textContent =
      label +
      (dead ? "  · offline" : status === "ok" && i === serverIndex ? "  · live" : "");
    btn.title = dead
      ? "This source returned an error (403 / failed)"
      : `Use ${label} (${i + 1}/${total})`;
    if (!dead) {
      btn.onclick = () => {
        menu.classList.add("hidden");
        reconnectAttempt = 0;
        loadServer(i);
      };
    }
    menu.appendChild(btn);
  });
}

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaElementSource(video);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = boost;
  src.connect(gainNode);
  gainNode.connect(audioCtx.destination);
}
function setBoost(v) {
  boost = v;
  $("#boost-val").textContent = v.toFixed(1) + "×";
  if (gainNode) gainNode.gain.value = v;
}
function cycleAspect() {
  aspectMode = (aspectMode + 1) % 3;
  video.classList.remove("aspect-fill", "aspect-stretch");
  if (aspectMode === 1) video.classList.add("aspect-fill");
  if (aspectMode === 2) video.classList.add("aspect-stretch");
  $("#btn-aspect").textContent = ASPECT_LABELS[aspectMode];
}
function showUI() {
  shell.classList.remove("hide-ui");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (!video.paused) shell.classList.add("hide-ui");
  }, CONFIG.UI_HIDE_MS);
}
function updatePlayBtn() {
  $("#btn-play").textContent = video.paused ? "▶" : "❚❚";
  const paused = video.paused;
  $("#paused-info").classList.toggle("hidden", !paused);
  if (paused) showUI();
}

function bindUI() {
  $("#btn-back").onclick = () => {
    if (history.length > 1) history.back();
    else location.href = "./index.html";
  };
  $("#btn-play").onclick = () => (video.paused ? video.play() : video.pause());
  video.addEventListener("play", () => {
    updatePlayBtn();
    showUI();
    if (audioCtx?.state === "suspended") audioCtx.resume();
  });
  video.addEventListener("pause", updatePlayBtn);
  $("#btn-back10").onclick = () => {
    try { video.currentTime = Math.max(0, video.currentTime - 10); } catch (_) {}
  };
  $("#btn-fwd10").onclick = () => {
    try { video.currentTime += 10; } catch (_) {}
  };
  $("#btn-mute").onclick = () => {
    video.muted = !video.muted;
    $("#btn-mute").textContent = video.muted ? "🔇" : "🔊";
  };
  $("#vol-slider").oninput = (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    $("#btn-mute").textContent = video.muted ? "🔇" : "🔊";
  };
  $("#btn-aspect").onclick = cycleAspect;
  $("#btn-pip").onclick = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    } catch (_) {}
  };
  $("#btn-fs").onclick = () => {
    if (!document.fullscreenElement)
      stage.requestFullscreen?.() || shell.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  $("#btn-server").onclick = (e) => {
    e.stopPropagation();
    $("#settings-menu").classList.add("hidden");
    $("#server-menu").classList.toggle("hidden");
  };
  $("#btn-settings").onclick = (e) => {
    e.stopPropagation();
    $("#server-menu").classList.add("hidden");
    $("#settings-menu").classList.toggle("hidden");
    refreshTrackMenus();
  };
  document.addEventListener("click", () => {
    $("#server-menu").classList.add("hidden");
    $("#settings-menu").classList.add("hidden");
  });
  $("#server-menu").onclick = (e) => e.stopPropagation();
  $("#settings-menu").onclick = (e) => e.stopPropagation();
  $("#boost-slider").oninput = (e) => {
    ensureAudioGraph();
    setBoost(Number(e.target.value));
  };
  $("#btn-retry").onclick = () => {
    reconnectAttempt = 0;
    // Retry only alive servers from the start
    const first = [...(channel?.servers || []).keys()].find(
      (i) => serverStatus.get(i) !== "dead"
    );
    loadServer(first ?? 0);
  };
  stage.addEventListener("click", (e) => {
    if (e.target.closest("button, input, .menu")) return;
    if (shell.classList.contains("hide-ui")) showUI();
    else if (!video.paused) video.pause();
    else video.play();
  });
  stage.addEventListener("mousemove", showUI);
  stage.addEventListener("touchstart", showUI, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      video.paused ? video.play() : video.pause();
    } else if (e.key === "ArrowLeft")
      video.currentTime = Math.max(0, video.currentTime - 10);
    else if (e.key === "ArrowRight") video.currentTime += 10;
    else if (e.key === "ArrowUp") {
      video.volume = Math.min(1, video.volume + 0.05);
      $("#vol-slider").value = video.volume;
    } else if (e.key === "ArrowDown") {
      video.volume = Math.max(0, video.volume - 0.05);
      $("#vol-slider").value = video.volume;
    } else if (e.key === "f") $("#btn-fs").click();
    else if (e.key === "m") $("#btn-mute").click();
    else if (e.key === "p") $("#btn-pip").click();
    else if (e.key === "Escape") $("#btn-back").click();
    showUI();
  });
}

async function init() {
  bindUI();
  const id = qs("id");
  if (!id) {
    showError("No channel selected");
    return;
  }
  try {
    showLoading("Loading channel…");
    channel = await resolveChannel(id);
    trackView(channel.id);

    const name = channel.name || "Channel";
    const group = channel.group || "";
    $("#ch-name").textContent = name;
    $("#paused-name").textContent = name;
    const descEl = $("#paused-desc");
    if (descEl) {
      descEl.textContent = group
        ? `${group} · Live TV`
        : "Live channel · Gmax-JioTV";
    }
    document.title = `${name} • Gmax-JioTV`;

    if (channel.logo) {
      $("#ch-logo").src = channel.logo;
      $("#paused-logo").src = channel.logo;
      $("#paused-logo").style.display = "";
    } else {
      $("#ch-logo").style.display = "none";
      $("#paused-logo").style.display = "none";
    }

    if (!channel.servers?.length) {
      showError("No stream servers");
      return;
    }

    // Init status map
    channel.servers.forEach((_, i) => serverStatus.set(i, "unknown"));
    buildServerMenu();

    await loadServer(0);
    showUI();
  } catch (err) {
    console.error(err);
    showError(err.message || "Failed to start player");
  }
}

init();
