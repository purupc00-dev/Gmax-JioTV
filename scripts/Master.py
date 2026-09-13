import os
import json
import re
from datetime import datetime, timezone

# Automatically find the root directory of your repo (one level up from 'Scripts')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)

# Set the correct paths based on your folder structure
PLAYLIST_DIR = os.path.join(REPO_ROOT, 'Playlists')
OUTPUT_FILE = os.path.join(PLAYLIST_DIR, 'Master.json')

def parse_m3u(file_content):
    channels = []
    lines = file_content.splitlines()
    current = None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line.startswith("#EXTINF:"):
            # Extract attributes string and display name
            attr_part = line[8:]
            comma_idx = attr_part.rfind(",")
            
            attrs_str = attr_part[:comma_idx] if comma_idx >= 0 else attr_part
            display_name = attr_part[comma_idx + 1:].strip() if comma_idx >= 0 else ""

            # Extract individual key-value attributes
            attrs = {}
            attr_regex = re.compile(r'([\w-]+)="([^"]*)"')
            for match in attr_regex.finditer(attrs_str):
                attrs[match.group(1)] = match.group(2)

            current = {
                "tvgId": attrs.get("tvg-id", ""),
                "name": attrs.get("tvg-name", display_name or "Unknown").replace(" | GmaxHub", "").replace(" | Gmaxhub", "").strip(),
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
            # Parse Kodi DRM keys
            if line.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                current["licenseKey"] = line.split("=", 1)[1].strip()
            
            # Parse JSON-formatted HTTP headers
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
            
            # Parse VLC-formatted HTTP headers
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
            
            # If it's a URL (doesn't start with #), finalize the channel
            elif not line.startswith("#"):
                current["url"] = line
                if ".m3u8" in line:
                    current["streamType"] = "hls"
                elif ".mpd" in line:
                    current["streamType"] = "mpd"
                
                channels.append(current)
                current = None

    return channels

def main():
    all_channels = []
    
    if not os.path.exists(PLAYLIST_DIR):
        print(f"Error: Directory '{PLAYLIST_DIR}' not found!")
        return
        
    # Process every .m3u file in the directory
    for filename in os.listdir(PLAYLIST_DIR):
        if filename.endswith('.m3u'):
            filepath = os.path.join(PLAYLIST_DIR, filename)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
                parsed = parse_m3u(content)
                all_channels.extend(parsed)
                print(f"Parsed {len(parsed)} channels from {filename}")

    # Create the final JSON structure with live timestamp
    output_data = {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "total_channels": len(all_channels),
        "channels": all_channels
    }

    # Write to Master.json inside the Playlists folder
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"\nSuccessfully wrote {len(all_channels)} total channels to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
