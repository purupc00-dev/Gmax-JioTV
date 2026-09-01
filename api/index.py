import re
import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Gmax-JioTV Backend Engine")

# Completely opens CORS so your GitHub Pages site is never blocked
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Standard JioTV Mobile App Headers
MOBILE_HEADERS = {
    "os": "android",
    "appname": "RJIL_JioTV",
    "User-Agent": "okhttp/4.9.0",
    "devicetype": "phone",
    "osVersion": "11",
    "versionCode": "320",
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json"
}

class OTPRequest(BaseModel):
    number: str

class VerifyRequest(BaseModel):
    number: str
    otp: str

# --- HEALTH CHECKS (Fixes the 404 on your Vercel Homepage) ---
@app.get("/")
async def root_check():
    return {"status": "Online", "message": "Gmax-JioTV Vercel Server is running perfectly!"}

@app.get("/api")
async def api_check():
    return {"status": "Online", "message": "API endpoints are active and ready."}

# --- JIOTV ENDPOINTS ---
@app.get("/api/channels")
async def get_channels():
    """Fetches the live channel list directly from Jio."""
    url = "https://jiotvapi.media.jio.com/apis/v1.4/live/channels.json"
    try:
        res = requests.get(url, headers={"User-Agent": "okhttp/4.9.0"}, timeout=10)
        data = res.json().get("result", [])
        return JSONResponse(content={"result": data})
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to fetch channels")

@app.post("/api/send_otp")
async def send_otp(req: OTPRequest):
    """Hits the JioTV OTP server."""
    number = req.number.strip()
    if not number.startswith("+91"):
        number = "+91" + number
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/sendotp"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, json={"number": number}, timeout=10)
        return JSONResponse(content=res.json(), status_code=res.status_code)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify_otp")
async def verify_otp(req: VerifyRequest):
    """Verifies OTP and returns your private authentication tokens."""
    number = req.number.strip()
    if not number.startswith("+91"):
        number = "+91" + number
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/verifyotp"
    payload = {
        "number": number,
        "otp": str(req.otp).strip(),
        "deviceInfo": {
            "consumptionDeviceName": "JioTV",
            "info": {"type": "android", "platform": {"name": "android", "version": "11"}, "androidId": "gmax_auth"}
        }
    }
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, json=payload, timeout=10)
        return JSONResponse(content=res.json(), status_code=res.status_code)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/get_stream")
async def get_stream(id: str, ssotoken: str = "", uniqueid: str = "", crmid: str = ""):
    """The master proxy: Fetches the raw m3u8 URL and extracts the DRM token."""
    if not ssotoken or not uniqueid:
        raise HTTPException(status_code=401, detail="Missing auth tokens")

    url = "https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6"
    headers = MOBILE_HEADERS.copy()
    headers.update({"ssotoken": ssotoken, "uniqueId": uniqueid, "crmid": crmid})
    
    try:
        res = requests.post(url, headers=headers, json={"channel_id": id, "stream_type": "Seek"}, timeout=10)
        data = res.json()
        
        if res.status_code == 200 and "url" in data:
            stream_url = data["url"]
            # Extract the __hdnea__ token from the URL
            token_match = re.search(r'__hdnea__=([^&]+)', stream_url)
            token = "__hdnea__=" + token_match.group(1) if token_match else ""
            
            # Remove all queries to get the clean base URL
            clean_url = stream_url.split('?')[0]
            
            return JSONResponse(content={"url": clean_url, "token": token})
        else:
            return JSONResponse(content={"error": "Failed to resolve stream", "details": data}, status_code=400)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
