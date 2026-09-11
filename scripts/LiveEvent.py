import json
import re
import urllib.request
import datetime
import os

# Configuration
JSON_URL = "https://raw.githubusercontent.com/darkbyteprojects/iptv_png/refs/heads/main/live_events_2.json"
OUTPUT_FILE = "Playlists/LiveEvent.m3u"


def fetch_json(url):
    """Fetch JSON data from the given URL."""
    with urllib.request.urlopen(url) as response:
        return json.loads(response.read().decode())


def build_m3u_header():
    """Build the M3U header with GmaxHub branding and timestamp."""
    now = datetime.datetime.now()
    timestamp = now.strftime("%I:%M %p %m-%d-%Y")  # e.g. 11:02 PM 10-09-2026

    header_lines = [
        "#EXTM3U",
        "#PLAYLIST:GmaxHub Live Events",
        f"#LAST_UPDATE:{timestamp}",
        "#GmaxHub - Live Sports & Events Pipeline",
        "#Created by - GmaxHub"
    ]
    return "\n".join(header_lines) + "\n\n"


def parse_url_params(raw_url):
    """
    Split the raw URL into the clean stream URL and a dict of query params.
    Handles both '|' and '?' separators.
    """
    parts = re.split(r"\|", raw_url, maxsplit=1)
    stream_url = parts[0]
    param_string = parts[1] if len(parts) > 1 else ""

    if "?" in stream_url and not param_string:
        stream_url, param_string = stream_url.split("?", 1)

    params = {}
    if param_string:
        for pair in param_string.split("&"):
            if "=" in pair:
                key, value = pair.split("=", 1)
                params[key.strip()] = value.strip()

    return stream_url, params


def generate_m3u_entry(item):
    """Generate a single M3U entry from a JSON item with GmaxHub branding."""
    name = item.get("name", "Unknown")
    tvg_id = item.get("id", "")
    category = item.get("category", "Live Events")
    logo = item.get("logo", "")

    raw_url = item.get("url", "")
    mpd_url, params = parse_url_params(raw_url)

    key_id = item.get("keyId", "")
    key = item.get("key", "")

    is_dash = ".mpd" in mpd_url
    is_hls = ".m3u8" in mpd_url

    lines = []

    # GmaxHub Branded EXTINF line
    extinf = (
        f'#EXTINF:-1 tvg-id="{tvg_id}" '
        f'tvg-name="{name} | GmaxHub" '
        f'tvg-logo="{logo}" '
        f'group-title="{category}",{name} | GmaxHub'
    )
    lines.append(extinf)

    # DASH ClearKey properties
    if is_dash and key_id and key:
        lines.append("#KODIPROP:inputstream=inputstream.adaptive")
        lines.append("#KODIPROP:inputstream.adaptive.manifest_type=mpd")
        lines.append("#KODIPROP:inputstream.adaptive.license_type=clearkey")
        lines.append(f"#KODIPROP:inputstream.adaptive.license_key={key_id}:{key}")
    elif is_hls:
        lines.append("#KODIPROP:inputstream=inputstream.ffmpeg")
        lines.append("#KODIPROP:inputstream.adaptive.manifest_type=hls")

    # User-Agent
    user_agent = params.get("user-agent") or params.get("User-Agent")
    if user_agent:
        lines.append(f"#EXTVLCOPT:http-user-agent={user_agent}")
    else:
        lines.append("#EXTVLCOPT:http-user-agent=GmaxHub")

    # Referer
    referer = params.get("Referer") or params.get("referer")
    if referer:
        lines.append(f"#EXTVLCOPT:http-referrer={referer}")

    # Origin
    origin = params.get("Origin") or params.get("origin")
    if origin:
        lines.append(f"#EXTVLCOPT:http-origin={origin}")

    # Final URL
    lines.append(mpd_url)

    return "\n".join(lines)


def main():
    try:
        data = fetch_json(JSON_URL)
    except Exception as e:
        print(f"Error fetching JSON: {e}")
        return

    m3u_content = build_m3u_header()

    for item in data:
        entry = generate_m3u_entry(item)
        m3u_content += entry + "\n\n"

    # Ensure output directory exists
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        f.write(m3u_content)

    print(f"Successfully generated {OUTPUT_FILE} with {len(data)} entries.")


if __name__ == "__main__":
    main()
