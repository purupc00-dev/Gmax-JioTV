import re
import json
import base64
import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Gmax-JioTV Backend Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# EXACT headers copied from jitendraunatti.php
MOBILE_HEADERS = {
    "User-Agent": "okhttp/4.2.2",
    "appname": "RJIL_JioTV",
    "os": "android",
    "m-rating": "0",
    "devicetype": "phone",
    "Content-Type": "application/json; charset=utf-8"
}

class OTPRequest(BaseModel):
    number: str

class VerifyRequest(BaseModel):
    number: str
    otp: str

@app.get("/")
async def root_check():
    return {"status": "Online", "message": "Gmax-JioTV Vercel Server is running perfectly!"}

@app.get("/api/channels")
async def get_channels():
    url = "https://jiotvapi.media.jio.com/apis/v1.4/live/channels.json"
    try:
        res = requests.get(url, headers={"User-Agent": "okhttp/4.9.0"}, timeout=10)
        return JSONResponse(content={"result": res.json().get("result", [])})
    except:
        raise HTTPException(status_code=500, detail="Failed to fetch channels")

@app.post("/api/send_otp")
async def send_otp(req: OTPRequest):
    number = req.number.strip()
    if not number.startswith("+91"):
        number = "+91" + number
        
    b64_number = base64.b64encode(number.encode('utf-8')).decode('utf-8')
    payload = json.dumps({"number": b64_number})
    
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/sendotp"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, data=payload, timeout=10)
        
        # PHP logic: 204 means success
        if res.status_code == 204:
            return JSONResponse(content={"message": "SUCCESS"}, status_code=200)
            
        try:
            data = res.json()
            return JSONResponse(content={"error": data.get("message", "API Error")}, status_code=400)
        except:
            return JSONResponse(content={"error": f"Cloudflare Blocked Vercel (HTTP {res.status_code})"}, status_code=400)
    except Exception as e:
        return JSONResponse(content={"error": f"Server crash: {str(e)}"}, status_code=500)

@app.post("/api/verify_otp")
async def verify_otp(req: VerifyRequest):
    number = req.number.strip()
    if not number.startswith("+91"):
        number = "+91" + number
        
    b64_number = base64.b64encode(number.encode('utf-8')).decode('utf-8')
    payload = json.dumps({
        "number": b64_number,
        "otp": str(req.otp).strip(),
        "deviceInfo": {
            "consumptionDeviceName": "JioTV",
            "info": {"type": "android", "platform": {"name": "android", "version": "11"}, "androidId": "gmax_auth"}
        }
    })
    
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/verifyotp"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, data=payload, timeout=10)
        try:
            data = res.json()
        except:
            return JSONResponse(content={"error": f"Cloudflare Blocked Vercel (HTTP {res.status_code})"}, status_code=400)

        if res.status_code == 200 and "ssoToken" in data:
            return JSONResponse(content=data, status_code=200)
        elif res.status_code == 200 and "data" in data and "ssoToken" in data["data"]:
            return JSONResponse(content=data["data"], status_code=200)
        else:
            return JSONResponse(content={"error": data.get("message", "Invalid OTP")}, status_code=400)
    except Exception as e:
        return JSONResponse(content={"error": f"Server crash: {str(e)}"}, status_code=500)

@app.get("/api/get_stream")
async def get_stream(id: str, ssotoken: str = "", uniqueid: str = "", crmid: str = ""):
    if not ssotoken or not uniqueid:
        raise HTTPException(status_code=401, detail="Missing auth tokens")

    url = "https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6"
    headers = MOBILE_HEADERS.copy()
    headers.update({"ssotoken": ssotoken, "uniqueId": uniqueid, "crmid": crmid})
    
    try:
        res = requests.post(url, headers=headers, json={"channel_id": id, "stream_type": "Seek"}, timeout=10)
        try:
            data = res.json()
        except:
            return JSONResponse(content={"error": "Cloudflare blocked stream request."}, status_code=400)
            
        if res.status_code == 200 and "url" in data:
            stream_url = data["url"]
            token_match = re.search(r'__hdnea__=([^&]+)', stream_url)
            token = "__hdnea__=" + token_match.group(1) if token_match else ""
            clean_url = stream_url.split('?')[0]
            return JSONResponse(content={"url": clean_url, "token": token})
        else:
            return JSONResponse(content={"error": "Failed to resolve stream", "details": data}, status_code=400)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
