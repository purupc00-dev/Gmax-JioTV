import json
import re
import requests
import os
import sys
from datetime import datetime, timezone, timedelta

# ---------- configuration ----------
CHANNELS_URL = "https://sportlink18.pages.dev/jtvp.json"
COOKIES_URL  = "https://raw.githubusercontent.com/purupc00-dev/Gmax-JioTV/refs/heads/main/Playlists/JioTV_S10.m3u"
OUTPUT_FILE  = "Playlists/Sport_S2.json"

# Only keep channels whose name matches this pattern (case-insensitive)
NAME_FILTER = re.compile(r"star\s*sports", re.IGNORECASE)

IST = timezone(timedelta(hours=5, minutes=30))

def format_expiry(exp_ts: str) -> str:
    """Convert a unix timestamp string to 'D/M/YYYY H:MM:SS AM/PM IST'."""
    try:
        dt = datetime.fromtimestamp(int(exp_ts), tz=IST)
    except (ValueError, OSError, TypeError):
        return ""
    hour12 = dt.hour % 12
    if hour12 == 0:
        hour12 = 12
    ampm = "AM" if dt.hour < 12 else "PM"
    return f"{dt.day}/{dt.month}/{dt.year} {hour12}:{dt.minute:02d}:{dt.second:02d} {ampm} IST"


def get_cookie_expiry(cookie: str) -> str:
    """Extract exp=<unix_ts> from a __hdnea__ cookie string."""
    if not cookie:
        return ""
    exp_match = re.search(r"exp=(\d+)", cookie)
    return format_expiry(exp_match.group(1)) if exp_match else ""


def main():
    print("=" * 60)
    print("GmaxHub Sport Server 2 (Star Sports JSON Pipeline)")
    print("=" * 60)

    try:
        # 1. Fetch channel details from API
        print(f"\n[*] Fetching channels from {CHANNELS_URL}...")
        channels_resp = requests.get(CHANNELS_URL, timeout=30)
        channels_resp.raise_for_status()
        channels = channels_resp.json()

        # 2. Fetch M3U source for Cookies
        print(f"[*] Fetching cookies from {COOKIES_URL}...")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        m3u_resp = requests.get(COOKIES_URL, headers=headers, timeout=30)
        m3u_resp.raise_for_status()

        m3u_content = m3u_resp.text
        if not m3u_content.strip():
            print("[-] Error: M3U source is completely empty.")
            sys.exit(1)

        # 3. Parse M3U to map tvg-id -> cookie string
        hdnea_map = {}
        current_id = None
        
        for line in m3u_content.splitlines():
            line = line.strip()
            if line.startswith("#EXTINF:"):
                # Extract the tvg-id (e.g., tvg-id="460")
                match = re.search(r'tvg-id="(\d+)"', line)
                if match:
                    current_id = match.group(1)
                else:
                    current_id = None
            elif line.startswith("#EXTHTTP:") and current_id:
                # Extract the cookie string from the JSON-like tag
                cookie_match = re.search(r'"cookie":"([^"]+)"', line)
                if cookie_match:
                    cookie_val = cookie_match.group(1)
                    # If it starts directly with st= instead of __hdnea__=st=, prepend it
                    if cookie_val.startswith("st="):
                        cookie_val = "__hdnea__=" + cookie_val
                    
                    hdnea_map[current_id] = cookie_val
                current_id = None  # Reset after processing to avoid leaks

        # 4. Build combined output (Star Sports only) with GmaxHub branding
        combined = []

        for ch in channels:
            name = ch.get("name", "")
            if not NAME_FILTER.search(name):
                continue  # skip non–Star Sports channels

            cid = str(ch["id"])
            hdnea_token = hdnea_map.get(cid)
            
            if not hdnea_token:
                print(f"  [-] Warning: no cookie found in M3U for channel {cid} ({name})")
                continue

            # Ensure GmaxHub branding is added without duplicating it
            branded_name = f"{name} | GmaxHub" if not name.endswith("| GmaxHub") else name

            combined.append({
                "id": cid,
                "name": branded_name,
                "stream_url": ch["url"],
                "cookie": hdnea_token,
                "cookie_expires": get_cookie_expiry(hdnea_token),
                "key_id": ch["keyId"],
                "key": ch["key"],
                "logo": ch["logo"],
            })

        # 5. Write result
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(combined, f, indent=2, ensure_ascii=False)

        print(f"\n[+] Star Sports JSON written to {OUTPUT_FILE} ({len(combined)} channels)")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Error in Star Sports pipeline: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
