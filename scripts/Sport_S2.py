import json
import re
import requests
import os
from datetime import datetime, timezone, timedelta

# ---------- configuration ----------
CHANNELS_URL = "https://sportlink18.pages.dev/jtvp.json"
COOKIES_URL  = "https://raw.githubusercontent.com/qwerty180506/json/refs/heads/main/sportsbiscuit.json"
OUTPUT_FILE  = "Playlists/star.json"

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


def extract_hdnea(final_url: str) -> str | None:
    """Return the full __hdnea__ query string (including prefix) from a URL."""
    match = re.search(r"(__hdnea__=[^&]+)", final_url)
    return match.group(1) if match else None


def main():
    print("=" * 60)
    print("GmaxHub Star Sports JSON Pipeline")
    print("=" * 60)

    try:
        # Fetch data
        print(f"\n[*] Fetching channels from {CHANNELS_URL}...")
        channels_resp = requests.get(CHANNELS_URL, timeout=30)
        channels_resp.raise_for_status()
        channels = channels_resp.json()

        print(f"[*] Fetching cookies from {COOKIES_URL}...")
        cookies_resp = requests.get(COOKIES_URL, timeout=30)
        cookies_resp.raise_for_status()
        cookie_data = cookies_resp.json()

        # Build a lookup: channel_id -> final_url
        failed_map = {
            str(item["channel_id"]): item["error_details"]["final_url"]
            for item in cookie_data.get("failed_results", [])
        }

        # Build combined output (Star Sports only) with GmaxHub branding
        combined = []

        for ch in channels:
            name = ch.get("name", "")
            if not NAME_FILTER.search(name):
                continue  # skip non–Star Sports channels

            cid = str(ch["id"])
            final_url = failed_map.get(cid)
            if not final_url:
                print(f"  [-] Warning: no cookie URL for channel {cid} ({name})")
                continue

            hdnea_full = extract_hdnea(final_url)
            if not hdnea_full:
                print(f"  [-] Warning: no __hdnea__ token found for channel {cid}")
                continue

            combined.append({
                "id": cid,
                "name": f"{name} | GmaxHub",
                "stream_url": ch["url"],
                "cookie": hdnea_full,
                "cookie_expires": get_cookie_expiry(hdnea_full),
                "key_id": ch["keyId"],
                "key": ch["key"],
                "logo": ch["logo"],
            })

        # Ensure output directory exists
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)

        # Write result
        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(combined, f, indent=2, ensure_ascii=False)

        print(f"\n[+] Star Sports JSON written to {OUTPUT_FILE} ({len(combined)} channels)")
        print("=" * 60)

    except Exception as e:
        print(f"\n[-] Error in Star Sports pipeline: {e}")
        raise

if __name__ == "__main__":
    main()
