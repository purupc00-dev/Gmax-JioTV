import json
import re
import glob
import os

# Priority list: jtvplus6, jtvplus7, jtvplus8, and any other jtvplus*.m3u files
OUTPUT_JSON_PATH = os.path.join("site", "channels.json")

def parse_m3u_file(file_path):
    channels = []
    if not os.path.exists(file_path):
        return channels

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    blocks = content.split("\n#EXTINF:")
    for block in blocks[1:]:
        lines = block.strip().split("\n")
        if not lines:
            continue

        extinf_line = lines[0]
        channel = {}

        # 1. Extract tvg metadata
        id_match = re.search(r'tvg-id="([^"]*)"', extinf_line)
        name_match = re.search(r'tvg-name="([^"]*)"', extinf_line)
        logo_match = re.search(r'tvg-logo="([^"]*)"', extinf_line)
        group_match = re.search(r'group-title="([^"]*)"', extinf_line)

        channel["id"] = id_match.group(1) if id_match else ""
        channel["name"] = name_match.group(1) if name_match else extinf_line.split(",")[-1].strip()
        channel["logo"] = logo_match.group(1) if logo_match else ""
        channel["group"] = group_match.group(1) if group_match else "Entertainment"

        # 2. Extract Clearkey and Cookies from Kodiprop / EXTHTTP
        for line in lines[1:]:
            line_str = line.strip()
            if line_str.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                key_val = line_str.split("=", 1)[1].strip()
                if ":" in key_val:
                    k_id, k_val = key_val.split(":", 1)
                    channel["key_id"] = k_id.strip()
                    channel["key"] = k_val.strip()

            elif line_str.startswith("#EXTHTTP:"):
                try:
                    http_json = json.loads(line_str[9:])
                    if "cookie" in http_json:
                        channel["cookie"] = http_json["cookie"]
                except Exception:
                    pass

            elif not line_str.startswith("#") and (line_str.startswith("http://") or line_str.startswith("https://")):
                channel["stream_url"] = line_str

        if "stream_url" in channel and channel.get("name"):
            channels.append(channel)

    return channels

def main():
    # Collect files in order: 6, 7, 8, then all others
    priority_files = ["jtvplus6.m3u", "jtvplus7.m3u", "jtvplus8.m3u"]
    all_m3u_files = glob.glob("*.m3u")
    
    # Sort files preserving priority
    ordered_files = [f for f in priority_files if os.path.exists(f)]
    for f in all_m3u_files:
        if f not in ordered_files:
            ordered_files.append(f)

    print(f"Processing M3U playlists: {ordered_files}")

    all_channels = []
    seen_ids = set()

    for m3u in ordered_files:
        parsed = parse_m3u_file(m3u)
        for ch in parsed:
            # Prevent duplicate channels across different server dumps
            identifier = ch.get("id") or ch.get("name")
            if identifier and identifier not in seen_ids:
                seen_ids.add(identifier)
                all_channels.append(ch)

    os.makedirs("site", exist_ok=True)
    with open(OUTPUT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(all_channels, f, indent=2, ensure_ascii=False)

    print(f" Successfully generated {OUTPUT_JSON_PATH} with {len(all_channels)} channels.")

if __name__ == "__main__":
    main()
