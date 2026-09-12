import urllib.request
import json
import os
import sys

# ---------- configuration ----------
URL = "https://lemajekaat.streamxlive.workers.dev/"
OUTPUT_FILE = "Playlists/JioTV_S12.m3u"
USER_AGENT = "GmaxHub"

def fetch_and_process_playlist():
    print("=" * 60)
    print("GmaxHub JioTV Server 12 Pipeline")
    print("=" * 60)

    try:
        print(f"[*] Fetching JSON data from {URL}...")
        # Add user-agent to avoid worker blocks
        req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        
        with urllib.request.urlopen(req, timeout=20) as response:
            content = response.read().decode('utf-8')

        if not content.strip():
            print("[-] Error: Downloaded data is empty.")
            sys.exit(1)

        # Parse the new JSON format
        try:
            channels = json.loads(content)
        except json.JSONDecodeError as e:
            print(f"[-] Error parsing JSON: {e}")
            sys.exit(1)

        new_playlist = ["#EXTM3U\n"]
        
        for ch in channels:
            # Extract data from the JSON object
            ch_id = ch.get("id", "")
            name = ch.get("name", "Unknown")
            logo = ch.get("logo", "")
            category = ch.get("category", "Uncategorized")
            url = ch.get("url", "")
            key_id = ch.get("keyId", "")
            key = ch.get("key", "")
            cookie = ch.get("cookie", "")

            # Skip if there's no stream URL
            if not url:
                continue

            # Apply GmaxHub Branding
            branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name
            
            # 1. Write the metadata line
            new_playlist.append(f'#EXTINF:-1 tvg-id="{ch_id}" tvg-logo="{logo}" group-title="{category}",{branded_name}')
            
            # 2. Write Kodi/Shaka properties
            new_playlist.append('#KODIPROP:inputstream=inputstream.adaptive')
            new_playlist.append('#KODIPROP:inputstream.adaptive.manifest_type=mpd')
            
            if key_id and key:
                new_playlist.append('#KODIPROP:inputstream.adaptive.license_type=clearkey')
                new_playlist.append(f'#KODIPROP:inputstream.adaptive.license_key={key_id}:{key}')
            
            # 3. Add Custom User Agent
            new_playlist.append(f'#EXTVLCOPT:http-user-agent={USER_AGENT}')
            
            # 4. Inject Cookies & Origin Headers
            if cookie:
                new_playlist.append(f'#EXTVLCOPT:http-cookie={cookie}')
                new_playlist.append(f'#EXTHTTP:{{"Cookie":"{cookie}","Origin":"https://www.jiotv.com/","Referer":"https://www.jiotv.com/"}}')
            else:
                new_playlist.append('#EXTHTTP:{"Origin":"https://www.jiotv.com/","Referer":"https://www.jiotv.com/"}')

            # 5. Append the final stream URL
            new_playlist.append(f'{url}\n')

        # Ensure Playlists directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        
        # Write to file
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write('\n'.join(new_playlist))

        print(f"\n[+] Success! {len(channels)} channels formatted and written to {OUTPUT_FILE}")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Error generating playlist: {e}")
        sys.exit(1) # Fail safely so GitHub Actions knows to abort

if __name__ == "__main__":
    fetch_and_process_playlist()
