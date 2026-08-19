import json
import re
import os
import glob
import time

OUTPUT_JSON = 'site/channels.json'

def parse_m3u(file_path):
    channels = []
    if not os.path.exists(file_path):
        return channels

    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()

    blocks = content.split('\n#EXTINF:')
    for block in blocks[1:]:
        lines = block.strip().split('\n')
        if not lines: continue

        extinf_line = lines[0]
        channel = {}

        # Extract attributes using regex
        id_match = re.search(r'tvg-id="([^"]+)"', extinf_line)
        name_match = re.search(r'tvg-name="([^"]+)"', extinf_line)
        logo_match = re.search(r'tvg-logo="([^"]+)"', extinf_line)
        group_match = re.search(r'group-title="([^"]+)"', extinf_line)

        channel['id'] = id_match.group(1) if id_match else ""
        channel['name'] = name_match.group(1) if name_match else extinf_line.split(',')[-1].strip()
        channel['logo'] = logo_match.group(1) if logo_match else ""
        channel['group'] = group_match.group(1) if group_match else ""

        for line in lines[1:]:
            if line.startswith('#KODIPROP:inputstream.adaptive.license_key='):
                key_str = line.split('=', 1)[1].strip()
                if ':' in key_str:
                    channel['key_id'], channel['key'] = key_str.split(':', 1)
                    channel['key_id'] = channel['key_id'].strip()
                    channel['key'] = channel['key'].strip()
            elif line.startswith('#EXTHTTP:'):
                try:
                    http_json = json.loads(line[9:])
                    if 'cookie' in http_json:
                        channel['cookie'] = http_json['cookie']
                except:
                    pass
            elif not line.startswith('#') and line.strip().startswith('http'):
                channel['stream_url'] = line.strip()

        if 'stream_url' in channel:
            channels.append(channel)

    return channels

def build_merged_json():
    # Grab all m3u files dynamically
    all_m3u_files = glob.glob('*.m3u') + glob.glob('*.m3u8')
    
    # Priority order: 6 is primary, then 7, 8, then specific repos
    priority = ['jtvplus6.m3u', 'jtvplus7.m3u', 'jtvplus8.m3u', 'star.m3u', 'sony.m3u', 'voot.m3u', 'zee.m3u']
    
    sorted_files = [f for f in priority if f in all_m3u_files]
    sorted_files += [f for f in all_m3u_files if f not in priority and f != 'playlist.m3u']

    merged_channels = {}

    for m3u in sorted_files:
        parsed = parse_m3u(m3u)
        for c in parsed:
            identifier = c.get('id') or c.get('name')
            if not identifier:
                continue

            if identifier not in merged_channels:
                c['fallbacks'] = []
                merged_channels[identifier] = c
            else:
                base = merged_channels[identifier]
                if base.get('stream_url') != c.get('stream_url'):
                    fallback = {
                        "server": m3u,
                        "stream_url": c.get('stream_url'),
                        "cookie": c.get('cookie'),
                        "key_id": c.get('key_id'),
                        "key": c.get('key')
                    }
                    if fallback not in base['fallbacks']:
                        base['fallbacks'].append(fallback)

    unique_channels = list(merged_channels.values())

    os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
    with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(unique_channels, f, indent=2)

    print(f"Success! Updated {OUTPUT_JSON} with {len(unique_channels)} channels from {len(sorted_files)} M3U files.")

def main():
    while True:
        print("\n[+] Starting dynamic channel update & merge...")
        try:
            build_merged_json()
        except Exception as e:
            print(f"[-] Error during merge: {e}")
            
        print("[+] Update complete. Waiting 10 minutes before next extraction...")
        # 10 minutes loop to keep tokens fresh
        time.sleep(10 * 60)

if __name__ == "__main__":
    main()
