import json
import re
import os

# The M3U files to process
M3U_FILES = ['jtvplus6.m3u', 'jtvplus7.m3u', 'jtvplus8.m3u']
OUTPUT_JSON = 'site/channels.json'

def parse_m3u(file_path):
    channels = []
    if not os.path.exists(file_path):
        return channels

    with open(file_path, 'r', encoding='utf-8') as f:
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

all_channels = []
for m3u in M3U_FILES:
    all_channels.extend(parse_m3u(m3u))

# Remove duplicates based on channel name
unique_channels = []
seen = set()
for c in all_channels:
    if c.get('name') not in seen:
        seen.add(c.get('name'))
        unique_channels.append(c)

# Write the final JSON to the site folder
with open(OUTPUT_JSON, 'w', encoding='utf-8') as f:
    json.dump(unique_channels, f, indent=2)

print(f"Success! Updated {OUTPUT_JSON} with {len(unique_channels)} channels.")
