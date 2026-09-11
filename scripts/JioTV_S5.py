import os
import re
import urllib.request
import urllib.error
import json

def fetch_and_brand_playlist(url: str, output_file: str):
    headers = {
        'User-Agent': 'OTT Navigator'
    }
    req = urllib.request.Request(url, headers=headers)
    
    print(f"Fetching playlist from {url}...")
    with urllib.request.urlopen(req, timeout=20) as response:
        content = response.read().decode('utf-8')

    branded_lines = []
    current_cookie = ""

    for line in content.splitlines():
        # 1. Apply GmaxHub Branding to EXTINF
        if line.startswith('#EXTINF:'):
            line = re.sub(r'tvg-name="([^"]+)"', r'tvg-name="\1 | GmaxHub"', line)
            if ',' in line:
                prefix, title = line.rsplit(',', 1)
                if not title.strip().endswith('| GmaxHub'):
                    line = f"{prefix},{title.strip()} | GmaxHub"
            branded_lines.append(line)
        
        # 2. Intercept the Cookie from EXTHTTP
        elif line.startswith('#EXTHTTP:'):
            try:
                # Clean the string and parse the JSON
                json_str = line.replace('#EXTHTTP:', '').strip()
                headers_dict = json.loads(json_str)
                if 'cookie' in headers_dict:
                    current_cookie = headers_dict['cookie']
            except:
                pass
            branded_lines.append(line) # Keep the original header just in case

        # 3. Inject the __hdnea__ Token directly into the URL!
        elif line.startswith('http') and not line.startswith('#'):
            if current_cookie and '__hdnea__' in current_cookie:
                # Check if the URL already has a '?' to append correctly
                separator = '&' if '?' in line else '?'
                line = f"{line}{separator}{current_cookie}"
            
            branded_lines.append(line)
            # Reset cookie for the next channel
            current_cookie = ""
            
        # All other lines (KODIPROP, EXTVLCOPT) stay untouched
        else:
            branded_lines.append(line)

    output_content = '\n'.join(branded_lines) + '\n'

    os.makedirs(os.path.dirname(output_file), exist_ok=True)
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(output_content)

    print(f"Successfully saved branded and token-injected playlist to '{output_file}'")

def main():
    url = 'https://m3u.cloudplay.qzz.io/jtvx.txt'
    output = 'Playlists/JioTV_S5.m3u'
    
    try:
        fetch_and_brand_playlist(url, output)
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == '__main__':
    main()
