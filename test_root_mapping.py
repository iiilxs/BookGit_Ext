import json

# Simulate remote data structure (the old format with non-standard IDs)
remote = json.loads('''{
  "roots": {
    "1": {"title": "收藏夹栏", "children": []},
    "163": {"title": "其他收藏夹", "children": []},
    "167": {"title": "移动收藏夹", "children": []}
  }
}''')

print("=== 旧代码：按 key 匹配固定 ID ===")
local_ids = {"1", "2", "3"}
for key in remote["roots"]:
    matched = key in local_ids
    print(f"  key={key} → 匹配本地根: {matched}")

print()
print("=== 新代码：按 values 顺序索引映射 ===")
chrome_roots = ["书签栏", "其他书签", "移动设备书签"]
for i, (key, val) in enumerate(remote["roots"].items()):
    matched = i < len(chrome_roots)
    ct = chrome_roots[i] if matched else "N/A"
    print(f"  index={i} key={key} title=\"{val['title']}\" → 匹配本地根[{i}]=\"{ct}\": {matched}")

print()
print("结论：新代码可以正确映射所有三个根文件夹，不受 key 名影响。")
