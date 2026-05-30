"""Check the remote bookmarks.json structure on GitHub."""
import urllib.request, json, base64

TOKEN = "YOUR_TOKEN_HERE"
URL = "https://api.github.com/repos/iiilxs/SHOUCANGJIA/contents/bookmarks.json"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "BookGit-Check"
}

req = urllib.request.Request(URL, headers=HEADERS)
resp = urllib.request.urlopen(req)
data = json.loads(resp.read())

content = base64.b64decode(data["content"]).decode("utf-8")
bookmarks = json.loads(content)
roots = bookmarks.get("roots", {})

print(f"SHA: {data['sha']}")
print(f"Size: {data['size']} bytes")
print(f"Root keys: {list(roots.keys())}")
print()

total = 0
for k, v in roots.items():
    def count_nodes(nodes):
        n = 0
        for c in nodes:
            if "url" in c and c["url"]:
                n += 1
            if "children" in c:
                n += count_nodes(c["children"])
        return n
    cnt = count_nodes(v.get("children", []))
    total += cnt
    print(f"  key={k} title=\"{v.get('title', '?')}\" → {cnt} bookmarks")

print(f"\nTotal bookmarks: {total}")
