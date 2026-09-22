import requests
import json
from pathlib import Path
from datetime import datetime

class PolygonExporter:
    def __init__(self, base_url="https://thepolygon.ca", output_dir="./polygon_export"):
        self.base_url = base_url
        self.api_url = f"{base_url}/wp-json/wp/v2"
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
    
    def get_all_posts(self, post_type='posts'):
        """Fetch all posts/pages from WordPress REST API"""
        all_items = []
        page = 1
        
        while True:
            url = f"{self.api_url}/{post_type}?per_page=100&page={page}"
            print(f"Fetching {post_type} page {page}...")
            
            response = requests.get(url)
            
            if response.status_code != 200:
                break
            
            items = response.json()
            if not items:
                break
            
            all_items.extend(items)
            page += 1
        
        return all_items
    
    def export_all(self):
        """Export all WordPress content"""
        print("Exporting from WordPress REST API...\n")
        
        data = {
            'exported_at': datetime.now().isoformat(),
            'site_url': self.base_url,
            'posts': self.get_all_posts('posts'),
            'pages': self.get_all_posts('pages'),
        }
        
        # Save to JSON
        output_file = self.output_dir / 'polygon_full_export.json'
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        print(f"\n✓ Export complete!")
        print(f"✓ Saved to {output_file}")
        print(f"\nData summary:")
        print(f"  - {len(data['posts'])} posts")
        print(f"  - {len(data['pages'])} pages")

if __name__ == "__main__":
    exporter = PolygonExporter(output_dir="./polygon_export")
    exporter.export_all()