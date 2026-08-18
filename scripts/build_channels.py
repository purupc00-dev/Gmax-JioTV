import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
OUTPUT = SITE_DIR / "channels.json"


# ============================================================
# M3U ATTRIBUTE PARSER
# ============================================================

ATTR_RE = re.compile(
    r'([A-Za-z0-9_-]+)="([^"]*)"'
)


def parse_attributes(line: str) -> dict[str, str]:
    return dict(ATTR_RE.findall(line))


# ============================================================
# STABLE ID
# ============================================================

def make_stable_id(name: str, stream_url: str) -> str:
    value = f"{name}|{stream_url}".encode("utf-8")
    digest = hashlib.sha1(value).hexdigest()[:12]
    return digest


# ============================================================
# M3U PARSER
# ============================================================

def parse_m3u(path: Path) -> list[dict]:

    channels: list[dict] = []

    try:
        text = path.read_text(
            encoding="utf-8",
            errors="ignore"
        )
    except Exception as exc:
        print(f"[WARN] Failed reading {path}: {exc}")
        return channels

    current = None

    for raw_line in text.splitlines():

        line = raw_line.strip()

        if not line:
            continue

        # ----------------------------------------------------
        # EXTINF metadata
        # ----------------------------------------------------

        if line.startswith("#EXTINF:"):

            attrs = parse_attributes(line)

            comma = line.rfind(",")

            if comma >= 0:
                name = line[comma + 1:].strip()
            else:
                name = "Unknown Channel"

            if attrs.get("tvg-name"):
                name = attrs["tvg-name"]

            current = {
                "id": (
                    attrs.get("tvg-id")
                    or ""
                ),

                "name": name,

                "logo": (
                    attrs.get("tvg-logo")
                    or attrs.get("logo")
                    or ""
                ),

                "group": (
                    attrs.get("group-title")
                    or path.stem
                ),

                "category": (
                    attrs.get("category")
                    or attrs.get("group-title")
                    or "Entertainment"
                ),

                "country": (
                    attrs.get("tvg-country")
                    or attrs.get("country")
                    or "India"
                ),

                "language": (
                    attrs.get("tvg-language")
                    or attrs.get("language")
                    or "Unknown"
                ),

                "stream_url": "",

                "source_file": path.name,
            }

            continue

        # ----------------------------------------------------
        # Stream URL
        # ----------------------------------------------------

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

                # Generate stable ID when tvg-id is missing.
                if not current["id"]:

                    current["id"] = make_stable_id(
                        current["name"],
                        current["stream_url"]
                    )

                channels.append(current)

            current = None

    return channels


# ============================================================
# SOURCE FILE SELECTION
# ============================================================

def find_playlists() -> list[Path]:

    files: list[Path] = []

    for path in ROOT.glob("*.m3u"):

        if not path.is_file():
            continue

        files.append(path)

    return sorted(
        files,
        key=lambda p: p.name.lower()
    )


# ============================================================
# BUILD
# ============================================================

def main():

    SITE_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    playlist_files = find_playlists()

    print(
        f"[JioTV] Found "
        f"{len(playlist_files)} playlist files"
    )

    all_channels: list[dict] = []

    # URL-level deduplication.
    seen_urls: set[str] = set()

    for playlist in playlist_files:

        print(
            f"[JioTV] Reading "
            f"{playlist.name}"
        )

        parsed = parse_m3u(playlist)

        print(
            f"         {len(parsed)} channels"
        )

        for channel in parsed:

            url = (
                channel
                .get("stream_url", "")
                .strip()
            )

            if not url:
                continue

            if url in seen_urls:
                continue

            seen_urls.add(url)

            all_channels.append(channel)

    # --------------------------------------------------------
    # Sort
    # --------------------------------------------------------

    all_channels.sort(
        key=lambda channel: (
            str(
                channel.get("category", "")
            ).lower(),

            str(
                channel.get("name", "")
            ).lower()
        )
    )

    # --------------------------------------------------------
    # Write JSON
    # --------------------------------------------------------

    with OUTPUT.open(
        "w",
        encoding="utf-8"
    ) as file:

        json.dump(
            all_channels,
            file,
            ensure_ascii=False,
            indent=2
        )

    print(
        f"[JioTV] Generated "
        f"{len(all_channels)} unique channels"
    )

    print(
        f"[JioTV] Output: {OUTPUT}"
    )


if __name__ == "__main__":
    main()
