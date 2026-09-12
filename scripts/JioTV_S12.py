import urllib.request
import os
import sys

# ---------- configuration ----------
URL = "https://lemajekaat.streamxlive.workers.dev/"
OUTPUT_FILE = "Playlists/JioTV_S12.m3u"

def fetch_and_process_playlist():
    print("=" * 60)
    print("GmaxHub JioTV Server 12 Pipeline")
    print("=" * 60)

    try:
        print(f"[*] Fetching playlist from {URL}...")
        # Add user-agent to avoid worker blocks
        req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        
        with urllib.request.urlopen(req, timeout=20) as response:
            content = response.read().decode('utf-8')

        if not content.strip():
            print("[-] Error: Downloaded playlist is empty.")
            sys.exit(1)

        lines = content.splitlines()
        new_playlist = ["#EXTM3U"]
        
        for line in lines:
            line = line.strip()
            if not line or line == "#EXTM3U":
                continue
            
            # Apply GmaxHub Branding to the metadata line
            if line.startswith("#EXTINF"):
                if ',' in line:
                    prefix, name = line.rsplit(',', 1)
                    name = name.strip()
                    branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name
                    line = f"{prefix},{branded_name}"
                new_playlist.append(line)
            
            # Keep stream URLs and allow for future link manipulation
            elif line.startswith("http://") or line.startswith("https://"):
                custom_code_link = f"{line}" 
                new_playlist.append(custom_code_link)
            
            # Keep all other tags (like #KODIPROP, #EXTVLCOPT, #EXTGRP)
            elif line.startswith("#"):
                new_playlist.append(line)

        # Ensure Playlists directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write('\n'.join(new_playlist) + '\n')

        print(f"\n[+] Success! Playlist written to {OUTPUT_FILE}")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Error generating playlist: {e}")
        sys.exit(1) # Fail safely so GitHub Actions knows to abort

if __name__ == "__main__":
    fetch_and_process_playlist()
