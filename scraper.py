import json
import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime
import os
import time

# --- CONFIGURATION ---
KEYWORDS = [
    "flood", "emergency", "evacuation", "closure", "high water", 
    "storm", "severe", "warning", "watch", "resolution", "state of emergency"
]

# Census API: AIANNHA = American Indian/Alaska Native/Native Hawaiian Areas
# We request 'geojson' format to get the polygon shape.
CENSUS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/0/query"

SOURCES = [
    { "name": "Snoqualmie Tribe", "feed": "https://snoqualmietribe.us/feed/", "search_name": "Snoqualmie" },
    { "name": "Lummi Nation", "url": "https://www.lummi-nsn.gov", "feed": "", "search_name": "Lummi" },
    { "name": "Makah Tribe", "feed": "https://makah.com/feed/", "search_name": "Makah" },
    { "name": "Yakama Nation", "feed": "https://www.yakama.com/feed/", "search_name": "Yakama" },
    { "name": "Colville Tribes", "feed": "", "url": "https://www.colvilletribes.com", "search_name": "Colville" }
]

# --- HELPER FUNCTIONS ---

def get_census_geometry(tribe_name_fragment):
    """
    Queries Census API for the actual Polygon Shape (GeoJSON) of the reservation.
    """
    try:
        params = {
            "where": f"NAME LIKE '%{tribe_name_fragment}%'",
            "outFields": "NAME",
            "returnGeometry": "true",
            "f": "geojson",  # Critical: Get the Shape, not just text
            "outSR": "4326"  # Output in WGS84 (Lat/Lng)
        }
        resp = requests.get(CENSUS_URL, params=params, timeout=15)
        data = resp.json()
        
        if data.get("features"):
            print(f"  [Geo] Found boundary shape for {data['features'][0]['properties']['NAME']}")
            # Return the full geometry object (Polygon/MultiPolygon)
            return data["features"][0]["geometry"]
            
    except Exception as e:
        print(f"  [Geo] Failed lookup for {tribe_name_fragment}: {e}")
    
    return None

def extract_full_text(url):
    """Extracts full article text for the PDF report."""
    if not url: return "No URL provided."
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (TribalDash/1.0)'}
        resp = requests.get(url, headers=headers, timeout=10)
        soup = BeautifulSoup(resp.content, 'html.parser')
        
        # Try finding the main content area common in WordPress/Tribal sites
        content = soup.find('div', class_='entry-content') or \
                  soup.find('div', class_='post-content') or \
                  soup.find('article')
        
        if content:
            return content.get_text(separator='\n\n', strip=True)
            
        return "Full text could not be extracted automatically. Please click Source."
    except:
        return "Description unavailable."

# --- MAIN ENGINE ---

def main():
    print("--- Starting Shape-Aware Scraper ---")
    all_alerts = []

    for source in SOURCES:
        print(f"Scanning {source['name']}...")
        
        # 1. RSS Strategy
        if source.get("feed"):
            try:
                feed = feedparser.parse(source["feed"])
                for entry in feed.entries[:3]:
                    blob = (entry.title + " " + entry.description).lower()
                    if any(kw in blob for kw in KEYWORDS):
                        print(f"  > Hit: {entry.title}")
                        
                        # Fetch the Shape
                        geometry = get_census_geometry(source["search_name"])
                        full_text = extract_full_text(entry.link)
                        
                        all_alerts.append({
                            "id": f"{source['search_name']}-{int(time.time())}",
                            "title": entry.title,
                            "type": "Tribal Declaration",
                            "severity": "Severe",
                            "desc": full_text,
                            "link": entry.link,
                            "geometry": geometry, # This is the Polygon!
                            "date": datetime.now().strftime("%Y-%m-%d")
                        })
            except Exception as e:
                print(f"  Feed Error: {e}")

    # Save to JSON
    os.makedirs("data", exist_ok=True)
    with open("data/updates.json", "w") as f:
        json.dump(all_alerts, f, indent=2)
    
    print(f"--- Done. Saved {len(all_alerts)} alerts with shapes. ---")

if __name__ == "__main__":
    main()
