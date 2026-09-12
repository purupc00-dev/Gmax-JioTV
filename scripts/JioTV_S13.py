import requests
import re
import os
import sys

# ---------- configuration ----------
OUTPUT_FILE = "Playlists/JioTV_S13.m3u"

def generate_playlist():
    print("=" * 60)
    print("GmaxHub JioTV Server 13 (JJTVxWeb Pipeline)")
    print("=" * 60)

    # 1. Star Sports dynamic cookies ID-wise
    COOKIE_STAR_SPORTS = "https://allinonereborn2.online/jtv-fetch/jstarcookie/cookie.json"
    star_tokens = {}
    try:
        print("[*] Fetching Star Sports dynamic cookies...")
        res = requests.get(COOKIE_STAR_SPORTS, timeout=8)
        if res.status_code == 200:
            data = res.json()
            if data and "failed_results" in data:
                for item in data["failed_results"]:
                    ch_id_str = str(item.get("channel_id"))
                    err_details = item.get("error_details", {})
                    final_url = err_details.get("final_url", "")
                    if "__hdnea__=" in final_url:
                        match = re.search(r'__hdnea__=([^&]+)', final_url)
                        if match:
                            star_tokens[ch_id_str] = f"__hdnea__={match.group(1)}"
    except Exception as e:
        print(f"[-] Notice: Star Sports fetch skipped: {e}")

    # 2. Global / Primary cookies fetch (Fallback)
    token_urls = [
        "https://allinonereborn2.online/jstrweb2/cookies.json",
        "https://allinonereborn2.online/jstrweb3/cookies.json",
        "https://allinonereborn2.online/jstrweb4/cookies.json"
    ]

    global_token = ""
    print("[*] Fetching global fallback cookies...")
    for url in token_urls:
        try:
            res = requests.get(url, timeout=5)
            if res.status_code == 200:
                cookie_res = res.json()
                for item in cookie_res:
                    if isinstance(item, dict) and "cookie" in item:
                        global_token = item["cookie"]
                        break
                if global_token:
                    print(f"  [+] Global token found via {url}")
                    break
        except Exception:
            continue

    # 3. Base Proxy URL extraction
    base_proxy_url = "https://streamflexsmm.in/license/"
    try:
        print("[*] Extracting dynamic proxy base URL...")
        target_m3u_url = "https://raw.githubusercontent.com/Sflex0719/STBPLUS/main/ZioMobile.m3u"
        res = requests.get(target_m3u_url, timeout=5)
        if res.status_code == 200:
            for line in res.text.splitlines():
                if 'license_key=' in line:
                    l_key = line.split('license_key=')[1].strip()
                    if l_key and l_key != "null:null":
                        match = re.search(r'(https?://[^\s]+?/)(?:\d+/)?$', l_key)
                        if match:
                            base_proxy_url = match.group(1)
                        else:
                            base_proxy_url = re.sub(r'\d+/?$', '', l_key)
                        break
    except Exception as e:
        print(f"[-] Notice: Proxy extraction skipped/failed: {e}")

    # 4. Main channels JSON fetch & M3U creation
    try:
        print("[*] Fetching main channels JSON...")
        channels_res = requests.get("https://jjtvxweb.pages.dev/jstr4web.json", timeout=10)
        channels_res.raise_for_status()
        channels = channels_res.json()
        
        m3u = '#EXTM3U\n'
        count = 0
        
        for ch in channels:
            name = ch.get('name', 'Unknown')
            url = ch.get('url', '')
            logo = ch.get('logo', '')
            category = ch.get('category', 'Unknown')
            group = f"JioTV+ ▶ | {category}"
            group_logo = "https://i.postimg.cc/52qG6sKt/STREAMXi.png"
            ch_id = str(ch.get('id', ''))
            
            if not url:
                continue
                
            # Apply GmaxHub Branding
            branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name
                
            key_id = ch.get('keyId', '')
            key_val = ch.get('key', '')
            has_clearkey = key_id and key_val and key_id != "null" and key_val != "null"
            
            # Priority: 1. Star Sports ID-specific token, 2. Global token
            ch_token = star_tokens.get(ch_id) or global_token
            final_url = f"{url}?{ch_token}" if ch_token and '?' not in url else f"{url}&{ch_token}" if ch_token else url
            
            m3u += f'#EXTINF:-1 tvg-id="{ch_id}" group-title="{group}" group-logo="{group_logo}" tvg-logo="{logo}",{branded_name}\n'
            
            if has_clearkey:
                license_key = f"{key_id}:{key_val}"
                m3u += f'#KODIPROP:inputstream.adaptive.license_type=clearkey\n'
                m3u += f'#KODIPROP:inputstream.adaptive.license_key={license_key}\n'
            else:
                custom_license_proxy = f"{base_proxy_url}{ch_id}/"
                m3u += f'#KODIPROP:inputstream.adaptive.license_type=clearkey\n'
                m3u += f'#KODIPROP:inputstream.adaptive.license_key={custom_license_proxy}\n'
                
            m3u += f'#EXTVLCOPT:http-user-agent=plaYtv/7.1.5\n'
            m3u += f'#EXTVLCOPT:http-referrer=https://www.jiotv.com/\n'
            m3u += f'#EXTVLCOPT:http-extra-headers=Origin: https://www.jiotv.com\n'
            
            if ch_token:
                m3u += f'#EXTVLCOPT:http-cookie={ch_token}\n'
                m3u += f'#EXTHTTP:{{"Cookie":"{ch_token}","Origin":"https://www.jiotv.com/","Referer":"https://www.jiotv.com/"}}\n'
            else:
                m3u += f'#EXTHTTP:{{"Origin":"https://www.jiotv.com/","Referer":"https://www.jiotv.com/"}}\n'
                
            m3u += f'{final_url}\n\n'
            count += 1

        # Ensure output directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        
        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            f.write(m3u)
            
        print(f"\n[+] Success! Generated {count} channels in {OUTPUT_FILE}.")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Fatal Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    generate_playlist()
