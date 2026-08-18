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

# IMPORTANT:
# We intentionally use ONLY this curated playlist.
PRIMARY_PLAYLIST = ROOT / "jtvplus6.m3u"


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
# M3U ATTRIBUTE PARSER
# ============================================================

ATTR_RE = re.compile(
    r'([A-Za-z0-9_-]+)="([^"]*)"'
)


def parse_attributes(line: str) -> dict[str, str]:
    return dict(
        ATTR_RE.findall(line)
    )


# ============================================================
# STABLE CHANNEL ID
# ============================================================

def make_stable_id(
    name: str,
    stream_url: str,
) -> str:

    value = (
        f"{name}|{stream_url}"
        .encode("utf-8")
    )

    return (
        hashlib.sha1(value)
        .hexdigest()[:12]
    )


# ============================================================
# CATEGORY NORMALIZATION
# ============================================================

def normalize_category(
    group: str,
    name: str,
) -> str:

    text = (
        f"{group} {name}"
        .lower()
    )

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
    ]

    if any(
        word in text
        for word in sports_words
    ):
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

    if any(
        word in text
        for word in news_words
    ):
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

    if any(
        word in text
        for word in movie_words
    ):
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
    ]

    if any(
        word in text
        for word in kids_words
    ):
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
    ]

    if any(
        word in text
        for word in music_words
    ):
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
    ]

    if any(
        word in text
        for word in religious_words
    ):
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

    if any(
        word in text
        for word in information_words
    ):
        return "Information"


    # --------------------------------------------------------
    # DEFAULT
    # --------------------------------------------------------
    #
    # Anything that doesn't clearly belong to another
    # category goes to Entertainment so we never create
    # dozens of extra categories.
    # --------------------------------------------------------

    return "Entertainment"


# ============================================================
# M3U PARSER
# ============================================================

def parse_m3u(
    path: Path,
) -> list[dict]:

    channels: list[dict] = []

    try:

        text = path.read_text(
            encoding="utf-8",
            errors="ignore",
        )

    except Exception as exc:

        print(
            f"[ERROR] Failed reading "
            f"{path.name}: {exc}"
        )

        return channels


    current = None


    for raw_line in text.splitlines():

        line = raw_line.strip()


        if not line:
            continue


        # ====================================================
        # EXTINF
        # ====================================================

        if line.startswith(
            "#EXTINF:"
        ):

            attrs = parse_attributes(
                line
            )


            comma_index = line.rfind(
                ","
            )


            if comma_index != -1:

                name = (
                    line[
                        comma_index + 1:
                    ]
                    .strip()
                )

            else:

                name = (
                    "Unknown Channel"
                )


            # Prefer tvg-name when available.
            if attrs.get(
                "tvg-name"
            ):

                name = (
                    attrs["tvg-name"]
                    .strip()
                )


            group = (
                attrs.get(
                    "group-title"
                )
                or "Entertainment"
            )


            current = {

                "id": (
                    attrs.get(
                        "tvg-id"
                    )
                    or ""
                ),

                "name": name,

                "logo": (
                    attrs.get(
                        "tvg-logo"
                    )
                    or attrs.get(
                        "logo"
                    )
                    or ""
                ),

                "group": group,

                "category": normalize_category(
                    group,
                    name,
                ),

                "country": (
                    attrs.get(
                        "tvg-country"
                    )
                    or attrs.get(
                        "country"
                    )
                    or "India"
                ),

                "language": (
                    attrs.get(
                        "tvg-language"
                    )
                    or attrs.get(
                        "language"
                    )
                    or "Unknown"
                ),

                "stream_url": "",

                "source_file": path.name,
            }


            continue


        # ====================================================
        # STREAM URL
        # ====================================================

        if (
            current
            and not line.startswith("#")
            and (
                line.startswith(
                    "http://"
                )
                or line.startswith(
                    "https://"
                )
            )
        ):

            current["stream_url"] = (
                line
            )


            if current[
                "stream_url"
            ]:

                # Create a stable ID if
                # the playlist doesn't provide one.
                if not current["id"]:

                    current["id"] = (
                        make_stable_id(
                            current["name"],
                            current[
                                "stream_url"
                            ],
                        )
                    )


                channels.append(
                    current
                )


            current = None


    return channels


# ============================================================
# MAIN BUILD
# ============================================================

def main():

    print(
        "========================================"
    )

    print(
        "       Gmax-JioTV Channel Builder"
    )

    print(
        "========================================"
    )


    # --------------------------------------------------------
    # Check primary playlist
    # --------------------------------------------------------

    if not PRIMARY_PLAYLIST.exists():

        raise FileNotFoundError(
            "jtvplus6.m3u was not found "
            "in the repository root."
        )


    print(
        f"[JioTV] Using: "
        f"{PRIMARY_PLAYLIST.name}"
    )


    # --------------------------------------------------------
    # Parse playlist
    # --------------------------------------------------------

    channels = parse_m3u(
        PRIMARY_PLAYLIST
    )


    print(
        f"[JioTV] Parsed "
        f"{len(channels)} channels"
    )


    # --------------------------------------------------------
    # Deduplicate
    #
    # We preserve the FIRST occurrence.
    # This means the original playlist
    # ordering remains intact.
    # --------------------------------------------------------

    final_channels: list[dict] = []

    seen_urls: set[str] = set()


    for channel in channels:

        url = (
            channel
            .get(
                "stream_url",
                ""
            )
            .strip()
        )


        if not url:
            continue


        if url in seen_urls:
            continue


        seen_urls.add(
            url
        )


        final_channels.append(
            channel
        )


    # --------------------------------------------------------
    # Ensure output directory
    # --------------------------------------------------------

    SITE_DIR.mkdir(
        parents=True,
        exist_ok=True
    )


    # --------------------------------------------------------
    # Write JSON
    #
    # IMPORTANT:
    # No alphabetical sorting here.
    # We preserve jtvplus6.m3u order.
    # --------------------------------------------------------

    with OUTPUT.open(
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            final_channels,
            file,
            ensure_ascii=False,
            indent=2,
        )


    # --------------------------------------------------------
    # Statistics
    # --------------------------------------------------------

    category_counts = {
        category: 0
        for category in CATEGORIES
    }


    for channel in final_channels:

        category = (
            channel.get(
                "category"
            )
            or "Entertainment"
        )


        if category not in (
            category_counts
        ):

            category = (
                "Entertainment"
            )


        category_counts[
            category
        ] += 1


    print(
        "----------------------------------------"
    )

    print(
        f"[JioTV] Final channels: "
        f"{len(final_channels)}"
    )

    print(
        "[JioTV] Categories:"
    )


    for category in CATEGORIES:

        print(
            f"  {category}: "
            f"{category_counts[category]}"
        )


    print(
        "----------------------------------------"
    )

    print(
        f"[JioTV] Output: "
        f"{OUTPUT}"
    )

    print(
        "========================================"
    )


if __name__ == "__main__":

    main()
