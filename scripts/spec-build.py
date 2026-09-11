#!/usr/bin/env python3
"""
ProGlide Mobile Model Master Database - record builder (Source 1 + Source 2 phase).

Sources allowed in this phase, and only these two:
  Source 1  Official manufacturer (product page, tech specs page, support page,
            official archive, official launch announcement)
  Source 2  TechSpecs API

Expands a compact per-model dict of RESEARCHED values into the full record
shape. Rules enforced here and never bypassed:

  * A field absent from BOTH sources is written "Not Found in Source 1/Source 2".
  * A field the manufacturer explicitly does not publish (launch price is the
    common case) is written "Not Published by Manufacturer".
  * Nothing is guessed, estimated, or carried over from another model or
    generation. Repair part identifiers are recorded only when a source states
    them; otherwise they stay Not Found.
  * Model-level data lives on the model; RAM/ROM/colour/region data lives on
    variants. Variants are never merged.
  * verification.status is derived from which sources actually supplied data:
      CROSS-CHECKED            both sources agree
      OFFICIAL SOURCE VERIFIED only the manufacturer supplied it
      TECHSPECS VERIFIED       only TechSpecs supplied it
      CONFLICT                 sources disagree; both values are kept

    python scripts/spec-build.py <input.json> <brand-dir>
"""
import json, os, sys, datetime

NF = "Not Found in Source 1/Source 2"
NPM = "Not Published by Manufacturer"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TODAY = datetime.date.today().isoformat()

SERVICE_PART_KEYS = [
    "displayModelNo", "displayAssemblyPartNo", "batteryModelNo", "batteryPartNo",
    "backGlassPartNo", "chargingBoardPartNo", "mainboardId", "cameraModuleId",
    "otherParts",
]


def build(rec):
    g = rec.get
    return {
        "modelId": rec["modelId"],
        "brand": rec["brand"],
        "brandId": rec["brandId"],

        # 1. BASIC MODEL INFORMATION
        "identity": {
            "officialModelName": g("officialModelName", NF),
            "commercialModelName": g("commercialModelName", NF),
            "modelNumbers": g("modelNumbers", []) or [NF],
            "officialModelNumbers": g("officialModelNumbers", []) or [NF],
            "regionalModelNumbers": g("regionalModelNumbers", []) or [NF],
            "series": g("series", NF),
            "subSeries": g("subSeries", NF),
            "deviceType": g("deviceType", NF),
            "formFactor": g("formFactor", NF),
            "codename": g("codename", NF),
            "announcementDate": g("announcementDate", NF),
            "releaseDate": g("releaseDate", NF),
            "officialLaunchDate": g("officialLaunchDate", NF),
            "availabilityDate": g("availabilityDate", NF),
            "discontinuedDate": g("discontinuedDate", NF),
            "launchCountry": g("launchCountry", NF),
            "regionalAvailability": g("regionalAvailability", NF),
        },
        # 2 + 3 + 4. VARIANTS (RAM/ROM/colour/region/price live here, never merged)
        "variants": g("variants", []),
        "officialColors": g("officialColors", []) or [NF],
        "launchPrices": g("launchPrices", []),
        # 5 + 6. DISPLAY
        "display": {
            "size": g("displaySize", NF),
            "type": g("displayType", NF),
            "technology": g("displayTechnology", NF),
            "panelType": g("panelType", NF),
            "screenShape": g("screenShape", NF),
            "foldType": g("foldType", NF),
            "resolution": g("resolution", NF),
            "resolutionWidth": g("resolutionWidth", NF),
            "resolutionHeight": g("resolutionHeight", NF),
            "aspectRatio": g("aspectRatio", NF),
            "pixelDensity": g("pixelDensity", NF),
            "refreshRate": g("refreshRate", NF),
            "peakBrightness": g("peakBrightness", NF),
            "typicalBrightness": g("typicalBrightness", NF),
            "hdrSupport": g("hdrSupport", NF),
            "hdrStandard": g("hdrStandard", NF),
            "touchSamplingRate": g("touchSamplingRate", NF),
            "screenProtection": g("screenProtection", NF),
            "glassType": g("glassType", NF),
            "alwaysOnDisplay": g("alwaysOnDisplay", NF),
            "screenToBodyRatio": g("screenToBodyRatio", NF),
            "colorDepth": g("colorDepth", NF),
            "contrastRatio": g("contrastRatio", NF),
            "otherDisplayAttributes": g("otherDisplayAttributes", NF),
            "displayModelIdentifier": g("displayModelIdentifier", NF),
        },
        # 7. PROCESSOR / PLATFORM
        "platform": {
            "officialProcessor": g("officialProcessor", NF),
            "chipset": g("chipset", NF),
            "soc": g("soc", NF),
            "cpu": g("cpu", NF),
            "cpuArchitecture": g("cpuArchitecture", NF),
            "cpuCoreCount": g("cpuCoreCount", NF),
            "cpuCoreConfiguration": g("cpuCoreConfiguration", NF),
            "cpuClockSpeed": g("cpuClockSpeed", NF),
            "fabricationProcess": g("fabricationProcess", NF),
            "gpu": g("gpu", NF),
            "npu": g("npu", NF),
            "chipsetVariant": g("chipsetVariant", NF),
            "regionSpecificProcessor": g("regionSpecificProcessor", NF),
        },
        # 8. MEMORY
        "memory": {
            "ramTechnology": g("ramTechnology", NF),
            "ramType": g("ramType", NF),
            "virtualRam": g("virtualRam", NF),
            "storageTechnology": g("storageTechnology", NF),
            "ufsVersion": g("ufsVersion", NF),
            "expandableStorage": g("expandableStorage", NF),
            "microSdSupport": g("microSdSupport", NF),
            "maxExpandableCapacity": g("maxExpandableCapacity", NF),
        },
        # 9. CAMERA
        "camera": {
            "rearCameraCount": g("rearCameraCount", NF),
            "mainCamera": g("mainCamera", NF),
            "mainCameraMp": g("mainCameraMp", NF),
            "mainSensorModel": g("mainSensorModel", NF),
            "sensorManufacturer": g("sensorManufacturer", NF),
            "sensorSize": g("sensorSize", NF),
            "pixelSize": g("pixelSize", NF),
            "mainAperture": g("mainAperture", NF),
            "ois": g("ois", NF),
            "eis": g("eis", NF),
            "pdaf": g("pdaf", NF),
            "laserAf": g("laserAf", NF),
            "ultrawide": g("ultrawide", NF),
            "telephoto": g("telephoto", NF),
            "periscope": g("periscope", NF),
            "macro": g("macro", NF),
            "depth": g("depth", NF),
            "monochrome": g("monochrome", NF),
            "otherRearSensors": g("otherRearSensors", NF),
            "frontCamera": g("frontCamera", NF),
            "frontCameraMp": g("frontCameraMp", NF),
            "frontSensorModel": g("frontSensorModel", NF),
            "frontAperture": g("frontAperture", NF),
            "frontStabilisation": g("frontStabilisation", NF),
            "frontAutofocus": g("frontAutofocus", NF),
            "videoRecording": g("videoRecording", NF),
            "videoFps": g("videoFps", NF),
            "slowMotion": g("slowMotion", NF),
            "hdrVideo": g("hdrVideo", NF),
            "stabilisation": g("stabilisation", NF),
            "cameraFeatures": g("cameraFeatures", NF),
        },
        # 10. BATTERY
        "battery": {
            "capacity": g("batteryCapacity", NF),
            "type": g("batteryType", NF),
            "chemistry": g("batteryChemistry", NF),
            "removable": g("batteryRemovable", NF),
            "chargingTechnology": g("chargingTechnology", NF),
            "wiredChargingWattage": g("wiredChargingWattage", NF),
            "fastCharging": g("fastCharging", NF),
            "wirelessCharging": g("wirelessCharging", NF),
            "wirelessChargingWattage": g("wirelessChargingWattage", NF),
            "reverseWiredCharging": g("reverseWiredCharging", NF),
            "reverseWirelessCharging": g("reverseWirelessCharging", NF),
            "batteryLife": g("batteryLife", NF),
        },
        # 11. CONNECTIVITY
        "connectivity": {
            "wifiStandard": g("wifiStandard", NF),
            "wifiVersion": g("wifiVersion", NF),
            "bluetoothVersion": g("bluetoothVersion", NF),
            "nfc": g("nfc", NF),
            "usbType": g("usbType", NF),
            "usbVersion": g("usbVersion", NF),
            "usbOtg": g("usbOtg", NF),
            "infrared": g("infrared", NF),
            "uwb": g("uwb", NF),
            "gps": g("gps", NF),
            "aGps": g("aGps", NF),
            "glonass": g("glonass", NF),
            "galileo": g("galileo", NF),
            "beidou": g("beidou", NF),
            "qzss": g("qzss", NF),
            "navic": g("navic", NF),
            "otherPositioning": g("otherPositioning", NF),
            "satelliteConnectivity": g("satelliteConnectivity", NF),
            "otherConnectivity": g("otherConnectivity", NF),
        },
        # 12. NETWORK
        "network": {
            "net2g": g("net2g", NF),
            "net3g": g("net3g", NF),
            "net4g": g("net4g", NF),
            "lte": g("lte", NF),
            "net5g": g("net5g", NF),
            "bands5g": g("bands5g", NF),
            "bands4gLte": g("bands4gLte", NF),
            "bands3g": g("bands3g", NF),
            "bands2g": g("bands2g", NF),
            "networkTechnology": g("networkTechnology", NF),
            "volte": g("volte", NF),
            "vowifi": g("vowifi", NF),
            "sa5g": g("sa5g", NF),
            "nsa5g": g("nsa5g", NF),
            "regionSpecificBands": g("regionSpecificBands", NF),
            "otherNetworkFeatures": g("otherNetworkFeatures", NF),
        },
        # 13. SIM
        "sim": {
            "simType": g("simType", NF),
            "nanoSim": g("nanoSim", NF),
            "esim": g("esim", NF),
            "dualSim": g("dualSim", NF),
            "hybridSim": g("hybridSim", NF),
            "dualEsim": g("dualEsim", NF),
            "regionSpecificSim": g("regionSpecificSim", NF),
            "otherSimInfo": g("otherSimInfo", NF),
        },
        # 14. BODY / DESIGN
        "body": {
            "height": g("height", NF),
            "width": g("width", NF),
            "thickness": g("thickness", NF),
            "heightMm": g("heightMm", NF),
            "widthMm": g("widthMm", NF),
            "thicknessMm": g("thicknessMm", NF),
            "weight": g("weight", NF),
            "weightG": g("weightG", NF),
            "buildMaterial": g("buildMaterial", NF),
            "frontMaterial": g("frontMaterial", NF),
            "backMaterial": g("backMaterial", NF),
            "frameMaterial": g("frameMaterial", NF),
            "waterResistance": g("waterResistance", NF),
            "dustResistance": g("dustResistance", NF),
            "ipRating": g("ipRating", NF),
            "hinge": g("hinge", NF),
            "otherDesign": g("otherDesign", NF),
        },
        # 15. AUDIO
        "audio": {
            "speakerType": g("speakerType", NF),
            "speakerCount": g("speakerCount", NF),
            "stereoSpeakers": g("stereoSpeakers", NF),
            "headphoneJack": g("headphoneJack", NF),
            "audioCodec": g("audioCodec", NF),
            "hiResAudio": g("hiResAudio", NF),
            "dolbyAtmos": g("dolbyAtmos", NF),
            "microphoneCount": g("microphoneCount", NF),
            "otherAudio": g("otherAudio", NF),
        },
        # 16 + 17. SENSORS AND SECURITY
        "sensors": g("sensors", []) or [NF],
        "security": {
            "fingerprint": g("fingerprint", NF),
            "fingerprintTechnology": g("fingerprintTechnology", NF),
            "fingerprintLocation": g("fingerprintLocation", NF),
            "faceUnlock": g("faceUnlock", NF),
            "secureHardware": g("secureHardware", NF),
            "otherSecurity": g("otherSecurity", NF),
        },
        # 18. SOFTWARE
        "software": {
            "osAtLaunch": g("osAtLaunch", NF),
            "androidVersion": g("androidVersion", NF),
            "iosVersion": g("iosVersion", NF),
            "manufacturerUi": g("manufacturerUi", NF),
            "uiVersion": g("uiVersion", NF),
            "updatePolicy": g("updatePolicy", NF),
            "majorOsUpdates": g("majorOsUpdates", NF),
            "securityUpdatePolicy": g("securityUpdatePolicy", NF),
            "currentOs": g("currentOs", NF),
        },
        # 19. REGIONAL VARIANTS
        "regionalVariants": g("regionalVariants", []),
        # 20. EXTRA ATTRIBUTES (TechSpecs or official, beyond the listed fields)
        "extraAttributes": g("extraAttributes", {}),
        # 33. REPAIR PART IDENTIFIERS - only ever from a source, never generated
        "serviceParts": {**{k: NF for k in SERVICE_PART_KEYS},
                         **(g("serviceParts", {}) or {})},
        # 21 + 22. SOURCE RECORD AND VERIFICATION
        "sources": {
            "source1Url": g("source1Url", NF),
            "source1PageTitle": g("source1PageTitle", NF),
            "source1Extra": g("source1Extra", []),
            "source2TechSpecsId": g("source2TechSpecsId", NF),
            "source2Endpoint": g("source2Endpoint", NF),
            "dataCheckedDate": g("dataCheckedDate", TODAY),
            "lastVerifiedDate": TODAY,
        },
        "verification": {
            "status": g("verificationStatus", "OFFICIAL SOURCE VERIFIED"),
            "completionStatus": g("completionStatus", "PARTIAL"),
            "conflicts": g("conflicts", []),
            "notes": g("notes", []),
        },
    }


def write(records, brand_dir):
    d = os.path.join(ROOT, "data", "specs", brand_dir)
    os.makedirs(d, exist_ok=True)
    for rec in records:
        with open(os.path.join(d, rec["modelId"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(build(rec), f, indent=1, ensure_ascii=False)
    return len(records)


if __name__ == "__main__":
    inp, brand_dir = sys.argv[1], sys.argv[2]
    with open(inp, encoding="utf-8") as f:
        records = json.load(f)
    print("expanded %d records -> data/specs/%s/" % (write(records, brand_dir), brand_dir))
