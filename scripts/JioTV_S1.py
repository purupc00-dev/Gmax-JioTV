import os
import re
import json
import time
import sys
import requests
from typing import Dict, Any
from datetime import datetime
from urllib.parse import urlparse, urlunparse

CHANNELS_URL = "https://raw.githubusercontent.com/qwerty180506/json/refs/heads/main/Geoplus.json"
COOKIE_URL = "https://raw.githubusercontent.com/purupc00-dev/Gmax-JioTV/refs/heads/main/Playlists/JioTV_S10.m3u"
SPORTS_COOKIE_URL = "https://raw.githubusercontent.com/qwerty180506/json/refs/heads/main/sportsbiscuit.json"

M3U_FILE = "Playlists/JioTV_S1.m3u"
JSON_FILE = "Playlists/JioTV_S1.json"

USER_AGENT = "plaYtv/7.1.3 (Linux;Android 13) ygx/824.1 ExoPlayerLib/824.0"
MAX_RETRIES = 4
RETRY_DELAY = 5


# ---------------- RETRY FETCHER ----------------
def get_json(url: str) -> Any:
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            fresh_url = f"{url}{'&' if '?' in url else '?'}t={int(time.time() * 1000)}"
            resp = requests.get(
                fresh_url,
                headers={"Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": "Mozilla/5.0"},
                timeout=20,
            )
            resp.raise_for_status()
            data = resp.json()
            if data is None or data == [] or data == {}:
                raise Exception("Empty response")
            print(f"[OK] Fetched {url} (attempt {attempt})")
            return data
        except Exception as e:
            last_error = e
            print(f"[WARN] Attempt {attempt}/{MAX_RETRIES} failed for {url}: {e}", file=sys.stderr)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)

    raise Exception(f"Failed to fetch {url} after {MAX_RETRIES} attempts: {last_error}")


# ---------------- M3U COOKIE EXTRACTOR ----------------
def get_normal_cookie() -> str:
    """Fetches the JioTV_S10.m3u file and uses regex to extract the __hdnea__ cookie."""
    try:
        fresh_url = f"{COOKIE_URL}?t={int(time.time())}"
        resp = requests.get(
            fresh_url,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache", "User-Agent": "Mozilla/5.0"},
            timeout=20
        )
        resp.raise_for_status()
        text = resp.text
        
        # Regex surgically targets: __hdnea__=st=...~exp=...~acl=/*~hmac=...
        match = re.search(r'(__hdnea__=st=\d+~exp=\d+~acl=[^~"]+~hmac=[a-f0-9]+)', text)
        
        if match:
            cookie = match.group(1)
            print("[OK] Successfully extracted __hdnea__ cookie from JioTV_S10.m3u")
            return cookie
        else:
            print("[WARN] Could not find a valid __hdnea__ cookie in JioTV_S10.m3u")
            
    except Exception as e:
        print(f"[WARN] Cookie fetch from S10 M3U failed: {e}")
        
    return ""


# ---------------- SPORTS DATA ----------------
def get_sports_data() -> Dict[str, Any]:
    try:
        data = get_json(SPORTS_COOKIE_URL)
    except Exception as e:
        print(f"[WARN] Sports fetch failed: {e}")
        return {"sportsIds": set(), "sportsCookies": {}}

    sports_cookies = {}
    results = (data.get("successful_results") or []) + (data.get("failed_results") or [])

    for item in results:
        if not isinstance(item, dict):
            continue
        channel_id = item.get("channel_id")
        if not channel_id:
            continue
        final_url = (
            item.get("final_url")
            or (item.get("error_details") or {}).get("final_url")
            or ""
        )
        if not final_url:
            continue
        final_url = re.sub(r"/output/", "/WDVLive/", final_url, count=1, flags=re.I)
        sports_cookies[str(channel_id)] = final_url

    print(f"[INFO] Sports URLs loaded: {len(sports_cookies)}")
    return {"sportsIds": set(sports_cookies.keys()), "sportsCookies": sports_cookies}


# ---------------- HELPERS ----------------
def extract_keys(channel):
    key_id = channel.get("keyId") or ""
    key = channel.get("key") or ""
    if not key_id and isinstance(channel.get("clearkey"), dict) and channel.get("clearkey"):
        try:
            key_id, key = next(iter(channel["clearkey"].items()))
        except StopIteration:
            pass
    return key_id, key


def resolve_url(channel, sports_cookies):
    channel_id = str(channel.get("id") or "")
    raw_url = channel.get("url") or ""

    if channel_id in sports_cookies:
        return sports_cookies[channel_id]

    parsed = urlparse(raw_url)
    clean_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, "", ""))
    return clean_url


# ---------------- M3U ENTRY ----------------
def create_channel_entry(channel, normal_cookie="", sports_cookies=None):
    if sports_cookies is None:
        sports_cookies = {}

    channel_id = str(channel.get("id") or "")
    name       = channel.get("name") or ""
    logo       = channel.get("logo") or ""
    group      = channel.get("group") or channel.get("category") or "Other"
    raw_url    = channel.get("url") or ""

    key_id, key = extract_keys(channel)
    final_url   = resolve_url(channel, sports_cookies)

    lines = []

    # GmaxHub Branded EXTINF
    lines.append(
        f'#EXTINF:-1 tvg-id="{channel_id}" tvg-name="{name} | GmaxHub" '
        f'tvg-logo="{logo}" group-title="{group}",{name} | GmaxHub'
    )

    is_mpd = (
        channel.get("type") == "dash"
        or bool(re.search(r"\.mpd(?:\?|$)", final_url, re.I))
        or bool(re.search(r"\.mpd(?:\?|$)", raw_url, re.I))
    )

    if is_mpd:
        lines.append("#KODIPROP:inputstream=inputstream.adaptive")
        lines.append("#KODIPROP:inputstream.adaptive.manifest_type=mpd")
        if key_id and key:
            lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
            lines.append(f"#KODIPROP:inputstream.adaptive.license_key={key_id}:{key}")
        elif channel.get("license_url"):
            lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
            lines.append(f'#KODIPROP:inputstream.adaptive.license_key={channel["license_url"]}')

    lines.append(f"#EXTVLCOPT:http-user-agent={USER_AGENT}")

    # Apply the extracted S10 cookie universally (to normal AND sports channels)
    if normal_cookie:
        cookie_json = json.dumps({
            "cookie": normal_cookie,
            "Origin": "https://www.jiotv.com/",
            "Referer": "https://www.jiotv.com/"
        })
        lines.append(f"#EXTVLCOPT:http-cookie={normal_cookie}")
        lines.append(f"#EXTHTTP:{cookie_json}")
    else:
        # Fallback if no cookie was found
        cookie_json = json.dumps({
            "Origin": "https://www.jiotv.com/",
            "Referer": "https://www.jiotv.com/"
        })
        lines.append(f"#EXTHTTP:{cookie_json}")

    lines.append(final_url)

    return "\n".join(lines)


# ---------------- JSON ENTRY ----------------
def build_channel_object(channel, normal_cookie="", sports_cookies=None):
    if sports_cookies is None:
        sports_cookies = {}

    key_id, key = extract_keys(channel)

    return {
        "id":     str(channel.get("id") or ""),
        "name":   f"{channel.get('name') or ''} | GmaxHub",
        "url":    resolve_url(channel, sports_cookies),
        "cookie": normal_cookie, # Applied to all channels
        "keyId":  key_id,
        "key":    key,
        "logo":   channel.get("logo") or "",
        "group":  channel.get("group") or channel.get("category") or "Other",
    }


# ---------------- VALIDATE ----------------
def validate(channels, m3u_entries, json_entries):
    errors = []
    if not channels:
        errors.append("Channels list is empty")
    if not m3u_entries:
        errors.append("M3U output is empty")
    if not json_entries:
        errors.append("JSON output is empty")
    if len(m3u_entries) != len(json_entries):
        errors.append(f"Count mismatch: {len(m3u_entries)} M3U vs {len(json_entries)} JSON")
    if len(m3u_entries) < len(channels) * 0.8:
        errors.append(f"Too many channels dropped: expected ~{len(channels)}, got {len(m3u_entries)}")

    if errors:
        for e in errors:
            print(f"[ERROR] {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[OK] Validation passed: {len(m3u_entries)} channels")


# ---------------- MAIN ----------------
def main():
    print(f"[START] {datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}")

    channels = get_json(CHANNELS_URL)
    if isinstance(channels, dict):
        channels = channels.get("channels") or channels.get("data") or []
    print(f"[INFO] Channels loaded: {len(channels)}")

    normal_cookie = get_normal_cookie()
    print(f"[INFO] Cookie: {'found' if normal_cookie else 'not found'}")

    sports_data = get_sports_data()

    m3u_entries  = []
    json_entries = []

    for ch in channels:
        try:
            m3u_entries.append(create_channel_entry(ch, normal_cookie, sports_data["sportsCookies"]))
            json_entries.append(build_channel_object(ch, normal_cookie, sports_data["sportsCookies"]))
        except Exception as e:
            print(f"[WARN] Skipped channel '{ch.get('name', '?')}': {e}", file=sys.stderr)

    validate(channels, m3u_entries, json_entries)

    timestamp   = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    m3u_content = f'#EXTM3U x-tvg-url="" updated="{timestamp}"\n\n' + "\n\n".join(m3u_entries)
    json_content = json.dumps(json_entries, indent=2, ensure_ascii=False)

    os.makedirs(os.path.dirname(M3U_FILE), exist_ok=True)

    with open(M3U_FILE, "w", encoding="utf-8") as f:
        f.write(m3u_content)
    print(f"[INFO] M3U saved → {M3U_FILE}")

    with open(JSON_FILE, "w", encoding="utf-8") as f:
        f.write(json_content)
    print(f"[INFO] JSON saved → {JSON_FILE}")

    print("[DONE] All outputs written successfully.")

if __name__ == "__main__":
    main()
