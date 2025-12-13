import json
import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime
import os
import time

# --- CONFIGURATION ---

# 1. MANUAL OVERRIDES (Guaranteed Data)
# I pasted your Snoqualmie text here so it ALWAYS shows up.
MANUAL_ALERTS = [
    {
        "id": "snoq-manual-2025",
        "title": "Snoqualmie Tribal Council Declares State of Emergency",
        "type": "Tribal Declaration",
        "severity": "Severe",
        "link": "https://snoqualmietribe.us/snoqualmie-tribal-council-passes-motion-to-approve-resolution-345-2025-declaring-a-tribal-state-of-emergency-related-to-flooding/",
        "search_name": "Snoqualmie", # Used to find map shape
        "desc": """Snoqualmie Tribal Council Passes Motion to Approve Resolution #345-2025 Declaring a Tribal State of Emergency Related to Flooding.

In an emergency Council Meeting, Tribal Council passed the following motions:

1. Motion to close Tribal Campus for the rest of this week due to the Tribal State of Emergency.
2. Motion to direct the Snoqualmie Casino CEO to hold half of available rooms for Tribal Members/Staff.
3. Motion directing Columbia Hospitality to hold rooms at Salish Lodge & Spa.
4. Motion to allow vehicle parking at Tribal Government Campus.
5. Motion to cancel the 2025 Snoqualmie Tribal Christmas Party.
6. Motion to allow access to Tribal Emergency Disaster Relief for safe lodging.

Tribal Members needing non-emergency assistance can call 425-765-6623. For emergency assistance, please call 911."""
    }
]

# 2. AUTOMATED SOURCES
SOURCES = [
    { "name": "Lummi Nation", "url": "https://www.lummi-nsn.gov", "search_name": "Lummi" },
    { "name": "Makah Tribe", "feed": "https://makah.com/feed/", "search_name": "Makah" },
    { "name": "Yakama Nation", "feed": "https://www.yakama.com/feed/", "search_name": "Yakama" }
]

KEYWORDS = ["flood", "emergency", "evacuation", "closure", "high water", "storm", "severe", "warning", "watch", "resolution"]
CENSUS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/0/query"

# --- HELPER FUNCTIONS ---

def get_census_geometry(tribe_name_fragment):
    """
    Finds the official Tribal Boundary Shape (Polygon).
    Returns None if not found (Map will fallback to Point).
    """
    try:
        params = {
            "where": f"NAME LIKE '%{tribe_name_fragment}%'",
            "outFields": "NAME,CENTLAT,CENTLON",
            "returnGeometry": "true",
            "f": "geojson",
            "outSR": "4326"
        }
        resp = requests.get(CENSUS_URL, params=params, timeout=15)
        data = resp.json()
        
        if data.get("features"):
            feat = data["features"][0]
            print(f"  [Geo] Found shape for {feat['properties']['NAME']}")
            return {
                "geometry": feat["geometry"],
                "lat": float(feat['properties']['CENTLAT']),
                "lng": float(feat['properties']['CENTLON'])
            }
    except Exception as e:
        print(f"  [Geo] Shape lookup failed: {e}")
    return None

def extract_full_text(url):
    """Robust text extractor for automated feeds."""
    if not url: return ""
    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        resp = requests.get(url, headers=headers, timeout=10)
        soup = BeautifulSoup(resp.content, 'html.parser')
        
        # Grab all text from the main body
        body = soup.find('div', class_='entry-content') or soup.find('article') or soup.body
        text = body.get_text(separator='\n\n', strip=True)
        return text[:2000] # Limit to avoid huge JSON
    except:
        return "Click Source for details."

# --- MAIN ENGINE ---

def main():
    print("--- Starting Bulletproof Scraper ---")
    all_alerts = []

    # 1. PROCESS MANUAL ALERTS (The "Forced" Ones)
    for item in MANUAL_ALERTS:
        print(f"Processing Manual: {item['title']}")
        geo_data = get_census_geometry(item['search_name'])
        
        alert = item.copy()
        alert['date'] = datetime.now().strftime("%Y-%m-%d")
        
        if geo_data:
            alert['geometry'] = geo_data['geometry']
            alert['lat'] = geo_data['lat']
            alert['lng'] = geo_data['lng']
        else:
            # Fallback coordinates if Census fails
            alert['lat'] = 47.5
            alert['lng'] = -120.5
            
        all_alerts.append(alert)

    # 2. PROCESS AUTOMATED FEEDS
    for source in SOURCES:
        if source.get("feed"):
            try:
                feed = feedparser.parse(source["feed"])
                for entry in feed.entries[:2]:
                    blob = (entry.title + " " + entry.description).lower()
                    if any(kw in blob for kw in KEYWORDS):
                        print(f"  > Auto Hit: {entry.title}")
                        
                        geo_data = get_census_geometry(source['search_name'])
                        full_text = extract_full_text(entry.link)
                        
                        alert = {
                            "id": f"{source['search_name']}-{int(time.time())}",
                            "title": entry.title,
                            "type": "Tribal Declaration",
                            "severity": "Severe",
                            "desc": full_text,
                            "link": entry.link,
                            "date": datetime.now().strftime("%Y-%m-%d")
                        }
                        
                        if geo_data:
                            alert['geometry'] = geo_data['geometry']
                            alert['lat'] = geo_data['lat']
                            alert['lng'] = geo_data['lng']
                            
                        all_alerts.append(alert)
            except Exception as e:
                print(f"Feed error: {e}")

    # SAVE
    os.makedirs("data", exist_ok=True)
    with open("data/updates.json", "w") as f:
        json.dump(all_alerts, f, indent=2)
    print(f"--- Done. Saved {len(all_alerts)} alerts. ---")

if __name__ == "__main__":
    main()
