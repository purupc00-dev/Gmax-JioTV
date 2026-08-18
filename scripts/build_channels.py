import hashlib
import json
import re
from pathlib import Path

# ... (keep your existing imports and ROOT/OUTPUT paths) ...

# ============================================================
# M3U PARSER - UPDATED LOGIC
# ============================================================

def parse_m3u(path: Path) -> list[dict]:
    channels = []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception as exc:
        print(f"[ERROR] Failed reading {path.name}: {exc}")
        return channels

    current = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # ====================================================
        # EXTINF (Channel Name, Logo, Group)
        # ====================================================
        if line.startswith("#EXTINF:"):
            attrs = parse_attributes(line)
            comma_index = line.rfind(",")
            name = line[comma_index + 1:].strip() if comma_index != -1 else "Unknown"
            if attrs.get("tvg-name"):
                name = attrs["tvg-name"].strip()
            
            current = {
                "id": attrs.get("tvg-id") or "",
                "name": name,
                "logo": attrs.get("tvg-logo") or "",
                "group": attrs.get("group-title") or "Entertainment",
                "category": normalize_category(attrs.get("group-title", ""), name),
                "country": "India",
                "language": "Unknown",
                "stream_url": "",
                "cookie": "",     # <--- ADDED
                "key_id": "",     # <--- ADDED
                "key": "",        # <--- ADDED
                "source_file": path.name,
            }
            continue

        # ====================================================
        # KODIPROP (Extract KeyId and Key)
        # ====================================================
        if current and line.startswith('#KODIPROP:inputstream.adaptive.license_key='):
            license_key = line.replace('#KODIPROP:inputstream.adaptive.license_key=', '').strip()
            if ':' in license_key:
                k_id, k_val = license_key.split(':', 1)
                current["key_id"] = k_id
                current["key"] = k_val
            continue

        # ====================================================
        # EXTHTTP (Extract Cookie)
        # ====================================================
        if current and line.startswith('#EXTHTTP:'):
            import json as json_lib
            try:
                headers_str = line.replace('#EXTHTTP:', '').strip()
                headers = json_lib.loads(headers_str)
                if 'cookie' in headers:
                    current["cookie"] = headers['cookie']
            except:
                pass
            continue

        # ====================================================
        # STREAM URL
        # ====================================================
        if current and not line.startswith("#") and (line.startswith("http://") or line.startswith("https://")):
            current["stream_url"] = line
            if current["stream_url"]:
                if not current["id"]:
                    current["id"] = hashlib.sha1(f"{current['name']}|{current['stream_url']}".encode()).hexdigest()[:12]
                channels.append(current)
            current = None

    return channels
# ... (rest of your script to save JSON)
