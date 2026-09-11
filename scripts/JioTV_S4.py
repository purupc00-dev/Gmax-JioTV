import os
import json
import requests
from typing import Dict, Any
from datetime import datetime
from urllib.parse import urlparse, urlunparse

CHANNELS_URL = "https://raw.githubusercontent.com/qwerty180506/json/refs/heads/main/Geoplus.json"
COOKIE_URL = "https://allinonereborn2.online/jstrweb2/cookies.json"
SPORTS_COOKIE_URL = "https://allinonereborn2.online/jtv-fetch/jstarcookie/cookie.json"

USER_AGENT = "GmaxHub"         

def get_json(url: str) -> Any:
    cache_buster = f"{'&' if '?' in url else '?'}t={int(datetime.now().timestamp() * 1000)}"
    fresh_url = url + cache_buster
    headers = {"Cache-Control": "no-cache", "Pragma": "no-cache"}
    resp = requests.get(fresh_url, headers=headers)
    resp.raise_for_status()
    return resp.json()

def split_url_query(url: str) -> tuple:
    """Return (base_url, query_string). query_string is None if absent."""
    parsed = urlparse(url)
    base = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, "", ""))
    query = parsed.query if parsed.query else None
    return base, query

def get_normal_cookie() -> str:
    data = get_json(COOKIE_URL)
    if isinstance(data, str):
        return data
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and "cookie" in item:
                return item["cookie"]
        return ""
    if isinstance(data, dict):
        return data.get("cookie", "")
    return ""

def get_sports_data() -> Dict[str, Any]:
    data = get_json(SPORTS_COOKIE_URL)
    sports_cookies = {}
    results = data.get("successful_results", []) + data.get("failed_results", [])

    for item in results:
        channel_id = item.get("channel_id")
        if not channel_id:
            continue
        final_url = item.get("final_url") or item.get("error_details", {}).get("final_url", "")
        if not final_url:
            continue
        modified_url = final_url.replace("/output/", "/WDVLive/")
        sports_cookies[str(channel_id)] = modified_url

    return {
        "sportsIds": set(sports_cookies.keys()),
        "sportsCookies": sports_cookies,
    }

def create_channel_entry(channel: Dict[str, Any],
                         normal_cookie: str = "",
                         sports_cookies: Dict[str, str] = {}) -> str:
    name = channel.get("name", "")
    logo = channel.get("logo", "")
    group = channel.get("group") or channel.get("category") or "Other"
    url = channel.get("url", "")
    channel_id = str(channel.get("id", ""))

    lines = []

    # GmaxHub Branding Applied
    lines.append(f'#EXTINF:-1 tvg-id="{channel_id}" tvg-name="{name} | GmaxHub" tvg-logo="{logo}" group-title="{group}",{name} | GmaxHub')

    is_mpd = (channel.get("type") == "dash") or (".mpd" in url.lower() and ("?" in url.lower() or url.lower().endswith(".mpd")))

    if is_mpd:
        lines.append("#KODIPROP:inputstream=inputstream.adaptive")
        lines.append("#KODIPROP:inputstream.adaptive.manifest_type=mpd")

        # Clearkey logic
        if channel.get("keyId") and channel.get("key"):
            lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
            lines.append(f"#KODIPROP:inputstream.adaptive.license_key={channel['keyId']}:{channel['key']}")
        elif "clearkey" in channel and isinstance(channel["clearkey"], dict) and channel["clearkey"]:
            lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
            key_id, key = next(iter(channel["clearkey"].items()))
            lines.append(f"#KODIPROP:inputstream.adaptive.license_key={key_id}:{key}")
        elif channel.get("license_url"):
            lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
            lines.append(f"#KODIPROP:inputstream.adaptive.license_key={channel['license_url']}")
    
    sports_url = sports_cookies.get(channel_id)
    if sports_url:
        final_url_with_query = sports_url
    else:
        if normal_cookie:
            sep = "&" if "?" in url else "?"
            final_url_with_query = f"{url}{sep}{normal_cookie}"
        else:
            final_url_with_query = url
   
    base_url, cookie_query = split_url_query(final_url_with_query)

    if cookie_query:
        lines.append(f'#EXTHTTP:{{"cookie": "{cookie_query}"}}')
   
    lines.append(f"#EXTVLCOPT:http-user-agent={USER_AGENT}")
    lines.append(base_url)

    return "\n".join(lines)

def generate_m3u() -> str:
    channels = get_json(CHANNELS_URL)
    normal_cookie = get_normal_cookie()
    sports_data = get_sports_data()

    print(f"Channels loaded: {len(channels)}")
    print(f"Sports-specific URLs loaded: {len(sports_data['sportsIds'])}")

    entries = []
    for ch in channels:
        entries.append(create_channel_entry(ch, normal_cookie, sports_data["sportsCookies"]))

    print(f"Channels generated: {len(entries)}")
    return "#EXTM3U\n\n" + "\n\n".join(entries)


# ---------- Main ----------
def main(output_file: str = "Playlists/JioTV_S4.m3u"):
    try:
        m3u = generate_m3u()

        # Ensure Playlists directory exists
        os.makedirs(os.path.dirname(output_file), exist_ok=True)

        with open(output_file, "w", encoding="utf-8") as f:
            f.write(m3u)
        print(f"📁 Playlist saved locally as '{output_file}'")
        print("✅ Playlist updated successfully")
    except Exception as e:
        print(f"❌ Error: {e}")
        raise

if __name__ == "__main__":
    main()
