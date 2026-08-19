#!/usr/bin/env python3
"""Build site/channels.json from all root M3Us.

Delegates to merge_m3u.merge_channels so primary order is always:
  jtvplus6 → jtvplus7 → jtvplus8 → Star / sony / voot / … → rest

No historical timestamps are appended; each run fully replaces channels.json.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from merge_m3u import merge_channels, OUTPUT_JSON_PATH  # noqa: E402


def main():
    print("=" * 40)
    print("  Gmax-JioTV Channel Builder (multi-M3U)")
    print("=" * 40)

    m3u_files, channels = merge_channels()
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON_PATH.write_text(
        json.dumps(channels, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"[MERGE] {len(channels)} unique channels")
    print("M3U order:", ", ".join(p.name for p in m3u_files))
    print(f"[OUT] {OUTPUT_JSON_PATH}")
    print("=" * 40)


if __name__ == "__main__":
    main()
