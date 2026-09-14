import os
import json
import re
from datetime import datetime, timezone

# Automatically find the root directory of your repo (one level up from 'scripts')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

# Set the correct paths based on your folder structure
PLAYLIST_DIR = os.path.join(REPO_ROOT, 'Playlists')
OUTPUT_FILE = os.path.join(PLAYLIST_DIR, 'Master.json')

# Any filename containing this (case-insensitive) is treated as the
# primary/top-of-grid playlist and always sorted first.
PRIMARY_MARKER = 's11'

ATTR_REGEX = re.compile(r'([\w-]+)="([^"]*)"')

LANG_PATTERNS = [
    ("Hindi", r"\b(hindi|star plus|colors|zee tv|sony sab|and tv)\b"),
    ("English", r"\b(english|movies now|hbo|axn|star movies|sony pix)\b"),
    ("Tamil", r"\b(tamil|sun tv|zee tamil|star vijay)\b"),
    ("Telugu", r"\b(telugu|gemini|zee telugu|star maa)\b"),
    ("Malayalam", r"\b(malayalam|asianet|surya|zee keralam)\b"),
    ("Kannada", r"\b(kannada|udaya|zee kannada|star suvarna)\b"),
    ("Bengali", r"\b(bengali|zee bangla|star jalsha)\b"),
    ("Marathi", r"\b(marathi|zee marathi|colors marathi|star pravah)\b"),
    ("Punjabi", r"\b(punjabi|ptc|zee punjabi)\b"),
    ("Gujarati", r"\b(gujarati|colors gujarati|zee gujarati)\b"),
]
MULTI_GROUP_RE = re.compile(r"sports|news|movies|kids|music|lifestyle|infotainment", re.IGNORECASE)


def normalize_name(name):
    name = (name or "").lower()
    name = re.sub(r"\s*\|\s*gmaxhub\s*$", "", name, flags=re.IGNORECASE)
    name = re.sub(r"\s+", " ", name).strip()
    return name


def slugify(name):
    n = normalize_name(name)
    n = re.sub(r"[^a-z0-9]+", "-", n).strip("-")
    return n or "channel"


def infer_language(name, group):
    haystack = f"{name} {group}".lower()
    for lang, pattern in LANG_PATTERNS:
        if re.search(pattern, haystack, re.IGNORECASE):
            return lang
    if group and MULTI_GROUP_RE.search(group):
        return "Multi"
    return "Other"


def parse_m3u(file_content):
    channels = []
    lines = file_content.splitlines()
    current = None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line.startswith("#EXTINF:"):
            attr_part = line[8:]
            comma_idx = attr_part.rfind(",")

            attrs_str = attr_part[:comma_idx] if comma_idx >= 0 else attr_part
            display_name = attr_part[comma_idx + 1:].strip() if comma_idx >= 0 else ""

            attrs = dict(ATTR_REGEX.findall(attrs_str))

            # NOTE: use `or` here, not dict.get's default — get() only
            # falls back when the key is entirely missing, not when
            # tvg-name="" is present-but-empty.
            name = attrs.get("tvg-name") or display_name or "Unknown"
            name = re.sub(r"\s*\|\s*GmaxHub\s*$", "", name, flags=re.IGNORECASE).strip()

            current = {
                "tvgId": attrs.get("tvg-id", ""),
                "name": name,
                "logo": attrs.get("tvg-logo", ""),
                "group": attrs.get("group-title", "Other"),
                "licenseKey": None,
                "cookie": None,
                "userAgent": None,
                "referrer": None,
                "origin": None,
                "url": None,
                "streamType": "mpd"
            }
        elif current:
            if line.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                current["licenseKey"] = line.split("=", 1)[1].strip()

            elif line.startswith("#EXTHTTP:"):
                try:
                    json_data = json.loads(line[9:])
                    if "Cookie" in json_data:
                        current["cookie"] = json_data["Cookie"]
                    if "User-Agent" in json_data:
                        current["userAgent"] = json_data["User-Agent"]
                    if "Origin" in json_data:
                        current["origin"] = json_data["Origin"]
                    if "Referer" in json_data:
                        current["referrer"] = json_data["Referer"]
                except json.JSONDecodeError:
                    pass

            elif line.startswith("#EXTVLCOPT:http-cookie="):
                current["cookie"] = line.split("=", 1)[1].strip()
            elif line.startswith("#EXTVLCOPT:http-user-agent="):
                current["userAgent"] = line.split("=", 1)[1].strip()
            elif line.startswith("#EXTVLCOPT:http-referrer="):
                current["referrer"] = line.split("=", 1)[1].strip()
            elif line.startswith("#EXTVLCOPT:http-extra-headers="):
                h = line.split("=", 1)[1].strip()
                if h.lower().startswith("origin:"):
                    current["origin"] = h[7:].strip()

            elif not line.startswith("#"):
                current["url"] = line
                if ".m3u8" in line:
                    current["streamType"] = "hls"
                elif ".mpd" in line:
                    current["streamType"] = "mpd"

                channels.append(current)
                current = None

    return channels


def build_entry(source, ch, is_primary):
    key = normalize_name(ch["name"]) or ch["tvgId"] or slugify(ch["name"])
    local_id = ch["tvgId"] or slugify(ch["name"]) or key
    # Primary (S11) keeps a bare id — EPG matching and any existing
    # player links rely on it being the plain tvg-id. Every other source
    # gets namespaced so two playlists reusing the same tvg-id never
    # collide under the same key client-side.
    channel_id = local_id if is_primary else f"{source}-{local_id}"

    return {
        "id": channel_id,
        "source": source,
        "isPrimary": is_primary,
        "name": ch["name"],
        "logo": ch["logo"],
        "group": ch["group"],
        "language": infer_language(ch["name"], ch["group"]),
        "tvgId": ch["tvgId"] or None,
        "url": ch["url"],
        "streamType": ch["streamType"],
        "licenseKey": ch["licenseKey"],
        "cookie": ch["cookie"],
        "userAgent": ch["userAgent"],
        "referrer": ch["referrer"],
        "origin": ch["origin"],
    }


def main():
    if not os.path.exists(PLAYLIST_DIR):
        print(f"Error: Directory '{PLAYLIST_DIR}' not found!")
        return

    # Deterministic order: any file with "s11" in its name goes first,
    # everything else alphabetically after. os.listdir()'s own order is
    # NOT guaranteed and must never be relied on for "S11 first".
    filenames = [f for f in os.listdir(PLAYLIST_DIR) if f.lower().endswith('.m3u')]
    filenames.sort(key=lambda f: (0 if PRIMARY_MARKER in f.lower() else 1, f.lower()))

    all_channels = []
    per_source_counts = {}

    for filename in filenames:
        source = os.path.splitext(filename)[0]  # e.g. "JioTV_S11" from "JioTV_S11.m3u"
        is_primary = PRIMARY_MARKER in filename.lower()

        filepath = os.path.join(PLAYLIST_DIR, filename)
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        parsed = parse_m3u(content)
        count = 0
        for ch in parsed:
            if not ch["url"]:
                continue
            all_channels.append(build_entry(source, ch, is_primary))
            count += 1

        per_source_counts[source] = count
        print(f"Parsed {count} channels from {filename}{' (PRIMARY)' if is_primary else ''}")

    output_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "total_channels": len(all_channels),
        "sources": per_source_counts,
        "channels": all_channels
    }

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)

    print(f"\nSuccessfully wrote {len(all_channels)} total channels to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
