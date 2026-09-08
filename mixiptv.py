import urllib.request
import urllib.error
import re

url = 'https://premiumplugx.com/VIP/pluglist.php'

headers = {
    'User-Agent': 'OTT Navigator'
}
req = urllib.request.Request(url, headers=headers)

try:
    print(f"Fetching playlist from {url}...")
    with urllib.request.urlopen(req) as response:
        content = response.read().decode('utf-8')
        
        # --- THE FIX: Convert Header/Cookie format to Web standard Query Format ---
        # 1. Finds the base URL up to the pipe (| or %7C)
        # 2. Searches the rest of that line for the __hdnea__ token
        # 3. Rebuilds the URL as: BaseURL + ?__hdnea__=Token
        pattern = r"(https?://[^\s|%]+)(?:%7C|\|).*?__hdnea__=([^\s&]+)"
        replacement = r"\1?__hdnea__=\2"
        
        # Apply the regex replacement to the entire playlist content
        fixed_content = re.sub(pattern, replacement, content)
        # -------------------------------------------------------------------------
        
        # Save it to a file
        with open('mixiptv.m3u', 'w', encoding='utf-8') as f:
            f.write(fixed_content)
            
        print("Successfully fetched, fixed, and saved the playlist to 'mixiptv.m3u'")
        
        # Print a snippet to verify the URLs look clean
        print(f"\nFirst few lines:\n{fixed_content[:350]}...")

except urllib.error.HTTPError as e:
    print(f"HTTP Error: {e.code}")
except Exception as e:
    print(f"Error: {e}")
