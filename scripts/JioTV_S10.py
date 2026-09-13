import os
import re
import urllib.request
import urllib.error

def fetch_and_brand_playlist(url: str, output_file: str):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
    req = urllib.request.Request(url, headers=headers)
    
    print(f"Fetching playlist from {url}...")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            content = response.read().decode('utf-8')
    except Exception as e:
        print(f"Failed to fetch {url}: {e}")
        return

    processed_lines = []

    for line in content.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue

        # 1. Start of a new channel block
        if trimmed.startswith('#EXTINF:'):
            # Brand the channel name with GmaxHub
            trimmed = re.sub(r'tvg-name="([^"]+)"', r'tvg-name="\1 | GmaxHub"', trimmed)
            
            # Brand the display name (the part after the comma)
            if ',' in trimmed:
                prefix, title = trimmed.rsplit(',', 1)
                if not title.strip().endswith('| GmaxHub'):
                    trimmed = f"{prefix},{title.strip()} | GmaxHub"
            
            processed_lines.append(trimmed)

        # 2. Keep all other lines (URLs, EXTHTTP, EXTVLCOPT, KODIPROP) exactly as they are
        else:
            processed_lines.append(trimmed)

    # Write to file
    output_content = '\n'.join(processed_lines) + '\n'
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(output_content)
        
    print(f"Successfully processed and saved playlist to '{output_file}'")

def main():
    # Execute array of all your raw endpoints
    sources = [
        ('https://server.vodep39240327.workers.dev/channel/raw?=m3u', 'Playlists/JioTV_S10.m3u'),
        # Add your other playlists here:
        # ('https://raw.githubusercontent.com/example/TataPlay.m3u', 'Playlists/TataPlay.m3u')
    ]
    
    for url, output in sources:
        try:
            fetch_and_brand_playlist(url, output)
        except urllib.error.HTTPError as e:
            print(f"HTTP Error for {url}: {e.code}")
        except Exception as e:
            print(f"Error for {url}: {e}")

if __name__ == '__main__':
    main()
