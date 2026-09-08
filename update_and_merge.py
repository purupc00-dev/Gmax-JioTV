#!/usr/bin/env python3
import os
import sys
import json
import time
import subprocess
import re
from pathlib import Path

# Directories and Files
ROOT_DIR = Path(__file__).resolve().parent
SITE_DIR = ROOT_DIR / "site"
OUTPUT_JSON = SITE_DIR / "channels.json"

# Do not run these files when updating playlists
BLACKLIST_SCRIPTS = {
    "update_and_merge.py",
    "update_json.py",
    "merge_m3u.py",
    "cookie.py" # Skip if it's just a helper module
}

def run_all_updaters():
    """Finds all .py files in the root folder and runs them to generate fresh .m3u files."""
    print("\n[+] Step 1: Running all Python playlist generators...")
    py_files = [f for f in ROOT_DIR.glob("*.py") if f.name not in BLACKLIST_SCRIPTS and f.is_file()]
    
    for py_script in py_files:
        print(f"  -> Running {py_script.name}...")
        try:
            # 60 second timeout so a broken script doesn't hang the whole GitHub Action
            subprocess.run([sys.executable, str(py_script)], cwd=ROOT_DIR, timeout=60, check=False)
        except subprocess.TimeoutExpired:
            print(f"  [!] {py_script.name} timed out after 60 seconds.")
        except Exception as e:
            print(f"  [!] Error running {py_script.name}: {e}")

def parse_m3u(file_path):
    """Parses an M3U file and extracts channels, DRM keys, and headers."""
    channels = []
    current_channel = {}
    
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                
                if line.startswith("#EXTINF:"):
                    current_channel = {}
                    
                    # Extract tags using regex
                    id_match = re.search(r'tvg-id="([^"]+)"', line)
                    name_match = re.search(r'tvg-name="([^"]+)"', line)
                    logo_match = re.search(r'tvg-logo="([^"]+)"', line)
                    group_match = re.search(r'group-title="([^"]+)"', line)
                    
                    if id_match: current_channel["id"] = id_match.group(1)
                    if logo_match: current_channel["logo"] = logo_match.group(1)
                    if group_match: current_channel["group"] = group_match.group(1)
                    
                    if name_match: 
                        current_channel["name"] = name_match.group(1)
                    elif "," in line:
                        current_channel["name"] = line.split(",", 1)[-1].strip()
                        
                elif line.startswith("#KODIPROP:inputstream.adaptive.license_key="):
                    key_str = line.split("=", 1)[-1]
                    if ":" in key_str:
                        kid, key = key_str.split(":", 1)
                        current_channel["key_id"] = kid.strip()
                        current_channel["key"] = key.strip()
                        
                elif line.startswith("#EXTHTTP:"):
                    try:
                        json_str = line[9:]
                        http_props = json.loads(json_str)
                        if "cookie" in http_props:
                            current_channel["cookie"] = http_props["cookie"]
                    except:
                        pass
                        
                elif not line.startswith("#"):
                    current_channel["stream_url"] = line
                    current_channel["source_m3u"] = file_path.name
                    channels.append(current_channel)
                    current_channel = {}
                    
    except Exception as e:
        print(f"  [!] Failed to parse {file_path.name}: {e}")
        
    return channels

def merge_and_save():
    """Finds all .m3u files, parses them, merges duplicates, and outputs channels.json"""
    print("\n[+] Step 2: Finding and Merging all M3U files...")
    m3u_files = list(ROOT_DIR.glob("*.m3u"))
    
    channel_map = {}
    total_parsed = 0
    
    for m3u in m3u_files:
        print(f"  -> Parsing {m3u.name}...")
        parsed_channels = parse_m3u(m3u)
        total_parsed += len(parsed_channels)
        
        for ch in parsed_channels:
            # Use tvg-id if available, otherwise strip non-alphanumeric chars from the name as a fallback ID
            ch_name = ch.get("name", "Unknown")
            ch_id = ch.get("id") or re.sub(r'[^a-z0-9]', '', ch_name.lower())
            
            if not ch_id:
                continue
                
            source_data = {
                "stream_url": ch.get("stream_url", ""),
                "cookie": ch.get("cookie", ""),
                "key_id": ch.get("key_id", ""),
                "key": ch.get("key", ""),
                "m3u": ch.get("source_m3u", "")
            }
            
            if ch_id in channel_map:
                # Add to sources array if it's a new link
                existing = channel_map[ch_id]
                existing_urls = [s.get("stream_url") for s in existing.get("sources", [])]
                
                if source_data["stream_url"] not in existing_urls:
                    if "sources" not in existing:
                        existing["sources"] = []
                    existing["sources"].append(source_data)
            else:
                # First time seeing this channel
                ch["sources"] = [source_data]
                channel_map[ch_id] = ch

    # Convert map back to list
    final_channels = list(channel_map.values())
    
    # Save to site/channels.json
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(final_channels, f, indent=2, ensure_ascii=False)
        
    print(f"\n[+] Success! Parsed {total_parsed} raw channels from {len(m3u_files)} playlists.")
    print(f"[+] Merged down to {len(final_channels)} unique channels.")
    print(f"[+] Saved output to {OUTPUT_JSON}")

if __name__ == "__main__":
    run_all_updaters()
    merge_and_save()
