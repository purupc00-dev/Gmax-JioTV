import glob
import json
import os
import re

OUTPUT_JSON_PATH = os.path.join("site", "channels.json")
M3U_FILES = ["jtvplus6.m3u", "jtvplus7.m3u", "jtvplus8.m3u"]


def parse_m3u_file(file_path):
  channels = {}
  if not os.path.exists(file_path):
    return channels

  with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()

  blocks = content.split("\n#EXTINF:")
  for block in blocks[1:]:
    lines = block.strip().split("\n")
    if not lines:
      continue

    extinf_line = lines[0]
    channel = {}

    id_match = re.search(r'tvg-id="([^"]*)"', extinf_line)
    name_match = re.search(r'tvg-name="([^"]*)"', extinf_line)
    logo_match = re.search(r'tvg-logo="([^"]*)"', extinf_line)
    group_match = re.search(r'group-title="([^"]*)"', extinf_line)

    ch_id = id_match.group(1) if id_match else ""
    ch_name = (
        name_match.group(1)
        if name_match
        else extinf_line.split(",")[-1].strip()
    )
    ch_logo = logo_match.group(1) if logo_match else ""
    ch_group = group_match.group(1) if group_match else "Entertainment"

    channel["id"] = ch_id
    channel["name"] = ch_name
    channel["logo"] = ch_logo
    channel["group"] = ch_group
    channel["category"] = ch_group

    for line in lines[1:]:
      line_str = line.strip()
      if line_str.startswith("#KODIPROP:inputstream.adaptive.license_key="):
        key_val = line_str.split("=", 1)[1].strip()
        if ":" in key_val:
          k_id, k_val = key_val.split(":", 1)
          channel["key_id"] = k_id.strip()
          channel["key"] = k_val.strip()
      elif line_str.startswith("#EXTHTTP:"):
        try:
          http_json = json.loads(line_str[9:])
          if "cookie" in http_json:
            channel["cookie"] = http_json["cookie"]
        except Exception:
          pass
      elif not line_str.startswith("#") and line_str.startswith("http"):
        channel["stream_url"] = line_str

    identifier = ch_id or ch_name
    if identifier and "stream_url" in channel:
      channels[identifier] = channel

  return channels


def main():
  print("Parsing playlists...")
  p6 = parse_m3u_file("jtvplus6.m3u")
  p7 = parse_m3u_file("jtvplus7.m3u")
  p8 = parse_m3u_file("jtvplus8.m3u")

  all_keys = set(list(p6.keys()) + list(p7.keys()) + list(p8.keys()))
  merged_channels = []

  for k in all_keys:
    # Use jtvplus6 as primary, fallback to 7 or 8 if missing
    base = p6.get(k) or p7.get(k) or p8.get(k)
    if not base:
      continue

    # Add fallback servers so your app has access to 7 and 8
    fallbacks = []
    if k in p7 and p7[k].get("stream_url") != base.get("stream_url"):
      fallbacks.append({
          "server": "jtvplus7",
          "stream_url": p7[k].get("stream_url"),
          "cookie": p7[k].get("cookie"),
          "key_id": p7[k].get("key_id"),
          "key": p7[k].get("key"),
      })
    if k in p8 and p8[k].get("stream_url") != base.get("stream_url"):
      fallbacks.append({
          "server": "jtvplus8",
          "stream_url": p8[k].get("stream_url"),
          "cookie": p8[k].get("cookie"),
          "key_id": p8[k].get("key_id"),
          "key": p8[k].get("key"),
      })

    base["fallbacks"] = fallbacks
    merged_channels.append(base)

  os.makedirs("site", exist_ok=True)
  with open(OUTPUT_JSON_PATH, "w", encoding="utf-8") as f:
    # Set indent=None if you want a small 1-line file, or indent=2 for readable JSON
    json.dump(merged_channels, f, indent=2, ensure_ascii=False)

  print(
      f"Merged {len(merged_channels)} unique channels from jtvplus 6, 7, and"
      " 8."
  )


if __name__ == "__main__":
  main()
