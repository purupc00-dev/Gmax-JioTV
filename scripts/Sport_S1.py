import urllib.request
import json
import os

def fetch_json(json_url):
    """Fetch and parse JSON data."""
    req = urllib.request.Request(json_url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)

def generate_m3u(data, output_file):
    """Create an M3U playlist with cookies and headers for all channels."""
    user_agent = 'GmaxHub'
    lines = ['#EXTM3U']

    # Safely get the channels array
    channels = data.get("channels", [])
    if not channels:
        print("❌ No channels found in the JSON.")
        return

    for item in channels:
        name = item.get('name', 'Unknown')
        logo = item.get('logo', '')
        category = item.get('category', item.get('group', 'Sports'))
        
        # Check different possible keys for the URL
        url = item.get('url', item.get('link', item.get('mpd_url', '')))
        cookie = item.get('cookie', '')

        if not url:
            continue

        # Extract DRM keys if they exist in this JSON
        kid = item.get('keyId', '')
        key = item.get('key', '')
        if item.get('clearkey') and isinstance(item.get('clearkey'), dict):
            for k, v in item.get('clearkey').items():
                kid = k
                key = v
                break

        # Apply GmaxHub Branding
        lines.append(f'#EXTINF:-1 tvg-name="{name} | GmaxHub" tvg-logo="{logo}" group-title="{category}", {name} | GmaxHub')
        lines.append('#KODIPROP:inputstream=inputstream.adaptive')
        lines.append('#KODIPROP:inputstream.adaptive.manifest_type=mpd')
        
        # Inject DRM keys if found
        if kid and key:
            lines.append('#KODIPROP:inputstream.adaptive.license_type=clearkey')
            lines.append(f'#KODIPROP:inputstream.adaptive.license_key={kid}:{key}')
        
        lines.append(f'#EXTVLCOPT:http-user-agent={user_agent}')
        
        # Inject the cookie per channel
        if cookie:
            lines.append(f'#EXTVLCOPT:http-cookie={cookie}')
            lines.append(f'#EXTHTTP:{{"User-Agent":"{user_agent}","Cookie":"{cookie}"}}')
        else:
            lines.append(f'#EXTHTTP:{{"User-Agent":"{user_agent}"}}')

        lines.append(url)

    # Automatically create the Playlists folder if it doesn't exist yet
    os.makedirs(os.path.dirname(output_file), exist_ok=True)

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    
    print(f"✅ Generated {output_file} with {len(channels)} channels.")

def main():
    json_url = "https://sonujson-v3.pages.dev/Data/sports.json"
    output = 'Playlists/Sport_S1.m3u'

    try:
        data = fetch_json(json_url)
        generate_m3u(data, output)
    except Exception as e:
        print(f'❌ Error: {e}')

if __name__ == '__main__':
    main()
