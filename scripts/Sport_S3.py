import requests
import re
import os
import sys

# ---------- configuration ----------
SOURCE_URL = "https://raw.githubusercontent.com/Diljan707/Automated-/refs/heads/main/JioTV_Auto.m3u"
OUTPUT_FILE = "Playlists/Sport_S3.m3u"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def parse_m3u_blocks(content):
    """Parses an M3U file into distinct channel blocks so KODIPROP lines aren't lost."""
    header_lines = []
    blocks = []
    current_block = []
    
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#EXTM3U"):
            header_lines.append(stripped)
            continue
            
        if stripped.startswith("#EXTINF"):
            if current_block:
                blocks.append(current_block)
            current_block = [stripped]
        elif current_block:
            current_block.append(stripped)
        else:
            if not stripped.startswith("#EXTM3U"):
                header_lines.append(stripped)

    if current_block:
        blocks.append(current_block)

    return header_lines, blocks

def generate_sport_playlist():
    print("=" * 60)
    print("GmaxHub Sport Server 3 Pipeline")
    print("=" * 60)

    try:
        print(f"[*] Fetching source playlist from {SOURCE_URL}...")
        response = requests.get(SOURCE_URL, headers=HEADERS, timeout=30)
        response.raise_for_status()

        _, blocks = parse_m3u_blocks(response.text)
        
        sports_blocks = []
        
        for block in blocks:
            extinf_line = block[0]
            lower_extinf = extinf_line.lower()
            
            # FILTER: Keep only if the group or name contains sports keywords
            if "sport" in lower_extinf or "cricket" in lower_extinf or "ten " in lower_extinf or "wwe" in lower_extinf:
                
                # Apply GmaxHub Branding to the name
                if ',' in extinf_line:
                    prefix, name = extinf_line.rsplit(',', 1)
                    name = name.strip()
                    branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name
                    block[0] = f"{prefix},{branded_name}"
                    
                sports_blocks.append("\n".join(block))

        # Ensure output directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        
        # Combine back into a single string with double newlines separating channels
        new_playlist = "#EXTM3U\n\n" + "\n\n".join(sports_blocks) + "\n"

        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            f.write(new_playlist)

        print(f"\n[+] Success! Filtered {len(sports_blocks)} sports channels into {OUTPUT_FILE}")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Sync failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    generate_sport_playlist()
