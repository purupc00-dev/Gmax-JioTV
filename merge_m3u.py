#!/usr/bin/env python3
"""Merge every root-level M3U into one deduplicated channels.json.

Priority is deterministic:
  1. jtvplus6.m3u
  2. jtvplus7.m3u
  3. jtvplus8.m3u
  4. special/owned playlists (Star*, Sony, Voot, Zee, Sun, Waves, Hotstar)
  5. every remaining M3U alphabetically

For a channel found in more than one playlist, the first source in that order
becomes primary and every other playable source is preserved in ``sources``.
The JSON file is fully rewritten every run, so stale entries are removed.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT_JSON_PATH = ROOT / "site" / "channels.json"

PRIMARY_ORDER = [
    "jtvplus6.m3u",
    "jtvplus7.m3u",
    "jtvplus8.m3u",
]

SPECIAL_ORDER = [
    "Star.m3u",
    "Star2.m3u",
    "Star3.m3u",
    "sony.m3u",
    "voot.m3u",
    "zee.m3u",
    "sun.m3u",
    "waves.m3u",
    "hotstar.m3u",
]

IGNORED_M3U_NAMES: set[str] = set()

ATTR_RE = re.compile(r'([A-Za-z0-9_-]+)="([^"]*)"')


def clean(value: object) -> str:
    return html.unescape(str(value or "")).strip()


def normalize_name(value: object) -> str:
    text = clean(value).lower()
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"[^a-z0-9+& ]+", "", text)
    return text.strip()


def normalize_id(value: object) -> str:
    text = clean(value).lower()
    return re.sub(r"\s+", "", text)


def source_rank(filename: str) -> tuple[int, int | str]:
    lower = filename.lower()
    primary = [x.lower() for x in PRIMARY_ORDER]
    special = [x.lower() for x in SPECIAL_ORDER]

    if lower in primary:
        return (0, primary.index(lower))
    if lower in special:
        return (1, special.index(lower))
    return (2, lower)


def find_m3u_files() -> list[Path]:
    files = [
        path
        for path in ROOT.iterdir()
        if path.is_file()
        and path.suffix.lower() in {".m3u", ".m3u8"}
        and path.name.lower() not in {x.lower() for x in IGNORED_M3U_NAMES}
    ]
    return sorted(files, key=lambda p: source_rank(p.name))


def parse_attributes(line: str) -> tuple[dict[str, str], str]:
    attrs = {key.lower(): clean(value) for key, value in ATTR_RE.findall(line)}
    display_name = clean(line.split(",", 1)[1]) if "," in line else ""
    return attrs, display_name


def parse_m3u_file(file_path: Path) -> list[dict]:
    channels: list[dict] = []

    try:
        lines = file_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError as exc:
        print(f"[WARN] Cannot read {file_path.name}: {exc}")
        return channels

    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line.startswith("#EXTINF:"):
            i += 1
            continue

        attrs, display_name = parse_attributes(line)
        block: list[str] = []
        j = i + 1
        while j < len(lines) and not lines[j].strip().startswith("#EXTINF:"):
            block.append(lines[j].strip())
            j += 1

        channel = {
            "id": attrs.get("tvg-id", ""),
            "name": attrs.get("tvg-name", "") or display_name,
            "logo": attrs.get("tvg-logo", ""),
            "group": attrs.get("group-title", "") or "Entertainment",
        }

        if attrs.get("tvg-language"):
            channel["language"] = attrs["tvg-language"]
        if attrs.get("tvg-country"):
            channel["country"] = attrs["tvg-country"]

        for raw in block:
            if not raw:
                continue

            if raw.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                value = raw.split("=", 1)[1].strip()
                if ":" in value:
                    key_id, key = value.split(":", 1)
                    channel["key_id"] = key_id.strip()
                    channel["key"] = key.strip()

            elif raw.startswith("#EXTHTTP:"):
                payload = raw[len("#EXTHTTP:"):].strip()
                try:
                    data = json.loads(payload)
                except json.JSONDecodeError:
                    data = {}
                if isinstance(data, dict):
                    for field in ("cookie", "referrer", "user-agent"):
                        if data.get(field):
                            channel[{"user-agent": "user_agent"}.get(field, field)] = clean(data[field])

            elif raw.startswith("#EXTVLCOPT:http-referrer="):
                channel["referrer"] = clean(raw.split("=", 1)[1])

            elif raw.startswith("#EXTVLCOPT:http-user-agent="):
                channel["user_agent"] = clean(raw.split("=", 1)[1])

            elif raw.startswith(("http://", "https://")):
                channel["stream_url"] = raw
                break

        if channel.get("stream_url"):
            channel["source_m3u"] = file_path.name
            channels.append(channel)

        i = max(j, i + 1)

    return channels


def merge_channels() -> tuple[list[Path], list[dict]]:
    m3u_files = find_m3u_files()
    grouped: dict[str, dict] = {}

    for m3u_path in m3u_files:
        for channel in parse_m3u_file(m3u_path):
            tvg_id = normalize_id(channel.get("id"))
            name_key = normalize_name(channel.get("name"))

            if not tvg_id and not name_key:
                continue

            match_keys = []
            if tvg_id:
                match_keys.append(f"id:{tvg_id}")
            if name_key:
                match_keys.append(f"name:{name_key}")

            target = None
            for key in match_keys:
                if key in grouped:
                    target = grouped[key]
                    break

            if target is None:
                target = {
                    "channel": dict(channel),
                    "sources": [],
                    "keys": set(),
                }

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

            source_fingerprint = (
                source.get("server", ""),
                source.get("stream_url", ""),
                source.get("key_id", ""),
            )
            existing_fingerprints = {
                (
                    item.get("server", ""),
                    item.get("stream_url", ""),
                    item.get("key_id", ""),
                )
                for item in target["sources"]
            }
            if source_fingerprint not in existing_fingerprints:
                target["sources"].append(source)

            target["keys"].update(match_keys)
            for key in target["keys"]:
                grouped[key] = target

    unique: list[dict] = []
    seen_targets: set[int] = set()

    for target in grouped.values():
        marker = id(target)
        if marker in seen_targets:
            continue
        seen_targets.add(marker)

        sources = sorted(
            target["sources"],
            key=lambda source: source_rank(source.get("m3u", "")),
        )
        if not sources:
            continue

        primary = sources[0]
        channel = dict(target["channel"])

        # Primary source's live credentials become top-level compatibility fields.
        for field in ("stream_url", "cookie", "key_id", "key", "referrer", "user_agent"):
            if primary.get(field):
                channel[field] = primary[field]

        channel["source_m3u"] = primary.get("m3u", "")
        channel["source_count"] = len(sources)
        channel["sources"] = sources
        channel["category"] = channel.get("group") or "Entertainment"

        unique.append(channel)

    unique.sort(key=lambda item: (normalize_name(item.get("name")), normalize_id(item.get("id"))))
    return m3u_files, unique


def write_channels(channels: list[dict]) -> None:
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Compact JSON keeps the generated file substantially smaller while the
    # script still fully rewrites it on every refresh, removing stale entries.
    OUTPUT_JSON_PATH.write_text(
        json.dumps(channels, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def main() -> None:
    m3u_files, channels = merge_channels()
    write_channels(channels)

    print(f"[MERGE] {len(channels)} unique channels from {len(m3u_files)} M3Us")
    print("[M3U] " + ", ".join(path.name for path in m3u_files))
    print(f"[JSON] {OUTPUT_JSON_PATH}")


if __name__ == "__main__":
    main()
