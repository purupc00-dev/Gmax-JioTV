#!/usr/bin/env python3
"""Dynamic channel updater: refresh paired M3Us, then merge into site/channels.json.

Priority primary streams: jtvplus6 → jtvplus7 → jtvplus8 → Star / sony / voot / etc.
Runs in a loop every 12 minutes so keys/cookies stay fresh without bloating JSON
(no history / timestamp append — always overwrite clean merge).
"""

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
INTERVAL_SECONDS = 12 * 60  # 12 minutes (between 10–15)


def main_once():
    # Prefer the canonical updater that discovers pairs + merge_m3u
    update_json = ROOT / "update_json.py"
    if update_json.exists():
        result = subprocess.run(
            [sys.executable, str(update_json)],
            cwd=ROOT,
            text=True,
        )
        if result.returncode != 0:
            print(f"[WARN] update_json.py exited {result.returncode}")
        return

    # Fallback: direct merge only
    from merge_m3u import merge_channels, OUTPUT_JSON_PATH
    import json

    m3u_files, channels = merge_channels()
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON_PATH.write_text(
        json.dumps(channels, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[MERGE] {len(channels)} channels from {len(m3u_files)} M3Us -> {OUTPUT_JSON_PATH}")


def main():
    while True:
        print("\n[+] Starting dynamic channel update & merge...")
        try:
            main_once()
        except Exception as e:
            print(f"[-] Error during update/merge: {e}")
        print(f"[+] Waiting {INTERVAL_SECONDS // 60} minutes before next run...")
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    # One-shot if --once is passed (for CI), otherwise loop
    if "--once" in sys.argv:
        main_once()
    else:
        main()
