import requests
import json
import os
import sys

# ---------- configuration ----------
URL = "https://premiumplugx.com/jtv+/jtv+.php"
OUTPUT_FILE = "Playlists/JioTV_S11.m3u"

def generate_m3u():
    print("=" * 60)
    print("GmaxHub JioTV Server 11 Pipeline")
    print("=" * 60)

    try:
        print(f"[*] Fetching Premium Plugx JSON from {URL}...")
        # Added headers to prevent blocking
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
        response = requests.get(URL, headers=headers, timeout=15)
        response.raise_for_status()
        channels = response.json()
        
        # Ensure Playlists directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write("#EXTM3U\n\n")
            
            for ch in channels:
                # 1. Extract Basic Info
                name = ch.get("name", "Unknown")
                ch_id = ch.get("id", "")
                logo = ch.get("logo", "")
                group = ch.get("group", "Uncategorized")
                ua = ch.get("user_agent", "Premium Plugx")
                mpd_url = ch.get("mpd_url", ch.get("url", ""))
                
                # Apply GmaxHub Branding
                branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name
                
                # 2. Extract Hidden DRM Keys
                kid = ""
                key = ""
                clearkey_obj = ch.get("clearkey", {})
                if clearkey_obj and isinstance(clearkey_obj, dict):
                    for k, v in clearkey_obj.items():
                        kid = k
                        key = v
                        break
                
                # 3. Extract Hidden Cookie
                cookie_str = ""
                headers_obj = ch.get("headers", {})
                if headers_obj:
                    cookie_str = headers_obj.get("cookie", headers_obj.get("Cookie", ""))
                
                # 4. Write in perfect Kodi/Web Tester M3U format
                f.write(f'#EXTINF:-1 tvg-id="{ch_id}" tvg-name="{branded_name}" tvg-logo="{logo}" group-title="{group}",{branded_name}\n')
                f.write('#KODIPROP:inputstream=inputstream.adaptive\n')
                f.write('#KODIPROP:inputstream.adaptive.manifest_type=mpd\n')
                f.write('#KODIPROP:inputstream.adaptive.license_type=clearkey\n')
                
                if kid and key:
                    f.write(f'#KODIPROP:inputstream.adaptive.license_key={kid}:{key}\n')
                
                if cookie_str:
                    # Write for Web Tester (JSON)
                    f.write(f'#EXTHTTP:{{"Cookie": "{cookie_str}"}}\n')
                    # Write for OTT Navigator/Televizo
                    f.write(f'#EXTVLCOPT:http-cookie={cookie_str}\n')
                
                if ua:
                    f.write(f'#EXTVLCOPT:http-user-agent={ua}\n')
                
                # Add default Referer/Origin if it's a JioTV stream for extra stability
                if "jio.com" in mpd_url or "jiotv" in mpd_url:
                    f.write('#EXTVLCOPT:http-referrer=https://www.jiotv.com/\n')
                    f.write('#EXTVLCOPT:http-extra-headers=Origin: https://www.jiotv.com\n')
                
                f.write(f'{mpd_url}\n\n')
                
        print(f"\n[+] Success! {len(channels)} channels written to {OUTPUT_FILE}")
        print("=" * 60)
        
    except Exception as e:
        print(f"\n[-] Error generating playlist: {e}")
        sys.exit(1) # Safe exit to stop GitHub Action from committing an empty file

if __name__ == "__main__":
    generate_m3u()
