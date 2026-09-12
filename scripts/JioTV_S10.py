import os
import re
import urllib.request
import urllib.error
import urllib.parse

def wrap_link(url: str) -> str:
    """Wrap stream URL through a CORS proxy or Next.js API route to bypass browser blocks."""
    if not url or url.startswith('#'):
        return url
    
    # Option A: If using a local Next.js API route proxy in Gmax-JioTV
    # return f"/api/proxy?url={urllib.parse.quote(url, safe='')}"
    
    # Option B: Wrapping with a public CORS proxy (corsproxy.io) using API key
    api_key = "60e33c68"
    encoded_url = urllib.parse.quote(url, safe='')
    return f"https://corsproxy.io/?key={api_key}&url={encoded_url}"

def fetch_and_brand_playlist(url: str, output_file: str):
    headers = {
        'User-Agent': 'OTT Navigator'
    }
    req = urllib.request.Request(url, headers=headers)
    
    print(f"Fetching playlist from {url}...")
    with urllib.request.urlopen(req, timeout=25) as response:
        content = response.read().decode('utf-8')
    processed_lines = []
    for line in content.splitlines():
        if line.startswith('#EXTINF:'):
            # Brand tvg-name if present
            line = re.sub(r'tvg-name="([^"]+)"', r'tvg-name="\1 | GmaxHub"', line)
            # Brand display title at the end of EXTINF
            if ',' in line:
                prefix, title = line.rsplit(',', 1)
                if not title.strip().endswith('| GmaxHub'):
                    line = f"{prefix},{title.strip()} | GmaxHub"
        elif line.startswith('http://') or line.startswith('https://'):
            # Wrap the stream URL to fix browser CORS
            line = wrap_link(line)
            
        processed_lines.append(line)
    output_content = '\n'.join(processed_lines) + '\n'
    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(output_content)
    print(f"Successfully processed and saved playlist to '{output_file}'")

def main():
    url = 'https://server.vodep39240327.workers.dev/channel/raw?=m3u'
    output = 'Playlists/JioTV_S10.m3u'
    
    try:
        fetch_and_brand_playlist(url, output)
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    main()
