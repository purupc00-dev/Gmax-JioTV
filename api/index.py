import re
import base64
import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Gmax-JioTV API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
async def root():
    return {"status": "Online", "message": "Gmax-JioTV API ready"}

# ---------- SEND OTP ----------
@app.post("/send_otp")
@app.post("/api/send_otp")
async def send_otp(request: Request):
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    number = str(body.get("number", "")).strip()
    if not number:
        return JSONResponse({"error": "Phone number required"}, status_code=400)

    if not number.startswith("+91"):
        number = "+91" + number[-10:]

    b64 = base64.b64encode(number.encode()).decode()
    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/sendotp"

    try:
        r = requests.post(url, headers=MOBILE_HEADERS, json={"number": b64}, timeout=12)
        if r.status_code == 204:
            return {"message": "OTP Sent Successfully"}
        try:
            return JSONResponse(r.json(), status_code=r.status_code)
        except:
            return JSONResponse({"error": "Jio error", "raw": r.text}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# ---------- VERIFY OTP ----------
@app.post("/verify_otp")
@app.post("/api/verify_otp")
async def verify_otp(request: Request):
    try:
        body = await request.json()
    except:
        return JSONResponse({"error": "Invalid JSON"}, status_code=400)

    number = str(body.get("number", "")).strip()
    otp = str(body.get("otp", "")).strip()

    if not number or not otp:
        return JSONResponse({"error": "number and otp required"}, status_code=400)

    if not number.startswith("+91"):
        number = "+91" + number[-10:]

    b64 = base64.b64encode(number.encode()).decode()

    payload = {
        "number": b64,
        "otp": otp,
        "deviceInfo": {
            "consumptionDeviceName": "JioTV",
            "info": {
                "type": "android",
                "platform": {"name": "android", "version": "11"},
                "androidId": "gmax_" + number[-6:]
            }
        }
    }

    url = "https://jiotvapi.media.jio.com/apis/v1.0/login/verifyotp"
    try:
        r = requests.post(url, headers=MOBILE_HEADERS, json=payload, timeout=12)
        data = r.json()

        if r.status_code == 200:
            # Normalize – sometimes nested under "data"
            if "ssoToken" in data:
                return data
            if "data" in data and "ssoToken" in data["data"]:
                return data["data"]
            return data

        return JSONResponse(data, status_code=r.status_code)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# ---------- GET FRESH STREAM ----------
@app.get("/get_stream")
@app.get("/api/get_stream")
async def get_stream(request: Request):
    channel_id = request.query_params.get("id", "").strip()
    ssotoken = request.query_params.get("ssotoken", "").strip()
    uniqueid = request.query_params.get("uniqueid", "").strip()
    crmid = request.query_params.get("crmid", "").strip()

    if not channel_id or not ssotoken or not uniqueid:
        return JSONResponse({"error": "Missing id / ssotoken / uniqueid"}, status_code=401)

    url = "https://jiotvapi.media.jio.com/playback/apis/v1/geturl?langId=6"
    headers = MOBILE_HEADERS.copy()
    headers.update({
        "ssotoken": ssotoken,
        "uniqueId": uniqueid,
        "crmid": crmid or uniqueid,
        "deviceid": "gmax_device",
        "devicetype": "phone",
        "os": "android",
        "appname": "RJIL_JioTV",
        "versionCode": "370",
        "lbcookie": "1"
    })

    try:
        r = requests.post(
            url,
            headers=headers,
            json={"channel_id": channel_id, "stream_type": "Seek"},
            timeout=12
        )
        data = r.json()

        if r.status_code == 200 and "url" in data:
            stream_url = data["url"]
            # Extract __hdnea__ token
            token_match = re.search(r'(__hdnea__=[^&]+)', stream_url)
            token = token_match.group(1) if token_match else ""
            clean_url = stream_url.split("?")[0]

            return {
                "url": clean_url,
                "token": token,
                "full_url": stream_url,
                "raw": data
            }
        else:
            return JSONResponse(
                {"error": "Failed to get stream", "details": data},
                status_code=400
            )
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
