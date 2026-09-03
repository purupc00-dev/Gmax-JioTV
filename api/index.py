import re
import base64
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Gmax-JioTV API")

# Fully open CORS to prevent GitHub Pages from blocking the request
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Standard JioTV Mobile App Headers
MOBILE_HEADERS = {
    "User-Agent": "okhttp/4.2.2",
    "appname": "RJIL_JioTV",
    "os": "android",
    "m-rating": "0",
    "devicetype": "phone",
    "Content-Type": "application/json"
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
        
    number = req.get("number", "").strip()
    if not number:
        return JSONResponse(content={"error": "Phone number is empty"}, status_code=400)
        
    if not number.startswith("+91"):
        number = "+91" + number
        
    # Base64 encode the phone number, exactly like the PHP script does
    b64_number = base64.b64encode(number.encode('utf-8')).decode('utf-8')
    
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/sendotp"
    try:
        res = requests.post(url, headers=MOBILE_HEADERS, json={"number": b64_number}, timeout=10)
        
        # Jio returns HTTP 204 (No Content) on successful OTP dispatch
        if res.status_code == 204:
            return JSONResponse(content={"message": "OTP Sent Successfully"}, status_code=200)
            
        # Parse error responses from JioTV
        try:
            return JSONResponse(content=res.json(), status_code=res.status_code)
        except Exception:
            return JSONResponse(content={"error": "Invalid response from Jio", "raw": res.text}, status_code=400)
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
        
    number = req.get("number", "").strip()
    if not number.startswith("+91"):
        number = "+91" + number
        
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
    
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/verifyotp"
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
