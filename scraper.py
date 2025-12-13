import json
import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime
import os
import time

# --- 1. CONFIGURATION ---

# MANUAL ENTRIES (Add State/County/City here manually if needed)
MANUAL_ALERTS = [
    {
        "id": "wa-state-manual-01",
        "title": "Washington State: State of Emergency",
        "type": "State", 
        "severity": "Severe",
        "desc": "Governor Inslee declares State of Emergency for all 39 counties due to severe winter storms.",
        "link": "https://governor.wa.gov",
        "search_name": "Washington", # Finds shape in Census
        "lat": 47.5, "lng": -120.5 # Fallback
    },
    {
        "id": "king-co-manual-01",
        "title": "King County: Flood Warning",
        "type": "County",
        "severity": "Severe",
        "desc": "Snoqualmie River at Phase 4. Evacuations in effect for lower valley.",
        "link": "https://kingcounty.gov",
        "search_name": "King",
        "lat": 47.4, "lng": -121.8
    }
]

# AUTOMATED FEEDS
SOURCES = [
    { "name": "Snoqualmie Tribe", "feed": "https://snoqualmietribe.us/feed/", "search_name": "Snoqualmie", "type": "Tribal" },
    { "name": "Lummi Nation", "url": "https://www.lummi-nsn.gov", "search_name": "Lummi", "type": "Tribal" },
    { "name": "Makah Tribe", "feed": "https://makah.com/feed/", "search_name": "Makah", "type": "Tribal" }
]

KEYWORDS = ["flood", "emergency", "evacuation", "closure", "warning", "proclamation"]
CENSUS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/0/query"

# --- 2. ENGINE ---

def get_census_geometry(name_fragment):
    # (Same geo logic as before, just works for checking names)
    return None # Simplified for brevity, map handles fallbacks

def extract_full_text(url):
    try:
        resp = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=10)
        soup = BeautifulSoup(resp.content, 'html.parser')
        # Simple extraction
        paragraphs = soup.find_all('p')
        text = "\n\n".join([p.text for p in paragraphs if len(p.text) > 40])
        return text[:3000]
    except: return "Details unavailable."

def main():
    all_alerts = []

    # Process Manual
    for item in MANUAL_ALERTS:
        item['date'] = datetime.now().strftime("%Y-%m-%d")
        all_alerts.append(item)

    # Process Feeds
    for source in SOURCES:
        if source.get("feed"):
            try:
                feed = feedparser.parse(source["feed"])
                for entry in feed.entries[:2]:
                    if any(k in (entry.title+entry.description).lower() for k in KEYWORDS):
                        text = extract_full_text(entry.link)
                        all_alerts.append({
                            "id": f"{source['name']}-{int(time.time())}",
                            "title": entry.title,
                            "type": source['type'], # Tribal, State, etc
                            "severity": "Severe",
                            "desc": text,
                            "link": entry.link,
                            "date": datetime.now().strftime("%Y-%m-%d")
                        })
            except: pass

    os.makedirs("data", exist_ok=True)
    with open("data/updates.json", "w") as f:
        json.dump(all_alerts, f, indent=2)

if __name__ == "__main__":
    main()
