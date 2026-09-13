import os
import re
import json
import urllib.request
import urllib.error
import urllib.parse

# Your Dedicated Proxy Endpoint
PROXY_BASE = "https://proxy.gmaxhub.workers.dev/proxy"

def normalize_cookie(cookie_str):
    if not cookie_str: 
        return ""
    # Fix Hotstar's acl over-decoding issue which breaks HMAC (Akamai 475 error)
    cookie_str = urllib.parse.unquote(cookie_str)
    cookie_str = re.sub(r'acl=/\*', 'acl=%2f*', cookie_str, flags=re.IGNORECASE)
    return cookie_str

def unwrap_corsproxy(url):
    """Removes public corsproxy.io wrappers to get the raw stream URL."""
    if 'corsproxy.io' in url:
        parsed = urllib.parse.urlparse(url)
        qs = urllib.parse.parse_qs(parsed.query)
        if 'url' in qs:
            return qs['url'][0]
    return url

def process_stream_url(url, meta):
    """
    Takes a raw stream URL, strips public proxies and pipe headers,
    and wraps it safely into your custom GmaxHub Cloudflare Worker.
    """
    if not url or url.startswith('#'):
        return url

    # 1. Strip corsproxy.io wrapper
    real_url = unwrap_corsproxy(url)
    
    # 2. Extract Kodi pipe headers if present (e.g., ...m3u8?|cookie=...)
    if '|' in real_url:
        sep = '?|' if '?|' in real_url else '|'
        parts = real_url.split(sep, 1)
        real_url = parts[0]
        if len(parts) > 1:
            for param in parts[1].split('&'):
                if '=' in param:
                    k, v = param.split('=', 1)
                    k = k.lower().strip()
                    v = urllib.parse.unquote(v.strip())
                    if k == 'cookie': meta['cookie'] = v
                    elif k in ('referer', 'referrer'): meta['referer'] = v
                    elif k == 'origin': meta['origin'] = v
                    elif k in ('user-agent', 'ua'): meta['ua'] = v

    if meta.get('cookie'):
        meta['cookie'] = normalize_cookie(meta['cookie'])

    # 3. Build your custom Cloudflare proxy URL
    query_params = {'uri': real_url}
    if meta.get('cookie'): query_params['cookie'] = meta['cookie']
    if meta.get('origin'): query_params['origin'] = meta['origin']
    if meta.get('referer'): query_params['referer'] = meta['referer']
    if meta.get('ua'): query_params['ua'] = meta['ua']

    # Urlencode parameters safely so the Worker receives them intact
    return f"{PROXY_BASE}?{urllib.parse.urlencode(query_params)}"

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
    # Meta dictionary to hold headers for the current channel block
    current_meta = {'cookie': '', 'referer': '', 'origin': '', 'ua': ''}

    for line in content.splitlines():
        trimmed = line.strip()
        if not trimmed:
            continue

        # 1. Start of a new channel block
        if trimmed.startswith('#EXTINF:'):
            # Reset metadata for the new channel
            current_meta = {'cookie': '', 'referer': '', 'origin': '', 'ua': ''}
            
            # Brand the channel name
            trimmed = re.sub(r'tvg-name="([^"]+)"', r'tvg-name="\1 | GmaxHub"', trimmed)
            if ',' in trimmed:
                prefix, title = trimmed.rsplit(',', 1)
                if not title.strip().endswith('| GmaxHub'):
                    trimmed = f"{prefix},{title.strip()} | GmaxHub"
            processed_lines.append(trimmed)

        # 2. Capture EXTHTTP JSON headers
        elif trimmed.startswith('#EXTHTTP:'):
            processed_lines.append(trimmed)
            try:
                data = json.loads(trimmed[9:].strip())
                if 'Cookie' in data or 'cookie' in data:
                    current_meta['cookie'] = data.get('Cookie') or data.get('cookie')
                if 'Referer' in data or 'referer' in data:
                    current_meta['referer'] = data.get('Referer') or data.get('referer')
                if 'Origin' in data or 'origin' in data:
                    current_meta['origin'] = data.get('Origin') or data.get('origin')
            except Exception:
                pass

        # 3. Capture EXTVLCOPT headers
        elif trimmed.startswith('#EXTVLCOPT:'):
            processed_lines.append(trimmed)
            if 'http-user-agent=' in trimmed:
                current_meta['ua'] = trimmed.split('=', 1)[1].strip()
            elif 'http-referrer=' in trimmed:
                current_meta['referer'] = trimmed.split('=', 1)[1].strip()
            elif 'http-cookie=' in trimmed:
                current_meta['cookie'] = trimmed.split('=', 1)[1].strip()
            elif 'http-extra-headers=' in trimmed:
                extra = trimmed.split('=', 1)[1].strip()
                if 'Origin:' in extra:
                    origin_match = re.search(r'Origin:\s*(\S+)', extra, re.IGNORECASE)
                    if origin_match:
                        current_meta['origin'] = origin_match.group(1)

        # 4. Stream Manifest URL (The actual playing file)
        elif trimmed.startswith('http://') or trimmed.startswith('https://'):
            # Process the URL to strip corsproxy.io and wrap ONLY the MPD/M3U8 with GmaxHub Proxy
            new_url = process_stream_url(trimmed, current_meta)
            processed_lines.append(new_url)

        # 5. Keep all other lines (KODIPROP, EXT-X-, etc) unchanged
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
        # ('https://mitthu786...', 'Playlists/TataPlay.m3u')
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
