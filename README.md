<div align="center">

# 📺 G M A X - J I O T V
*The Ultimate Live TV & OTT Web Architecture.*

[![version](https://img.shields.io/badge/release-v2.0.0-2ea44f?style=flat-square)](#)
[![hosting](https://img.shields.io/badge/edge-Cloudflare-F38020?style=flat-square&logo=cloudflare&logoColor=white)](#)
[![engine](https://img.shields.io/badge/player-Shaka_v4.11-1a73e8?style=flat-square)](#)
[![drm](https://img.shields.io/badge/drm-ClearKey_%7C_Widevine-e50914?style=flat-square)](#)

[Website](#) • [Discord](#) • [Report Bug](https://github.com/purupc00-dev/Gmax-JioTV/issues) • [Request Feature](https://github.com/purupc00-dev/Gmax-JioTV/issues)

</div>

**Zero footprint, immense streaming capability.** Run enterprise-grade OTT streams and bypass heavy CDN firewalls on consumer browsers. Gmax-JioTV treats raw M3U playlists, ClearKey DRM, and edge-proxy routing as a single, invisible backend hierarchy, delivering a flawless, Netflix-tier user interface.

Built from the ground up with a robust **Python-to-Edge-to-Browser** pipeline, this project supports advanced live stream manipulation — instant playback, anti-drift watchdogs, digital channel HMAC preservation, and dynamic server switching — keeping your architecture entirely hidden from the browser's DevTools.

---

## 🏗️ The 4-Page App Architecture

We discarded standard, clunky IPTV layouts to build a highly optimized, 4-page modular frontend.

1. **The Discovery Hub (`index.html`)**
   * **Single-Frame Cinematic Hero:** A dynamic, swipeable banner powered remotely via `highlights.json` to push live sports or movie premieres.
   * **Smart Channel Grid:** Features a seamless, deduplicated UI. If a channel exists across multiple playlists, it is merged into a single card.
   * **Filter Engine:** Category chips (with 'X' clear toggles), language dropdowns, and a local-storage powered "Recently Watched" slider.
   * **Notification Widget:** A floating bell with a red unread badge, fetching live alerts from `notifications.json`.

2. **The Core Engine (`player.html`)**
   * **Independent Server Switcher:** Seamlessly swap between playlist sources (e.g., S1, S2, S11) via an in-player UI menu. Failed servers are dynamically greyed out.
   * **Smart Paused Overlay:** Darkens the video to display the channel logo, name, and live EPG description in the center of the screen.
   * **Pro UX & Custom Controls:** Picture-in-Picture (PiP), Aspect Ratio toggles (Fit/Fill/Zoom), quality/audio track selectors, and a custom **Voice Boost** (Web Audio API) tool.

3. **The TV Guide (`epg.html`)**
   * A professional, horizontally scrolling XMLTV timeline grid mapping live programs to their respective `tvg-id`s. Includes instant "Click-to-Play" routing.

4. **Your Personal TV (`favorites.html`)**
   * A scoped architecture that visually mirrors the homepage but restricts all rendering, searching, and filtering strictly to the user's saved channels, featuring a master "Clear Favorites" control.

---

## 🐍 Python Pre-Processor & M3U Ecosystem

The backbone of Gmax-JioTV is its automated Python generation ecosystem. 
* **Multi-Source Generation:** Python scripts automatically aggregate and format over 15+ different endpoints (S1 to S13, Sports, BiggBoss, FreeDish, Pocket TV, Digital, etc.).
* **Brand Injection & Token Extraction:** Cleans and brands channel names (`| GmaxHub`), extracts session cookies, and embeds complex Kodi-style properties (`#KODIPROP`).
* **Untouched Payloads:** The Python scripts output 100% clean, raw `.m3u` files. We do not use Base64 or JSON-stringification that would corrupt Akamai HMAC signatures.

---

## ⚡ Hardcore Playback Engineering (Shaka Player)

We heavily customized Shaka Player to squash enterprise CDN errors:

* **Instant Playback (Zero Buffering Delay):** Optimized buffer configurations (`bufferingGoal: 10`, `defaultPresentationDelay: 3`) to eliminate legacy 6-8 second loading screens.
* **Remote Key Pre-Fetch (Error 6001/6012 Fix):** Silently intercepts license URLs, fetches Hex/JWK keys via proxy, and injects them as offline ClearKeys before playback starts.
* **Digital Channel HMAC Preserver:** Specifically engineered to prevent over-decoding of `%2f*` URL entities, fixing the dreaded Akamai **475 Invalid Token** error on digital feeds.
* **Stream Watchdogs:**
  * **Anti-Drift:** Automatically snaps the player to the live edge if the stream lags > 25 seconds.
  * **Anti-Freeze:** Detects stalled frames and silently cache-busts the manifest (`?t_cache=...`) to reload without breaking the player.

---

## 🛡️ Edge Security & Proxy Routing

* **Invisible Edge Gateway:** Powered by Cloudflare Workers and Vercel, acting as a stealth middleman to spoof `Origin`, `Referer`, and `User-Agent` headers.
* **Private Repo Masking:** The Cloudflare Edge worker holds a private GitHub Personal Access Token (PAT). It fetches the raw M3Us securely and streams the text to the player. **Browser DevTools only see the local edge endpoint — your GitHub repo and access keys are 100% invisible.**

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Play / Pause |
| `F` | Toggle Fullscreen |
| `P` | Toggle Picture-in-Picture |
| `I` | Open Settings Menu |
| `← / →` | Seek backward / forward 10s |

---

## ⭐ Star History

<a href="https://star-history.com/#purupc00-dev/Gmax-JioTV&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=purupc00-dev/Gmax-JioTV&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=purupc00-dev/Gmax-JioTV&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=purupc00-dev/Gmax-JioTV&type=Date" />
  </picture>
</a>

---

## ⚠️ Disclaimer
This repository is provided for educational and research purposes only. The developers are not responsible for the content streamed through this application or any misuse of the software. Users must ensure they have the right to access and stream the media provided in their M3U playlists.
