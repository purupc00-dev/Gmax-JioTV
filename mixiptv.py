import urllib.request
import urllib.error
import re

url = 'https://premiumplugx.com/VIP/pluglist.php'

# Use the exact masked User-Agent from the OTT Navigator network logs
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/164.0.0.0 Safari/537.36'
}
req = urllib.request.Request(url, headers=headers)

try:
    print(f"Fetching playlist from {url}...")
    with urllib.request.urlopen(req) as response:
        content = response.read().decode('utf-8')
        
        # 1. Split by pipe to preserve the base URL
        # 2. Extract the hdnea token and append it as a standard query parameter
        # 3. Warning: If feeding this to a web player, the player MUST be configured 
        #    to use the exact same Chrome/164 User-Agent for all segment requests.
        
        pattern = r"(https?://[^\s|%]+)(?:%7C|\|).*?__hdnea__=([^\s&]+)"
        replacement = r"\1?__hdnea__=\2"
        
        fixed_content = re.sub(pattern, replacement, content)
        
        # For a production streaming app, return this dynamically via an API route 
        # rather than saving to a static file to avoid token expiration.
        with open('mixiptv.m3u', 'w', encoding='utf-8') as f:
            f.write(fixed_content)
            
        print("Successfully fetched, fixed, and saved the playlist to 'mixiptv.m3u'")
        
except urllib.error.HTTPError as e:
    print(f"HTTP Error: {e.code}")
except Exception as e:
    print(f"Error: {e}")
