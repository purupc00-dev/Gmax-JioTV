#!/usr/bin/env python3
"""Refresh every paired playlist updater, then rebuild channels.json once."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELF_NAMES = {"update_json.py", "merge_m3u.py", "update_and_merge.py"}
TIMEOUT_SECONDS = 180


def discover_pairs() -> list[Path]:
    m3u_stems = {path.stem.lower() for path in ROOT.glob("*.m3u")}
    return [
        script
        for script in sorted(ROOT.glob("*.py"), key=lambda p: p.name.lower())
        if script.name.lower() not in {name.lower() for name in SELF_NAMES}
        and script.stem.lower() in m3u_stems
    ]


def run_updater(script: Path) -> bool:
    print(f"[UPDATE] {script.name}")
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as exc:
        print(f"[WARN] {script.name}: {exc}")
        return False

    if result.stdout.strip():
        print(result.stdout.strip())

    if result.returncode != 0:
        if result.stderr.strip():
            print(result.stderr.strip())
        print(f"[WARN] {script.name} failed with exit code {result.returncode}; continuing.")
        return False

    return True


def main() -> None:
    pairs = discover_pairs()
    print(f"[SOURCES] Found {len(pairs)} paired playlist updaters.")

    successes = 0
    for script in pairs:
        if run_updater(script):
            successes += 1

    from merge_m3u import OUTPUT_JSON_PATH, merge_channels, write_channels

    m3u_files, channels = merge_channels()
    write_channels(channels)

    print(
        f"[DONE] {successes}/{len(pairs)} updaters succeeded; "
        f"merged {len(channels)} channels from {len(m3u_files)} M3Us."
    )
    print(f"[DONE] JSON rewritten: {OUTPUT_JSON_PATH}")


if __name__ == "__main__":
    main()
