import json
import requests
import feedparser
from bs4 import BeautifulSoup
from datetime import datetime
import os
import time
import re

# --- CONFIGURATION ---
KEYWORDS = [
    "flood", "emergency", "evacuation", "closure", "high water", 
    "storm", "severe", "warning", "watch", "resolution", "state of emergency"
]

CENSUS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/AIANNHA/MapServer/0/query"

SOURCES = [
    { "name": "Snoqualmie Tribe", "feed": "https://snoqualmietribe.us/feed/", "search_name": "Snoqualmie" },
    { "name": "Lummi Nation", "url": "https://www.lummi-nsn.gov", "feed": "", "search_name": "Lummi" },
    { "name": "Makah Tribe", "feed": "https://makah.com/feed/", "search_name": "Makah" },
    { "name": "Yakama Nation", "feed": "https://www.yakama.com/feed/", "search_name": "Yakama" }
]

# --- HELPER FUNCTIONS ---

def get_census_geometry(tribe_name_fragment):
    """Queries Census API for the actual Polygon Shape (GeoJSON)."""
    try:
        params = {
            "where": f"NAME LIKE '%{tribe_name_fragment}%'",
            "outFields": "NAME",
            "returnGeometry": "true",
            "f": "geojson",
            "outSR": "4326"
        }
        resp = requests.get(CENSUS_URL, params=params, timeout=10)
        data = resp.json()
        if data.get("features"):
            return data["features"][0]["geometry"]
    except:
        pass
    return None

def extract_full_text(url):
    """
    Robust extractor that finds the main text block by counting paragraphs.
    This works on almost any news/blog site.
    """
    if not url: return "No URL provided."
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        resp = requests.get(url, headers=headers, timeout=15)
        soup = BeautifulSoup(resp.content, 'html.parser')

        # Cleanup: Remove scripts, styles, nav, footer
        for script in soup(["script", "style", "nav", "footer", "header", "iframe"]):
            script.extract()

        # Strategy 1: Look for specific "Article Body" classes common in WordPress
        # Snoqualmie uses 'entry-content'
        target = soup.find('div', class_='entry-content') or \
                 soup.find('article') or \
                 soup.find('div', class_='post-content') or \
                 soup.find('main')

        if target:
            # Get text, preserving newlines for readability
            text = target.get_text(separator='\n\n', strip=True)
            # Basic cleanup of "Share this" links often found at bottom
            text = re.split(r'Share this:|Related Posts:', text)[0]
            return text

        # Strategy 2 (Fallback): Find the <div> with the most <p> tags
        max_p = 0
        best_div = None
        for div in soup.find_all('div'):
            p_count = len(div.find_all('p', recursive=False))
            if p_count > max_p:
                max_p = p_count
                best_div = div
        
        if best_div and max_p > 2:
            return best_div.get_text(separator='\n\n', strip=True)

        return "Could not automatically extract text. Please view source link."

    except Exception as e:
        print(f"Extraction Error for {url}: {e}")
        return "Error loading full text."

# --- MAIN ENGINE ---

def main():
    print("--- Starting Robust Scraper ---")
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
                        
                        full_text = extract_full_text(entry.link)
                        geometry = get_census_geometry(source["search_name"])
                        
                        all_alerts.append({
                            "id": f"{source['search_name']}-{int(time.time())}",
                            "title": entry.title,
                            "type": "Tribal Declaration",
                            "severity": "Severe",
                            "desc": full_text,  # This now holds the deep scrape
                            "link": entry.link,
                            "geometry": geometry,
                            "date": datetime.now().strftime("%Y-%m-%d")
                        })
            except Exception as e:
                print(f"  Feed Error: {e}")

    # Save to JSON
    os.makedirs("data", exist_ok=True)
    with open("data/updates.json", "w") as f:
        json.dump(all_alerts, f, indent=2)
    
    print(f"--- Done. Saved {len(all_alerts)} alerts. ---")

if __name__ == "__main__":
    main()
