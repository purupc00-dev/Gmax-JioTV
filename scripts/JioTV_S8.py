import os
import re
import urllib.request
import urllib.error

def fetch_and_brand_playlist(url: str, output_file: str):
    headers = {
        'User-Agent': 'OTT Navigator'
    }
    req = urllib.request.Request(url, headers=headers)
    
    print(f"Fetching playlist from {url}...")
    with urllib.request.urlopen(req, timeout=20) as response:
        content = response.read().decode('utf-8')

    # Brand channel display names securely without altering backend stream parameters
    branded_lines = []
    for line in content.splitlines():
        if line.startswith('#EXTINF:'):
            # Brand tvg-name if present
            line = re.sub(r'tvg-name="([^"]+)"', r'tvg-name="\1 | GmaxHub"', line)
            # Brand display title at the end of EXTINF
            if ',' in line:
                prefix, title = line.rsplit(',', 1)
                if not title.strip().endswith('| GmaxHub'):
                    line = f"{prefix},{title.strip()} | GmaxHub"
        branded_lines.append(line)

    output_content = '\n'.join(branded_lines) + '\n'

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(output_content)

    print(f"Successfully saved branded playlist to '{output_file}'")

def main():
    url = 'https://mute-sunset-8225.streamstar18.workers.dev/'
    output = 'Playlists/JioTV_S8.m3u'
    
    try:
        fetch_and_brand_playlist(url, output)
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    main()
