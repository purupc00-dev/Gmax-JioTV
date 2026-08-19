#!/usr/bin/env python3
"""Refresh paired source M3Us, then rebuild site/channels.json.

A source updater is executed only when a Python file and an M3U with the same
stem exist in the repository, e.g. sony.py -> sony.m3u. Utility scripts are
not executed unless they have a matching M3U. Failed source updaters are
reported but do not prevent a merge of the successfully refreshed playlists.
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SELF_NAMES = {"update_json.py", "merge_m3u.py"}
TIMEOUT_SECONDS = 180


def discover_pairs():
    pairs = []
    m3u_names = {path.stem.lower() for path in ROOT.glob("*.m3u")}
    for script in sorted(ROOT.glob("*.py"), key=lambda p: p.name.lower()):
        if script.name.lower() in {name.lower() for name in SELF_NAMES}:
            continue
        if script.stem.lower() in m3u_names:
            pairs.append(script)
    return pairs


def run_updater(script: Path):
    print(f"[UPDATE] {script.name}")
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
        )
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.returncode != 0:
            if result.stderr.strip():
                print(result.stderr.strip())
            print(f"[WARN] {script.name} failed with exit code {result.returncode}; continuing.")
            return False
        return True
    except Exception as exc:
        print(f"[WARN] {script.name} failed: {exc}; continuing.")
        return False


def main():
    pairs = discover_pairs()
    print(f"Found {len(pairs)} paired source updaters.")
    for script in pairs:
        run_updater(script)

    # Import after source updaters have completed so the merger sees fresh M3Us.
    from merge_m3u import merge_channels, OUTPUT_JSON_PATH
    m3u_files, channels = merge_channels()
    OUTPUT_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    import json
    OUTPUT_JSON_PATH.write_text(
        json.dumps(channels, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"[MERGE] {len(channels)} channels from {len(m3u_files)} M3Us -> {OUTPUT_JSON_PATH}")


if __name__ == "__main__":
    main()
