import requests
import json
import os

# The Premium Plugx JSON endpoint
URL = "https://premiumplugx.com/jtv+/jtv+.php"
# The output file it will generate in your GitHub repo
OUTPUT_FILE = "plugx.m3u"

def generate_m3u():
    try:
        print("Fetching Premium Plugx JSON...")
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
        channels = response.json()
        
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
                
                # 2. Extract Hidden DRM Keys
                kid = ""
                key = ""
                clearkey_obj = ch.get("clearkey", {})
                if clearkey_obj and isinstance(clearkey_obj, dict):
                    # Grab the first key:value pair inside the clearkey object
                    for k, v in clearkey_obj.items():
                        kid = k
                        key = v
                        break
                
                # 3. Extract Hidden Cookie
                cookie_str = ""
                headers_obj = ch.get("headers", {})
                if headers_obj:
                    cookie_str = headers_obj.get("cookie", headers_obj.get("Cookie", ""))
                
                # 4. Write in perfect Kodi M3U format (matching your jtv.m3u screenshot)
                f.write(f'#EXTINF:-1 tvg-id="{ch_id}" tvg-name="{name}" tvg-logo="{logo}" group-title="{group}",{name}\n')
                f.write('#KODIPROP:inputstream=inputstream.adaptive\n')
                f.write('#KODIPROP:inputstream.adaptive.manifest_type=mpd\n')
                f.write('#KODIPROP:inputstream.adaptive.license_type=clearkey\n')
                
                if kid and key:
                    f.write(f'#KODIPROP:inputstream.adaptive.license_key={kid}:{key}\n')
                
                if cookie_str:
                    f.write(f'#EXTHTTP:{{"cookie": "{cookie_str}"}}\n')
                
                if ua:
                    f.write(f'#EXTVLCOPT:http-user-agent={ua}\n')
                
                f.write(f'{mpd_url}\n\n')
                
        print(f"Success! {len(channels)} channels written to {OUTPUT_FILE}")
        
    except Exception as e:
        print(f"Error generating playlist: {e}")

if __name__ == "__main__":
    generate_m3u()
