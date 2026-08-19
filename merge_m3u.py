import os
import re
import json
import glob

# Priority order: jtvplus6 is always #1, followed by other providers
PRIORITY_ORDER = [
    "jtvplus6.m3u",
    "jtvplus8.m3u",
    "jtvplus7.m3u",
    "jtvplus5.m3u",
    "jtvplus4.m3u",
    "jtvplus3.m3u",
    "jtvplus2.m3u",
    "jtvplus.m3u",
    "jtv6.m3u",
    "jtv5.m3u",
    "jtv4.m3u",
    "jtv3.m3u",
    "jtv2.m3u",
    "jtv.m3u",
    "Star.m3u",
    "Star2.m3u",
    "Star3.m3u",
    "hotstar.m3u",
    "sony.m3u",
    "zee.m3u",
    "voot.m3u",
    "sun.m3u",
    "waves.m3u",
    "sports.m3u",
    "pocket.m3u",
    "mixiptv.m3u",
    "Tnt.m3u"
]

def get_source_priority(filename):
    basename = os.path.basename(filename)
    if basename in PRIORITY_ORDER:
        return PRIORITY_ORDER.index(basename)
    return 999

def normalize_name(name):
    """Normalize channel name for grouping across different providers."""
    if not name:
        return ""
    n = name.upper()
    n = re.sub(r'\[.*?\]|\(.*?\)', '', n)  # Remove brackets
    n = re.sub(r'\b(HD|FHD|SD|4K|1080P|720P|50FPS|HEVC|H265|RAW|JIO|TATA|AIRTEL)\b', '', n)
    n = re.sub(r'[^A-Z0-9]', '', n)
    return n.strip()

def parse_m3u_file(file_path):
    channels = []
    if not os.path.exists(file_path):
        return channels

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    lines = content.splitlines()
    current_meta = {}
    kodiprops = {}
    headers = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line.startswith("#EXTINF:"):
            # Extract tags from #EXTINF
            tvg_id = re.search(r'tvg-id="([^"]*)"', line)
            tvg_name = re.search(r'tvg-name="([^"]*)"', line)
            tvg_logo = re.search(r'tvg-logo="([^"]*)"', line)
            group_title = re.search(r'group-title="([^"]*)"', line)
            
            # Extract display title after the comma
            name_parts = line.split(",", 1)
            display_name = name_parts[1].strip() if len(name_parts) > 1 else ""

            current_meta = {
                "id": tvg_id.group(1) if tvg_id else "",
                "name": tvg_name.group(1) if tvg_name else display_name,
                "display_name": display_name or (tvg_name.group(1) if tvg_name else "Unknown Channel"),
                "logo": tvg_logo.group(1) if tvg_logo else "",
                "group": group_title.group(1) if group_title else "General"
            }

        elif line.startswith("#KODIPROP:"):
            prop_data = line.replace("#KODIPROP:", "").strip()
            if "=" in prop_data:
                k, v = prop_data.split("=", 1)
                kodiprops[k.strip()] = v.strip()

        elif line.startswith("#EXTVLCOPT:") or line.startswith("#EXTHTTP:"):
            if "http-user-agent=" in line:
                headers["User-Agent"] = line.split("http-user-agent=", 1)[1].strip()
            elif "http-referrer=" in line:
                headers["Referer"] = line.split("http-referrer=", 1)[1].strip()
            elif line.startswith("#EXTHTTP:"):
                try:
                    h_json = json.loads(line.replace("#EXTHTTP:", "").strip())
                    headers.update(h_json)
                except Exception:
                    pass

        elif not line.startswith("#") and (line.startswith("http://") or line.startswith("https://")):
            stream_url = line

            # Parse DRM configuration
            drm_type = kodiprops.get("inputstream.adaptive.license_type", "")
            license_key = kodiprops.get("inputstream.adaptive.license_key", "")
            
            clearkey_dict = {}
            if drm_type.lower() == "clearkey" or "clearkey" in license_key:
                if ":" in license_key and not license_key.startswith("http"):
                    parts = license_key.split(":")
                    if len(parts) == 2:
                        clearkey_dict = {parts[0].strip(): parts[1].strip()}
                elif license_key.startswith("{"):
                    try:
                        clearkey_dict = json.loads(license_key)
                    except Exception:
                        pass

            channels.append({
                "info": current_meta,
                "stream": {
                    "provider": os.path.basename(file_path),
                    "priority": get_source_priority(file_path),
                    "url": stream_url,
                    "type": "mpd" if ".mpd" in stream_url else ("hls" if ".m3u8" in stream_url else "auto"),
                    "drm": {
                        "type": drm_type,
                        "license_key": license_key,
                        "clearkey": clearkey_dict
                    },
                    "headers": headers.copy()
                }
            })

            # Reset temporary storage
            current_meta = {}
            kodiprops = {}
            headers = {}

    return channels

def merge_all_m3u():
    m3u_files = glob.glob("*.m3u") + glob.glob("*.m3u8")
    grouped_channels = {}

    for file_path in m3u_files:
        if file_path == "playlist.m3u":
            continue
        parsed_entries = parse_m3u_file(file_path)
        for item in parsed_entries:
            norm_key = normalize_name(item["info"]["name"] or item["info"]["display_name"])
            if not norm_key:
                norm_key = item["info"]["id"] or item["stream"]["url"]

            if norm_key not in grouped_channels:
                grouped_channels[norm_key] = {
                    "id": item["info"]["id"] or norm_key.lower(),
                    "name": item["info"]["display_name"],
                    "logo": item["info"]["logo"],
                    "group": item["info"]["group"],
                    "sources": []
                }

            # Update logo or group if previously missing
            if not grouped_channels[norm_key]["logo"] and item["info"]["logo"]:
                grouped_channels[norm_key]["logo"] = item["info"]["logo"]

            grouped_channels[norm_key]["sources"].append(item["stream"])

    final_channel_list = []
    for key, chan in grouped_channels.items():
        # Sort sources so jtvplus6 and lowest priority index come first
        chan["sources"].sort(key=lambda s: s["priority"])
        final_channel_list.append(chan)

    # Sort channels by Group/Category and Name
    final_channel_list.sort(key=lambda x: (x["group"], x["name"]))

    # Output to site/channels.json
    os.makedirs("site", exist_ok=True)
    with open("site/channels.json", "w", encoding="utf-8") as f:
        json.dump(final_channel_list, f, indent=2, ensure_ascii=False)

    print(f"Successfully processed {len(m3u_files)} files.")
    print(f"Merged into {len(final_channel_list)} unique channels with fallback sources in site/channels.json")

if __name__ == "__main__":
    merge_all_m3u()
