import re
import base64
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Gmax-JioTV API")

# Fully open CORS to prevent GitHub Pages from blocking the request
# NOTE: allow_credentials must be False when allow_origins is "*" -
# the two together are invalid per the CORS spec and some browsers/
# proxies will reject the preflight outright. We don't use cookies
# here, so credentials aren't needed.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def normalize_indian_number(raw: str) -> str | None:
    """
    Strip everything but digits, drop a leading country code if present,
    and return a clean +91XXXXXXXXXX string. Returns None if it doesn't
    look like a valid 10-digit Indian mobile number.

    This matters because the old code just string-prefixed "+91" onto
    whatever the user typed, so "+91 98765 43210" or "091-98765-43210"
    would get base64-encoded as garbage and Jio would reject it (which
    the frontend then showed as a generic "Failed to send OTP").
    """
    digits = re.sub(r"\D", "", raw or "")
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    if len(digits) != 10:
        return None
    return "+91" + digits

# Standard JioTV Mobile App Headers
MOBILE_HEADERS = {
    "User-Agent": "okhttp/4.2.2",
    "appname": "RJIL_JioTV",
    "os": "android",
    "m-rating": "0",
    "devicetype": "phone",
    "Content-Type": "application/json"
}

# Jio's numeric category IDs -> readable names (frontend buckets these further
# via keyword matching, so this only needs to be roughly right).
CATEGORY_MAP = {
    0: "All", 5: "Entertainment", 6: "Movies", 7: "Kids", 8: "Sports",
    9: "Lifestyle", 10: "Infotainment", 12: "News", 13: "Music",
    15: "Devotional", 16: "Business", 17: "Educational", 18: "Shopping",
    19: "JioDarshan",
}

@app.get("/")
@app.get("/api")
async def root_check():
    return {"status": "Online", "message": "Gmax-JioTV API is running smoothly!"}

# --- SEND OTP ---
# Listening on both paths guarantees Vercel won't 404 the request
@app.post("/send_otp")
@app.post("/api/send_otp")
async def send_otp(request: Request):
    try:
        req = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON sent from frontend"}, status_code=400)
        
    raw_number = req.get("number", "").strip()
    if not raw_number:
        return JSONResponse(content={"error": "Phone number is empty"}, status_code=400)

    number = normalize_indian_number(raw_number)
    if not number:
        return JSONResponse(
            content={"error": "Enter a valid 10-digit Indian mobile number"},
            status_code=400,
        )

    # Base64 encode the phone number, exactly like the PHP script does
    b64_number = base64.b64encode(number.encode('utf-8')).decode('utf-8')

    url = "https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/send"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, json={"number": b64_number}, timeout=10)

        # Log to Vercel function logs so we can actually see what Jio said
        print(f"[send_otp] Jio responded {res.status_code}: {res.text[:500]}")

        # Jio returns HTTP 204 (No Content) on successful OTP dispatch
        if res.status_code == 204:
            return JSONResponse(content={"message": "OTP Sent Successfully"}, status_code=200)

        # Jio blocks requests that don't originate from an Indian IP -
        # this most commonly shows up as a 403 here. Surface that clearly
        # instead of a generic error.
        if res.status_code == 403:
            return JSONResponse(
                content={
                    "error": "Jio rejected the request (403). This almost always means the "
                             "server's outbound IP is not an Indian IP - Jio's OTP API only "
                             "accepts requests from India. Confirm the Vercel function is "
                             "actually running in the bom1 region.",
                    "raw": res.text,
                },
                status_code=403,
            )

        # Parse error responses from JioTV
        try:
            return JSONResponse(content=res.json(), status_code=res.status_code)
        except Exception:
            content_type = res.headers.get("content-type", "unknown")
            snippet = res.text[:300]
            print(f"[send_otp] Non-JSON reply. status={res.status_code} "
                  f"content-type={content_type} body={snippet!r}")
            looks_like_block_page = "<html" in res.text.lower() or "<!doctype" in res.text.lower()
            hint = (
                " This looks like an HTML block/error page rather than a Jio API "
                "response - almost certainly Jio's geo-block, since this endpoint "
                "only accepts requests from Indian IPs. Check that the Vercel "
                "function is actually deployed to bom1 (Mumbai)."
                if looks_like_block_page else
                " Jio returned a non-JSON body - the endpoint or headers it expects "
                "may have changed."
            )
            return JSONResponse(
                content={
                    "error": f"Invalid response from Jio (HTTP {res.status_code}, "
                             f"content-type: {content_type}).{hint}",
                    "raw": snippet,
                },
                status_code=400,
            )
    except requests.exceptions.RequestException as e:
        print(f"[send_otp] Request to Jio failed: {e}")
        return JSONResponse(content={"error": f"Could not reach Jio: {str(e)}"}, status_code=502)
    except Exception as e:
        return JSONResponse(content={"error": f"Server error: {str(e)}"}, status_code=500)

# --- VERIFY OTP ---
@app.post("/verify_otp")
@app.post("/api/verify_otp")
async def verify_otp(request: Request):
    try:
        req = await request.json()
    except Exception:
        return JSONResponse(content={"error": "Invalid JSON sent from frontend"}, status_code=400)
        
    raw_number = req.get("number", "").strip()
    number = normalize_indian_number(raw_number)
    if not number:
        return JSONResponse(
            content={"error": "Enter a valid 10-digit Indian mobile number"},
            status_code=400,
        )

    b64_number = base64.b64encode(number.encode('utf-8')).decode('utf-8')
    otp = str(req.get("otp", "")).strip()
    
    payload = {
        "number": b64_number,
        "otp": otp,
        "deviceInfo": {
            "consumptionDeviceName": "JioTV",
            "info": {"type": "android", "platform": {"name": "android", "version": "11"}, "androidId": "gmax_auth"}
        }
    }
    
    url = "https://jiotvapi.media.jio.com/userservice/apis/v1/loginotp/verify"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, json=payload, timeout=10)
        try:
            data = res.json()
        except Exception:
            return JSONResponse(content={"error": "Invalid response from Jio", "raw": res.text}, status_code=400)

        # Normalize the auth structure for app.js
        if res.status_code == 200:
            if "ssoToken" in data:
                return JSONResponse(content=data, status_code=200)
            elif "data" in data and "ssoToken" in data["data"]:
                return JSONResponse(content=data["data"], status_code=200)
                
        return JSONResponse(content=data, status_code=res.status_code)
    except Exception as e:
        return JSONResponse(content={"error": f"Server error: {str(e)}"}, status_code=500)

# --- GET STREAM MANIFEST & TOKEN ---
@app.get("/get_stream")
@app.get("/api/get_stream")
async def get_stream(request: Request):
    id = request.query_params.get("id", "")
    ssotoken = request.query_params.get("ssotoken", "")
    uniqueid = request.query_params.get("uniqueid", "")
    crmid = request.query_params.get("crmid", "")

    if not ssotoken or not uniqueid:
        return JSONResponse(content={"error": "Missing auth tokens"}, status_code=401)

    url = "https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6"
    headers = MOBILE_HEADERS.copy()
    headers.update({"ssotoken": ssotoken, "uniqueId": uniqueid, "crmid": crmid})
    
    try:
        res = requests.post(url, headers=headers, json={"channel_id": id, "stream_type": "Seek"}, timeout=10)
        try:
            data = res.json()
        except Exception:
            return JSONResponse(content={"error": "Invalid manifest response from Jio"}, status_code=400)
            
        if res.status_code == 200 and "url" in data:
            stream_url = data["url"]
            # Extract the __hdnea__ DRM token
            token_match = re.search(r'__hdnea__=([^&]+)', stream_url)
            token = "__hdnea__=" + token_match.group(1) if token_match else ""
            clean_url = stream_url.split('?')[0]
            
            return JSONResponse(content={"url": clean_url, "token": token})
        else:
            return JSONResponse(content={"error": "Failed to resolve stream", "details": data}, status_code=400)
    except Exception as e:
        return JSONResponse(content={"error": f"Server error: {str(e)}"}, status_code=500)

# --- GET LIVE CHANNEL CATALOG ---
# Pulls the real, current channel list straight from Jio (correct channel_id,
# category, logo) instead of the static local channels.json. This matters
# because get_stream needs Jio's *actual* numeric channel_id - IDs sourced
# from third-party M3U playlists don't reliably match, which is why some
# channels play and others silently fail.
@app.get("/get_channels")
@app.get("/api/get_channels")
async def get_channels(request: Request):
    ssotoken = request.query_params.get("ssotoken", "")
    uniqueid = request.query_params.get("uniqueid", "")
    crmid = request.query_params.get("crmid", "")

    url = (
        "https://jiotv.data.cdn.jio.com/apis/v3.0/getMobileChannelList/get/"
        "?os=android&devicetype=phone&usertype=JIO&langId=6"
    )
    headers = MOBILE_HEADERS.copy()
    # Auth headers are optional here - the catalog itself is generally public,
    # but pass them through when we have them in case Jio uses them to tailor
    # results (e.g. marking channels the account is actually entitled to).
    if ssotoken:
        headers.update({
            "ssotoken": ssotoken,
            "uniqueId": uniqueid,
            "crmid": crmid,
        })

    try:
        res = requests.get(url, headers=headers, timeout=15)
        print(f"[get_channels] Jio responded {res.status_code}, "
              f"{len(res.content)} bytes")

        try:
            data = res.json()
        except Exception:
            content_type = res.headers.get("content-type", "unknown")
            snippet = res.text[:300]
            print(f"[get_channels] Non-JSON reply. status={res.status_code} "
                  f"content-type={content_type} body={snippet!r}")
            return JSONResponse(
                content={
                    "error": f"Invalid response from Jio (HTTP {res.status_code}, "
                             f"content-type: {content_type}). The channel list "
                             f"endpoint or its params may have changed.",
                    "raw": snippet,
                },
                status_code=400,
            )

        raw_channels = data.get("result", [])
        if not isinstance(raw_channels, list) or not raw_channels:
            return JSONResponse(
                content={
                    "error": "Jio returned no channels.",
                    "raw": data,
                },
                status_code=400,
            )

        channels = []
        for i, ch in enumerate(raw_channels):
            cid = ch.get("channel_id")
            name = ch.get("channel_name")
            if cid is None or not name:
                continue
            channels.append({
                "id": str(cid),
                "name": name,
                "logo": ch.get("logoUrl", ""),
                "category": CATEGORY_MAP.get(ch.get("channelCategoryId"), "Entertainment"),
                "isHD": bool(ch.get("isHD", False)),
                "sort_order": i,
                "source_m3u": "jio_live",
            })

        return JSONResponse(content={"channels": channels, "count": len(channels)})
    except requests.exceptions.RequestException as e:
        print(f"[get_channels] Request to Jio failed: {e}")
        return JSONResponse(content={"error": f"Could not reach Jio: {str(e)}"}, status_code=502)
    except Exception as e:
        return JSONResponse(content={"error": f"Server error: {str(e)}"}, status_code=500)
