#!/usr/bin/env python3
"""
Gmax-JioTV Channel Builder

This is the full channel builder, not a compatibility wrapper.

What it does:
- Scans every .m3u file in the repository.
- Keeps the existing category normalization behavior.
- Parses stream URLs, ClearKey values, and cookies.
- Merges the same channel across all playlists into one channel entry.
- Preserves every playable source as sources[].
- Applies a predictable source priority:
    1. jtvplus6
    2. jtvplus7
    3. jtvplus8
    4. curated provider playlists such as Star / Sony / Voot / Zee / Sun / etc.
    5. every other M3U in the repository
- Rebuilds site/channels.json from scratch on every run, so old entries never accumulate.
- Keeps stream_url/key_id/key/cookie at the top level for compatibility with older app.js code.
- Writes compact JSON to keep the generated file smaller.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


# ============================================================
# PATHS
# ============================================================

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
OUTPUT = SITE_DIR / "channels.json"


# ============================================================
# FINAL WEBSITE CATEGORIES
# ============================================================

CATEGORIES = [
    "Entertainment",
    "Movies",
    "Sports",
    "News",
    "Kids",
    "Music",
    "Information",
    "Religious",
]


# ============================================================
# SOURCE PRIORITY
# Lower number = earlier fallback attempt.
# ============================================================

SOURCE_PRIORITY = [
    "jtvplus6.m3u",
    "jtvplus7.m3u",
    "jtvplus8.m3u",
]


# Playlist/provider keywords. These are deliberately broad so
# provider files with names such as star.m3u, sony.m3u, voot.m3u
# or zee_channels.m3u are preferred over generic playlists.
PROVIDER_PRIORITY = [
    "star",
    "sony",
    "voot",
    "jio",
    "zee",
    "sun",
    "colors",
    "viacom",
    "discovery",
    "disney",
    "hotstar",
    "wbd",
    "warner",
    "tata",
    "dd",
    "doordarshan",
    "epic",
    "aha",
    "shemaroo",
    "manorama",
    "asianet",
    "news18",
    "times",
    "abp",
    "ndtv",
    "republic",
]


# Directories that must never be scanned for playlists.
IGNORED_DIR_NAMES = {
    ".git",
    ".github",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
}


# ============================================================
# M3U ATTRIBUTE PARSER
# ============================================================

ATTR_RE = re.compile(
    r'([A-Za-z0-9_-]+)="([^"]*)"'
)


def parse_attributes(line: str) -> dict[str, str]:
    """Parse key="value" attributes from an #EXTINF line."""
    return dict(ATTR_RE.findall(line))


# ============================================================
# CLEAN / NORMALIZE HELPERS
# ============================================================

def clean_text(value: str) -> str:
    """Normalize whitespace without changing useful content."""
    return re.sub(r"\s+", " ", (value or "").strip())


def normalize_name_for_match(name: str) -> str:
    """
    Create a conservative channel identity used for merging.

    Quality markers are removed because they are better represented
    as separate sources / quality choices:
      HD, FHD, UHD, 4K, 1080p, 720p, 576p, 480p, SD

    The actual channel name is still preserved for display.
    """
    value = clean_text(name).lower()

    # Remove common quality markers.
    value = re.sub(
        r"\b(?:uhd|fhd|4k|8k|1080p|1080i|720p|576p|540p|480p|360p|240p)\b",
        " ",
        value,
        flags=re.IGNORECASE,
    )
    value = re.sub(
        r"[\[\(\{]\s*(?:hd|fhd|uhd|4k|sd)\s*[\]\)\}]",
        " ",
        value,
        flags=re.IGNORECASE,
    )

    # Normalize separators.
    value = value.replace("_", " ")
    value = value.replace("-", " ")
    value = re.sub(r"[|/]+", " ", value)
    value = re.sub(r"[^a-z0-9\u0900-\u097f ]+", " ", value)

    # Remove standalone quality token if it survived punctuation cleanup.
    value = re.sub(r"\b(?:hd|fhd|uhd|sd)\b", " ", value)

    return clean_text(value)


def make_stable_id(name: str, stream_url: str) -> str:
    """Create a deterministic ID for playlists that have no tvg-id."""
    value = f"{name}|{stream_url}".encode("utf-8")
    return hashlib.sha1(value).hexdigest()[:12]


def make_channel_key(channel: dict) -> str:
    """
    Return the best available cross-playlist identity.

    tvg-id is preferred when present. Otherwise we use the normalized
    display name so channels from different M3Us can share sources.
    """
    tvg_id = clean_text(channel.get("id", "")).lower()
    if tvg_id:
        return f"id:{tvg_id}"

    return f"name:{normalize_name_for_match(channel.get('name', 'Unknown Channel'))}"


# ============================================================
# CATEGORY NORMALIZATION
# ============================================================

def normalize_category(group: str, name: str) -> str:
    text = f"{group} {name}".lower()

    # --------------------------------------------------------
    # SPORTS
    # --------------------------------------------------------

    sports_words = [
        "sport",
        "sports",
        "cricket",
        "football",
        "fifa",
        "tennis",
        "kabaddi",
        "wrestling",
        "racing",
        "motorsport",
        "formula",
        "nba",
        "nfl",
        "mlb",
        "golf",
        "badminton",
        "olympic",
        "olympics",
        "wwe",
        "ufc",
        "boxing",
    ]

    if any(word in text for word in sports_words):
        return "Sports"

    # --------------------------------------------------------
    # NEWS
    # --------------------------------------------------------

    news_words = [
        "news",
        "breaking",
        "headline",
        "current affairs",
        "live news",
        "business news",
    ]

    if any(word in text for word in news_words):
        return "News"

    # --------------------------------------------------------
    # MOVIES
    # --------------------------------------------------------

    movie_words = [
        "movie",
        "movies",
        "cinema",
        "film",
        "films",
        "bollywood",
        "hollywood",
        "kollywood",
        "mollywood",
        "tollywood",
        "picture",
    ]

    if any(word in text for word in movie_words):
        return "Movies"

    # --------------------------------------------------------
    # KIDS
    # --------------------------------------------------------

    kids_words = [
        "kid",
        "kids",
        "cartoon",
        "animation",
        "animated",
        "junior",
        "children",
        "baby",
        "nick",
        "nickelodeon",
        "hungama",
        "pogo",
        "disney junior",
    ]

    if any(word in text for word in kids_words):
        return "Kids"

    # --------------------------------------------------------
    # MUSIC
    # --------------------------------------------------------

    music_words = [
        "music",
        "mtv",
        "radio",
        "songs",
        "song",
        "beats",
        "classic hits",
        "fm ",
        "music hd",
    ]

    if any(word in text for word in music_words):
        return "Music"

    # --------------------------------------------------------
    # RELIGIOUS
    # --------------------------------------------------------

    religious_words = [
        "relig",
        "religious",
        "devotional",
        "spiritual",
        "bhakti",
        "temple",
        "islam",
        "islamic",
        "quran",
        "christian",
        "church",
        "gospel",
        "hindu",
        "sikh",
        "jain",
        "sanatan",
        "divya",
        "aastha",
    ]

    if any(word in text for word in religious_words):
        return "Religious"

    # --------------------------------------------------------
    # INFORMATION
    # --------------------------------------------------------

    information_words = [
        "information",
        "infotainment",
        "documentary",
        "documentaries",
        "education",
        "educational",
        "knowledge",
        "science",
        "technology",
        "tech",
        "history",
        "nature",
        "travel",
        "lifestyle",
        "business",
        "finance",
        "weather",
        "food",
        "cooking",
        "health",
    ]

    if any(word in text for word in information_words):
        return "Information"

    # --------------------------------------------------------
    # DEFAULT
    # --------------------------------------------------------

    return "Entertainment"


# ============================================================
# QUALITY DETECTION
# ============================================================

def detect_quality(name: str, url: str = "", attrs: dict[str, str] | None = None) -> str:
    """
    Best-effort quality label.

    The builder does not fabricate a resolution. It only exposes a
    useful label when the playlist already signals one.
    """
    attrs = attrs or {}
    combined = f"{name} {url} {attrs.get('resolution', '')}".lower()

    quality_patterns = [
        ("8K", r"\b8k\b"),
        ("4K", r"\b4k\b|\b2160p\b|\b2160i\b"),
        ("FHD", r"\bfhd\b|\b1080p\b|\b1080i\b"),
        ("HD", r"\bhd\b|\b720p\b"),
        ("SD", r"\bsd\b|\b576p\b|\b480p\b|\b360p\b|\b240p\b"),
    ]

    for label, pattern in quality_patterns:
        if re.search(pattern, combined, flags=re.IGNORECASE):
            return label

    return ""


# ============================================================
# SOURCE PRIORITY
# ============================================================

def source_priority(path: Path) -> tuple[int, str]:
    """
    Sort playlists according to the required fallback order.
    """
    filename = path.name.lower()

    # Explicit JioTV order.
    for index, preferred in enumerate(SOURCE_PRIORITY):
        if filename == preferred:
            return (index, filename)

    # Provider-owned playlist order after JioTV 8.
    for index, keyword in enumerate(PROVIDER_PRIORITY):
        if keyword in filename:
            return (100 + index, filename)

    # Everything else goes after curated providers.
    return (1000, filename)


def playlist_label(path: Path) -> str:
    """Human-readable source label for the player."""
    return path.stem.replace("_", " ").replace("-", " ").strip()


# ============================================================
# FIND EVERY REPOSITORY M3U
# ============================================================

def find_m3u_files() -> list[Path]:
    """
    Recursively find all M3U playlists under the repository root.

    Old generated files / .git / dependencies are excluded.
    """
    found: list[Path] = []

    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue

        if path.suffix.lower() not in {".m3u", ".m3u8"}:
            continue

        try:
            relative_parts = path.relative_to(ROOT).parts
        except ValueError:
            continue

        if any(part in IGNORED_DIR_NAMES for part in relative_parts):
            continue

        found.append(path)

    found.sort(key=source_priority)

    # Remove duplicates by resolved path.
    unique: list[Path] = []
    seen: set[str] = set()

    for path in found:
        key = str(path.resolve()).lower()

        if key in seen:
            continue

        seen.add(key)
        unique.append(path)

    return unique


# ============================================================
# M3U PARSER
# ============================================================

def parse_m3u(path: Path) -> list[dict]:
    """
    Parse one M3U/M3U8 playlist.

    Supported:
    - #EXTINF
    - tvg-id
    - tvg-name
    - tvg-logo / logo
    - group-title
    - tvg-country / country
    - tvg-language / language
    - #KODIPROP:inputstream.adaptive.license_key=
    - #EXTHTTP: {...}
    - standard http(s) stream URLs
    """
    channels: list[dict] = []

    try:
        text = path.read_text(
            encoding="utf-8",
            errors="ignore",
        )
    except Exception as exc:
        print(
            f"[ERROR] Failed reading {path.name}: {exc}"
        )
        return channels

    current: dict | None = None
    current_attrs: dict[str, str] = {}

    for raw_line in text.splitlines():
        line = raw_line.strip()

        if not line:
            continue

        # ====================================================
        # EXTINF
        # ====================================================

        if line.startswith("#EXTINF:"):
            attrs = parse_attributes(line)
            current_attrs = attrs

            comma_index = line.rfind(",")

            if comma_index != -1:
                name = line[comma_index + 1:].strip()
            else:
                name = "Unknown Channel"

            # Prefer tvg-name when available.
            if attrs.get("tvg-name"):
                name = attrs["tvg-name"].strip()

            name = clean_text(name) or "Unknown Channel"

            group = clean_text(
                attrs.get("group-title")
                or "Entertainment"
            )

            channel_id = clean_text(
                attrs.get("tvg-id")
                or ""
            )

            current = {
                "id": channel_id,
                "name": name,
                "logo": (
                    attrs.get("tvg-logo")
                    or attrs.get("logo")
                    or ""
                ).strip(),
                "group": group,
                "category": normalize_category(
                    group,
                    name,
                ),
                "country": (
                    attrs.get("tvg-country")
                    or attrs.get("country")
                    or "India"
                ).strip(),
                "language": (
                    attrs.get("tvg-language")
                    or attrs.get("language")
                    or "Unknown"
                ).strip(),
                "stream_url": "",
                "key_id": "",
                "key": "",
                "cookie": "",
                "source_file": path.name,
                "source_label": playlist_label(path),
                "quality": detect_quality(
                    name,
                    "",
                    attrs,
                ),
            }

            continue

        # ====================================================
        # KODIPROP license_key (keyId:key)
        # ====================================================

        if (
            current
            and line.startswith(
                "#KODIPROP:inputstream.adaptive.license_key="
            )
        ):
            license_value = line.split(
                "=",
                1,
            )[1].strip()

            if ":" in license_value:
                key_id, key = license_value.split(
                    ":",
                    1,
                )

                current["key_id"] = key_id.strip()
                current["key"] = key.strip()

            continue

        # ====================================================
        # Other common KODIPROP license formats.
        # ====================================================

        if (
            current
            and line.startswith(
                "#KODIPROP:inputstream.adaptive.license_type="
            )
        ):
            # License type is intentionally not promoted to the
            # top-level schema because the existing app only needs
            # the ClearKey ID/key values.
            continue

        # ====================================================
        # EXTHTTP cookie
        # ====================================================

        if (
            current
            and line.startswith("#EXTHTTP:")
        ):
            try:
                payload = line[
                    len("#EXTHTTP:"):
                ].strip()

                http_headers = json.loads(payload)

                cookie = (
                    http_headers.get("cookie")
                    or http_headers.get("Cookie")
                    or ""
                )

                if cookie:
                    current["cookie"] = str(cookie).strip()

            except Exception:
                # A malformed header should never destroy the
                # rest of the playlist.
                pass

            continue

        # ====================================================
        # Optional KODIPROP / HTTP header forms.
        # ====================================================

        if (
            current
            and (
                line.startswith("#EXTVLCOPT:http-referrer=")
                or line.startswith("#EXTVLCOPT:http-user-agent=")
            )
        ):
            # Kept as a no-op for compatibility. The current web
            # player schema does not consume these values.
            continue

        # ====================================================
        # STREAM URL
        # ====================================================

        if (
            current
            and not line.startswith("#")
            and (
                line.startswith("http://")
                or line.startswith("https://")
            )
        ):
            current["stream_url"] = line

            if current["stream_url"]:
                # Create a stable ID if the playlist does not provide one.
                if not current["id"]:
                    current["id"] = make_stable_id(
                        current["name"],
                        current["stream_url"],
                    )

                current["quality"] = detect_quality(
                    current["name"],
                    current["stream_url"],
                    current_attrs,
                )

                channels.append(current)

            current = None
            current_attrs = {}

    return channels


# ============================================================
# SOURCE OBJECT
# ============================================================

def make_source(channel: dict) -> dict:
    """
    Build one source object while keeping the schema compact.

    The app can use source.url directly, while the compatibility
    fields are duplicated only where required for DRM/cookies.
    """
    source: dict = {
        "url": channel.get("stream_url", ""),
        "file": channel.get("source_file", ""),
        "name": channel.get("source_label", ""),
    }

    quality = clean_text(channel.get("quality", ""))
    if quality:
        source["quality"] = quality

    key_id = clean_text(channel.get("key_id", ""))
    key = clean_text(channel.get("key", ""))
    cookie = clean_text(channel.get("cookie", ""))

    if key_id:
        source["key_id"] = key_id

    if key:
        source["key"] = key

    if cookie:
        source["cookie"] = cookie

    return source


# ============================================================
# MERGE HELPERS
# ============================================================

def choose_display_channel(
    current: dict,
    candidate: dict,
) -> dict:
    """
    Fill missing metadata without allowing a lower-priority playlist
    to unexpectedly replace the display metadata from the earlier
    source.
    """
    result = dict(current)

    fields = [
        "id",
        "name",
        "logo",
        "group",
        "category",
        "country",
        "language",
    ]

    for field in fields:
        current_value = clean_text(str(result.get(field, "")))
        candidate_value = clean_text(str(candidate.get(field, "")))

        if not current_value and candidate_value:
            result[field] = candidate_value

    # If the preferred source has an unhelpful logo and the later
    # source has a real one, take the real one.
    current_logo = clean_text(result.get("logo", ""))
    candidate_logo = clean_text(candidate.get("logo", ""))

    if not current_logo and candidate_logo:
        result["logo"] = candidate_logo

    return result


def dedupe_sources(sources: list[dict]) -> list[dict]:
    """
    De-duplicate source URLs while preserving source priority.
    """
    result: list[dict] = []
    seen: set[str] = set()

    for source in sources:
        url = clean_text(source.get("url", ""))

        if not url:
            continue

        if url in seen:
            continue

        seen.add(url)
        result.append(source)

    return result


def merge_playlists(
    playlist_results: list[tuple[Path, list[dict]]],
) -> list[dict]:
    """
    Merge every parsed playlist into one channel list.

    A channel gets exactly one object in channels.json and every
    playable source is stored inside sources[].
    """
    merged: dict[str, dict] = {}

    # This counter is useful for stable display ordering when a
    # channel cannot be matched by tvg-id.
    insertion_order: list[str] = []

    for path, channels in playlist_results:
        print(
            f"[M3U] Merging {path.name}: "
            f"{len(channels)} parsed entries"
        )

        for channel in channels:
            url = clean_text(
                channel.get("stream_url", "")
            )

            if not url:
                continue

            key = make_channel_key(channel)

            if key not in merged:
                first = dict(channel)
                first["sources"] = [
                    make_source(channel)
                ]

                merged[key] = first
                insertion_order.append(key)
                continue

            current = merged[key]

            # Metadata comes from the highest-priority source first.
            merged[key] = choose_display_channel(
                current,
                channel,
            )

            source_list = list(
                current.get("sources", [])
            )

            source_list.append(
                make_source(channel)
            )

            current["sources"] = dedupe_sources(
                source_list
            )

    # Build a compact final structure.
    final_channels: list[dict] = []

    for key in insertion_order:
        channel = merged[key]

        sources = dedupe_sources(
            channel.get("sources", [])
        )

        if not sources:
            continue

        # Keep the first source at the top-level for older player code.
        primary_source = sources[0]

        channel["sources"] = sources
        channel["stream_url"] = primary_source.get(
            "url",
            "",
        )
        channel["key_id"] = primary_source.get(
            "key_id",
            "",
        )
        channel["key"] = primary_source.get(
            "key",
            "",
        )
        channel["cookie"] = primary_source.get(
            "cookie",
            "",
        )
        channel["source_file"] = primary_source.get(
            "file",
            channel.get("source_file", ""),
        )
        channel["source_label"] = primary_source.get(
            "name",
            channel.get("source_label", ""),
        )
        channel["quality"] = primary_source.get(
            "quality",
            channel.get("quality", ""),
        )

        # Remove builder-only / duplicate keys from the final output.
        # Keep the top-level compatibility fields intentionally.
        channel.pop("_merge_key", None)

        final_channels.append(channel)

    return final_channels


# ============================================================
# JSON WRITE
# ============================================================

def write_output(channels: list[dict]) -> None:
    """
    Rebuild channels.json completely.

    Compact separators prevent the file from becoming unnecessarily
    huge over repeated updates.
    """
    SITE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Write through a temporary file so a failed run cannot leave a
    # half-written JSON file.
    temp_output = OUTPUT.with_suffix(
        OUTPUT.suffix + ".tmp"
    )

    with temp_output.open(
        "w",
        encoding="utf-8",
    ) as file:
        json.dump(
            channels,
            file,
            ensure_ascii=False,
            separators=(",", ":"),
        )

        file.write("\n")

    temp_output.replace(OUTPUT)


# ============================================================
# STATISTICS
# ============================================================

def print_statistics(
    channels: list[dict],
    playlist_results: list[tuple[Path, list[dict]]],
) -> None:
    category_counts = {
        category: 0
        for category in CATEGORIES
    }

    multi_source = 0
    total_sources = 0

    for channel in channels:
        category = (
            channel.get("category")
            or "Entertainment"
        )

        if category not in category_counts:
            category = "Entertainment"

        category_counts[category] += 1

        source_count = len(
            channel.get("sources", [])
        )

        total_sources += source_count

        if source_count > 1:
            multi_source += 1

    print(
        "----------------------------------------"
    )
    print(
        f"[BUILD] Playlist files: "
        f"{len(playlist_results)}"
    )
    print(
        f"[BUILD] Final unique channels: "
        f"{len(channels)}"
    )
    print(
        f"[BUILD] Total sources: "
        f"{total_sources}"
    )
    print(
        f"[BUILD] Channels with fallback sources: "
        f"{multi_source}"
    )
    print(
        "[BUILD] Categories:"
    )

    for category in CATEGORIES:
        print(
            f"  {category}: "
            f"{category_counts[category]}"
        )

    print(
        "----------------------------------------"
    )


# ============================================================
# MAIN BUILD
# ============================================================

def main() -> None:
    print(
        "========================================"
    )
    print(
        "       Gmax-JioTV Channel Builder"
    )
    print(
        "       Full Multi-M3U Merge System"
    )
    print(
        "========================================"
    )

    # --------------------------------------------------------
    # Find every M3U in the repository.
    # --------------------------------------------------------

    playlist_files = find_m3u_files()

    if not playlist_files:
        raise FileNotFoundError(
            "No .m3u or .m3u8 playlists were found "
            "inside the repository."
        )

    print(
        f"[BUILD] Found "
        f"{len(playlist_files)} playlist files."
    )

    print(
        "[BUILD] Source order:"
    )

    for index, path in enumerate(
        playlist_files,
        start=1,
    ):
        print(
            f"  {index}. "
            f"{path.relative_to(ROOT)}"
        )

    # --------------------------------------------------------
    # Parse every playlist.
    # --------------------------------------------------------

    playlist_results: list[
        tuple[Path, list[dict]]
    ] = []

    for path in playlist_files:
        parsed = parse_m3u(path)

        playlist_results.append(
            (
                path,
                parsed,
            )
        )

    # --------------------------------------------------------
    # Merge every playlist.
    # --------------------------------------------------------

    final_channels = merge_playlists(
        playlist_results
    )

    # --------------------------------------------------------
    # Ensure IDs are stable and all channels have the expected
    # compatibility fields.
    # --------------------------------------------------------

    for channel in final_channels:
        if not clean_text(
            channel.get("id", "")
        ):
            channel["id"] = make_stable_id(
                channel.get("name", "Unknown Channel"),
                channel.get("stream_url", ""),
            )

        if not clean_text(
            channel.get("category", "")
        ):
            channel["category"] = normalize_category(
                channel.get("group", ""),
                channel.get("name", ""),
            )

        if not clean_text(
            channel.get("country", "")
        ):
            channel["country"] = "India"

        if not clean_text(
            channel.get("language", "")
        ):
            channel["language"] = "Unknown"

        # Make sure sources always exist as a list.
        if not isinstance(
            channel.get("sources"),
            list,
        ):
            channel["sources"] = []

    # --------------------------------------------------------
    # Write JSON from scratch.
    # --------------------------------------------------------

    write_output(
        final_channels
    )

    # --------------------------------------------------------
    # Statistics.
    # --------------------------------------------------------

    print_statistics(
        final_channels,
        playlist_results,
    )

    print(
        f"[BUILD] Output: "
        f"{OUTPUT}"
    )

    print(
        "========================================"
    )
    print(
        "[BUILD] Complete."
    )
    print(
        "========================================"
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()
