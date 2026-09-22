import requests
from bs4 import BeautifulSoup
import json
from pathlib import Path
from datetime import datetime
import time

class PolygonScraper:
    def __init__(self, base_url="https://thepolygon.ca", output_dir="./polygon_export"):
        self.base_url = base_url
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        })
    
    def fetch_page(self, url):
        """Fetch a page and return BeautifulSoup object"""
        try:
            response = self.session.get(url, timeout=10)
            response.raise_for_status()
            return BeautifulSoup(response.content, 'html.parser')
        except requests.exceptions.RequestException as e:
            print(f"Error fetching {url}: {e}")
            return None
    
    def scrape_exhibitions(self):
        """Scrape current and upcoming exhibitions"""
        print("Scraping exhibitions...")
        exhibitions = []
        
        # On Now exhibitions
        soup = self.fetch_page(f"{self.base_url}/exhibitions/listing/")
        if soup:
            # Find exhibition cards
            exhibit_cards = soup.find_all('div', class_='exhibition-item')
            
            for card in exhibit_cards:
                link = card.find('a')
                if link:
                    title = link.get_text(strip=True)
                    url = link.get('href')
                    
                    # Get exhibition detail page
                    detail_soup = self.fetch_page(url)
                    if detail_soup:
                        # Extract dates
                        date_text = detail_soup.find('div', class_='exhibition-dates')
                        dates = date_text.get_text(strip=True) if date_text else ""
                        
                        # Extract description
                        description_elem = detail_soup.find('div', class_='exhibition-description')
                        description = description_elem.get_text(strip=True) if description_elem else ""
                        
                        # Extract images
                        image_elem = detail_soup.find('img', class_='exhibition-image')
                        image_url = image_elem.get('src') if image_elem else ""
                        
                        exhibitions.append({
                            'title': title,
                            'url': url,
                            'dates': dates,
                            'description': description,
                            'image': image_url
                        })
                    
                    time.sleep(0.5)  # Be polite to the server
        
        return exhibitions
    
    def scrape_events(self):
        """Scrape upcoming events"""
        print("Scraping events...")
        events = []
        
        soup = self.fetch_page(f"{self.base_url}/engagement/events/")
        if soup:
            # Find event items
            event_items = soup.find_all('div', class_='event-item')
            
            for item in event_items:
                title_elem = item.find('h3')
                title = title_elem.get_text(strip=True) if title_elem else ""
                
                # Get date/time
                date_elem = item.find('div', class_='event-date')
                event_date = date_elem.get_text(strip=True) if date_elem else ""
                
                # Get description
                desc_elem = item.find('p')
                description = desc_elem.get_text(strip=True) if desc_elem else ""
                
                # Get link
                link = item.find('a')
                url = link.get('href') if link else ""
                
                events.append({
                    'title': title,
                    'date': event_date,
                    'description': description,
                    'url': url
                })
                
                time.sleep(0.3)
        
        return events
    
    def scrape_news(self):
        """Scrape news items"""
        print("Scraping news...")
        news = []
        
        soup = self.fetch_page(f"{self.base_url}/gallery/news/")
        if soup:
            # Find news items
            news_items = soup.find_all('article')
            
            for article in news_items[:20]:  # Limit to first 20
                title_elem = article.find('h2')
                title = title_elem.get_text(strip=True) if title_elem else ""
                
                # Get date
                date_elem = article.find('time')
                pub_date = date_elem.get_text(strip=True) if date_elem else ""
                
                # Get excerpt
                excerpt_elem = article.find('p')
                excerpt = excerpt_elem.get_text(strip=True) if excerpt_elem else ""
                
                # Get link
                link = article.find('a')
                url = link.get('href') if link else ""
                
                news.append({
                    'title': title,
                    'date': pub_date,
                    'excerpt': excerpt,
                    'url': url
                })
                
                time.sleep(0.3)
        
        return news
    
    def scrape_general_info(self):
        """Scrape general gallery info"""
        print("Scraping general information...")
        info = {}
        
        soup = self.fetch_page(self.base_url)
        if soup:
            # Gallery description
            desc_elem = soup.find('div', class_='gallery-description')
            info['description'] = desc_elem.get_text(strip=True) if desc_elem else ""
            
            # Gallery hours
            hours_elem = soup.find('div', class_='gallery-hours')
            info['hours'] = hours_elem.get_text(strip=True) if hours_elem else ""
            
            # Contact/address
            address_elem = soup.find('div', class_='gallery-address')
            info['address'] = address_elem.get_text(strip=True) if address_elem else ""
        
        return info
    
    def scrape_all(self):
        """Scrape all content and save to JSON"""
        print("Starting Polygon.ca scrape...\n")
        
        data = {
            'scraped_at': datetime.now().isoformat(),
            'site_url': self.base_url,
            'general_info': self.scrape_general_info(),
            'exhibitions': self.scrape_exhibitions(),
            'events': self.scrape_events(),
            'news': self.scrape_news()
        }
        
        # Save to JSON
        output_file = self.output_dir / 'polygon_data.json'
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        print(f"\n✓ Scrape complete!")
        print(f"✓ Saved to {output_file}")
        print(f"\nData summary:")
        print(f"  - {len(data['exhibitions'])} exhibitions")
        print(f"  - {len(data['events'])} events")
        print(f"  - {len(data['news'])} news items")
        
        return data

# Run the scraper
if __name__ == "__main__":
    scraper = PolygonScraper(output_dir="./polygon_export")
    scraper.scrape_all()