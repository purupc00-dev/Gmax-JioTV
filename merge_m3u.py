#!/usr/bin/env python3
"""Merge every root-level M3U into one dynamic channels.json.

Priority for the primary source is:
  jtvplus6 -> jtvplus7 -> jtvplus8 -> every other M3U (alphabetical)

Each channel gets a `sources` array containing every playable source found
across every M3U, plus the legacy `fallbacks` field for compatibility.
"""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

ROOT = Path(__file__).resolve().parent
OUTPUT_JSON_PATH = ROOT / "site" / "channels.json"

def _normalize_category(group: str, name: str) -> str:
    text = f"{group or ''} {name or ''}".lower()
    if any(w in text for w in ("sport", "cricket", "football", "fifa", "tennis", "kabaddi", "nba", "nfl", "racing", "formula")):
        return "Sports"
    if any(w in text for w in ("news", "headline", "breaking", "current affairs")):
        return "News"
    if any(w in text for w in ("movie", "cinema", "film", "bollywood", "hollywood", "picture")):
        return "Movies"
    if any(w in text for w in ("kid", "cartoon", "animation", "junior", "children", "nick", "hungama")):
        return "Kids"
    if any(w in text for w in ("music", "mtv", "radio", "songs", "fm ")):
        return "Music"
    if any(w in text for w in ("relig", "devotional", "spiritual", "bhakti", "temple", "islam", "quran", "church", "gospel", "hindu", "sikh")):
        return "Religious"
    if any(w in text for w in ("info", "document", "education", "knowledge", "science", "tech", "history", "nature", "travel", "lifestyle", "business", "weather", "health", "food")):
        return "Information"
    return "Entertainment"


# Primary play order: JioTV 6 → 7 → 8, then own-repo / brand sources, then rest.
PRIMARY_ORDER = [
    "jtvplus6.m3u",
    "jtvplus7.m3u",
    "jtvplus8.m3u",
    "Star.m3u",
    "Star2.m3u",
    "Star3.m3u",
    "sony.m3u",
    "voot.m3u",
    "zee.m3u",
    "hotstar.m3u",
    "sun.m3u",
    "sports.m3u",
    "pocket.m3u",
    "mixiptv.m3u",
]
IGNORED_M3U_NAMES = {
    "channels.m3u",
}


def normalize_name(value: str) -> str:
    value = str(value or "").strip().lower()
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"[^a-z0-9+& ]+", "", value)
    return value


def source_rank(filename: str):
    lower = filename.lower()
    if lower in [x.lower() for x in PRIMARY_ORDER]:
        return (0, [x.lower() for x in PRIMARY_ORDER].index(lower))
    return (1, lower)


def find_m3u_files():
    files = []
    for path in ROOT.glob("*.m3u"):
        if path.name.lower() in IGNORED_M3U_NAMES:
            continue
        files.append(path)
    return sorted(files, key=lambda p: source_rank(p.name))


def parse_attributes(extinf_line: str):
    attrs = {}
    for key in ("tvg-id", "tvg-name", "tvg-logo", "group-title", "tvg-language", "tvg-country"):
        match = re.search(rf'{re.escape(key)}="([^"]*)"', extinf_line, re.IGNORECASE)
        attrs[key] = match.group(1).strip() if match else ""
    display_name = extinf_line.split(",", 1)[1].strip() if "," in extinf_line else ""
    return attrs, display_name


def parse_m3u_file(file_path: Path):
    channels = {}
    try:
        content = file_path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return channels

    lines = [line.rstrip("\r") for line in content.splitlines()]
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line.startswith("#EXTINF:"):
            i += 1
            continue

        attrs, display_name = parse_attributes(line)
        block_lines = []
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith("#EXTINF:"):
            block_lines.append(lines[j].strip())
            j += 1

        raw_group = attrs.get("group-title", "") or "Entertainment"
        raw_name = attrs.get("tvg-name", "") or display_name
        raw_name = (
            raw_name.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
        )
        ch = {
            "id": attrs.get("tvg-id", ""),
            "name": raw_name,
            "logo": attrs.get("tvg-logo", ""),
            "group": raw_group,
            "category": _normalize_category(raw_group, raw_name),
        }
        if attrs.get("tvg-language"):
            ch["language"] = attrs["tvg-language"]
        if attrs.get("tvg-country"):
            ch["country"] = attrs["tvg-country"]

        for raw in block_lines:
            if raw.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                key_value = raw.split("=", 1)[1].strip()
                if ":" in key_value:
                    key_id, key = key_value.split(":", 1)
                    ch["key_id"] = key_id.strip()
                    ch["key"] = key.strip()
            elif raw.startswith("#EXTHTTP:"):
                payload = raw[len("#EXTHTTP:"):].strip()
                try:
                    data = json.loads(payload)
                    if isinstance(data, dict):
                        if data.get("cookie"):
                            ch["cookie"] = str(data["cookie"]).strip()
                        if data.get("referrer"):
                            ch["referrer"] = str(data["referrer"]).strip()
                        if data.get("user-agent"):
                            ch["user_agent"] = str(data["user-agent"]).strip()
                except Exception:
                    pass
            elif raw.startswith("#EXTVLCOPT:http-referrer="):
                ch["referrer"] = raw.split("=", 1)[1].strip()
            elif raw.startswith("#EXTVLCOPT:http-user-agent="):
                ch["user_agent"] = raw.split("=", 1)[1].strip()
            elif raw and not raw.startswith("#") and raw.startswith(("http://", "https://")):
                ch["stream_url"] = raw
                break

        if ch.get("stream_url"):
            identifier = str(ch.get("id") or normalize_name(ch.get("name"))).strip()
            if identifier:
                ch["source_m3u"] = file_path.name
                # Preserve original playlist position (lower = higher in list)
                ch["_pos"] = len(channels)
                channels[identifier] = ch

        i = max(j, i + 1)

    return channels


def merge_channels():
    m3u_files = find_m3u_files()
    grouped = {}

    for m3u_path in m3u_files:
        parsed = parse_m3u_file(m3u_path)
        for source_key, channel in parsed.items():
            channel_id = str(channel.get("id") or "").strip()
            name_key = normalize_name(channel.get("name"))
            # Prefer stable tvg-id, but allow name matching when a source has no id.
            keys = []
            if channel_id:
                keys.append(f"id:{channel_id.lower()}")
            if name_key:
                keys.append(f"name:{name_key}")
            if not keys:
                continue

            target = None
            for key in keys:
                if key in grouped:
                    target = grouped[key]
                    break
            if target is None:
                target = {"channel": dict(channel), "sources": []}

            source = {
                "server": m3u_path.stem,
                "m3u": m3u_path.name,
                "stream_url": channel.get("stream_url", ""),
                "cookie": channel.get("cookie"),
                "key_id": channel.get("key_id"),
                "key": channel.get("key"),
                "referrer": channel.get("referrer"),
                "user_agent": channel.get("user_agent"),
            }
            source = {k: v for k, v in source.items() if v not in (None, "")}

            fingerprint = (source.get("server"), source.get("stream_url"))
            if fingerprint not in {(x.get("server"), x.get("stream_url")) for x in target["sources"]}:
                target["sources"].append(source)

            # Register every matching key to the same target object.
            for key in keys:
                grouped[key] = target

    unique = []
    seen_objects = set()
    for target in grouped.values():
        marker = id(target)
        if marker in seen_objects:
            continue
        seen_objects.add(marker)

        channel = target["channel"]
        sources = sorted(target["sources"], key=lambda s: source_rank(s.get("m3u", "")))
        if not sources:
            continue

        primary = sources[0]
        # Prefer metadata from the highest-priority source, then keep source data as fallbacks.
        for field in ("stream_url", "cookie", "key_id", "key", "referrer", "user_agent"):
            if primary.get(field):
                channel[field] = primary[field]
        channel["source_m3u"] = primary.get("m3u", "")
        channel["sources"] = sources
        channel["fallbacks"] = sources[1:]
        channel["source_count"] = len(sources)
        # Keep original position from highest-priority M3U (jtvplus6 first)
        channel["sort_order"] = channel.pop("_pos", 10_000_000)
        # Also try position from primary source metadata
        for s in sources:
            if s.get("m3u", "").lower() == "jtvplus6.m3u":
                channel["sort_order"] = min(channel.get("sort_order", 10_000_000), channel.get("sort_order", 0))
                break
        unique.append(channel)

    # jtvplus6 primary first (by original playlist order), then other primaries, then name
    def sort_key(c):
        m = str(c.get("source_m3u") or "").lower()
        if "jtvplus6" in m:
            tier = 0
        elif "jtvplus7" in m:
            tier = 1
        elif "jtvplus8" in m:
            tier = 2
        elif "jtv" in m:
            tier = 3
        else:
            tier = 4
        return (tier, int(c.get("sort_order") or 10_000_000), normalize_name(c.get("name")))

    unique.sort(key=sort_key)
    return m3u_files, unique


def main():
    m3u_files, channels = merge_channels()
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON_PATH.write_text(
        json.dumps(channels, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Merged {len(channels)} unique channels from {len(m3u_files)} M3U files.")
    print("M3U order:", ", ".join(path.name for path in m3u_files))
    print(f"Wrote: {OUTPUT_JSON_PATH}")


if __name__ == "__main__":
    main()
