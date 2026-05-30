// ============================================================
// BookGit 核心同步引擎 (importScripts 兼容)
// 依赖: chrome.bookmarks, chrome.storage, fetch, crypto.subtle
//
// 三层去重保护:
//   ① 序列化时同文件夹内相同 URL 只保留第一个
//   ② 写入本地时动态更新 skipUrls，同轮同步内不再重复创建
//   ③ 上传到远程前去重，防止污染远程数据
// ============================================================

// ---- 状态 ----
let localModified = false;
let isApplying = false;

// ---- 工具函数 ----

function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64Decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function stripExp(data) {
  const { exported_at, ...rest } = data;
  return JSON.stringify(rest);
}

function countBookmarks(data) {
  let n = 0;
  function walk(nodes) {
    for (const c of nodes) {
      if (c.url) n++;
      if (c.children) walk(c.children);
    }
  }
  for (const rn of Object.values(data.roots || {})) {
    if (rn.children) walk(rn.children);
  }
  return n;
}

// ============================================================
// 去重：全局去重（跨文件夹）
// 整个书签树中相同 URL 只保留第一次出现的条目。
// 后续在所有位置（同文件夹 / 不同文件夹）的同一 URL 均被移除。
// ============================================================

function dedupBookmarksData(data) {
  const result = JSON.parse(JSON.stringify(data));
  const globalSeen = new Set();

  function dedupNode(node) {
    if (!node.children || node.children.length === 0) return;
    const deduped = [];
    for (const child of node.children) {
      if (child.url) {
        if (child.url.startsWith('place:')) continue;
        if (globalSeen.has(child.url)) continue; // 全局已出现 → 移除
        globalSeen.add(child.url);
      }
      // 先递归清理子节点
      dedupNode(child);
      // 跳过空文件夹
      if (!child.url && (!child.children || child.children.length === 0)) continue;
      deduped.push(child);
    }
    node.children = deduped;
  }

  for (const rootNode of Object.values(result.roots || {})) {
    dedupNode(rootNode);
  }
  return result;
}

// ---- 本地书签序列化（含同文件夹 URL 去重）----

function serializeNode(node) {
  const obj = { title: node.title || '' };
  if (node.url) obj.url = node.url;
  if (node.children && node.children.length > 0) {
    const seen = new Set();
    obj.children = [];
    for (const c of node.children) {
      const serialized = serializeNode(c);
      if (serialized.url) {
        if (serialized.url.startsWith('place:')) continue;
        if (seen.has(serialized.url)) continue;
        seen.add(serialized.url);
      }
      obj.children.push(serialized);
    }
  }
  return obj;
}

async function getLocalBookmarks() {
  const [root] = await chrome.bookmarks.getTree();
  const roots = {};
  root.children.forEach((child, index) => {
    roots['root' + index] = serializeNode(child);
  });
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    roots
  };
}

async function getBookmarkStats() {
  const [root] = await chrome.bookmarks.getTree();
  let bookmarks = 0, folders = 0;
  function walk(nodes) {
    for (const n of nodes) {
      if (n.url) bookmarks++; else folders++;
      if (n.children) walk(n.children);
    }
  }
  walk(root.children);
  return { bookmarks, folders };
}

// ---- 应用到本地书签（追加模式，不清除）----

function collectUrlsFromTree(data) {
  const urls = new Set();
  function walk(nodes) {
    for (const n of nodes) {
      if (n.url) urls.add(n.url);
      if (n.children) walk(n.children);
    }
  }
  for (const rn of Object.values(data.roots || {})) {
    if (rn.children) walk(rn.children);
  }
  return urls;
}

function hasNewContent(nodes, skipUrls) {
  for (const n of nodes) {
    if (n.url && !skipUrls.has(n.url)) return true;
    if (n.children && hasNewContent(n.children, skipUrls)) return true;
  }
  return false;
}

/**
 * 递归创建缺失的书签树（追加）。
 * ① 每个 URL 创建后立即加入 skipUrls，同轮同步内不再重复。
 * ② 只创建本地完整 URL 集合中尚不存在的条目。
 */
async function createMissingTree(parentId, nodes, skipUrls) {
  let created = 0;
  let existingChildren;
  try { existingChildren = await chrome.bookmarks.getChildren(parentId); } catch { existingChildren = []; }

  for (const node of nodes) {
    try {
      if (node.url && node.url.startsWith('place:')) continue;

      if (node.url) {
        if (skipUrls.has(node.url)) continue;
        await chrome.bookmarks.create({ parentId, title: node.title || '', url: node.url });
        skipUrls.add(node.url);  // ★ 动态去重：实时加入已创建集合
        created++;
      } else {
        if (!node.children || node.children.length === 0) continue;
        if (!hasNewContent(node.children, skipUrls)) continue;
        const match = existingChildren.find(c => !c.url && c.title === node.title);
        if (match) {
          created += await createMissingTree(match.id, node.children, skipUrls);
        } else {
          const result = await chrome.bookmarks.create({ parentId, title: node.title || '' });
          created++;
          created += await createMissingTree(result.id, node.children, skipUrls);
        }
      }
    } catch (e) {
      console.warn('BookGit: skip', node?.title, e?.message);
    }
  }
  return created;
}

function resolveRootFor(index, chromeRoots) {
  if (index >= 0 && index < chromeRoots.length) return chromeRoots[index];
  return null;
}

async function applyRemoteBookmarks(data) {
  isApplying = true;
  let totalCreated = 0;
  try {
    const cleanData = dedupBookmarksData(data);   // ★ 下载前去重
    const [root] = await chrome.bookmarks.getTree();
    const chromeRoots = root.children;
    const localUrls = collectUrlsFromTree({ roots: chromeRoots });

    const remoteRoots = Object.values(cleanData.roots || {});
    for (let i = 0; i < remoteRoots.length; i++) {
      const actualRoot = resolveRootFor(i, chromeRoots);
      if (!actualRoot) continue;
      if (remoteRoots[i].children && remoteRoots[i].children.length > 0) {
        totalCreated += await createMissingTree(actualRoot.id, remoteRoots[i].children, localUrls);
      }
    }
  } finally {
    isApplying = false;
  }
  return totalCreated;
}

// ---- 合并 ----
// 以 base 为基准，追加 other 中有但 base 没有的书签（按 URL 去重）

function mergeTrees(local, remote) {
  if (JSON.stringify(local) === JSON.stringify(remote)) return local;

  const localUrls = new Set();
  function collect(nodes) {
    for (const n of nodes) {
      if (n.url) localUrls.add(n.url);
      if (n.children) collect(n.children);
    }
  }
  for (const rootNode of Object.values(local.roots || {})) {
    if (rootNode.children) collect(rootNode.children);
  }

  const newBookmarks = [];
  function findNew(nodes, parentTitle) {
    for (const n of nodes) {
      if (n.url && !localUrls.has(n.url)) {
        newBookmarks.push({ title: n.title, url: n.url, parent: parentTitle });
      }
      if (n.children) findNew(n.children, n.title);
    }
  }
  for (const rootNode of Object.values(remote.roots || {})) {
    if (rootNode.children) findNew(rootNode.children, rootNode.title);
  }

  const merged = JSON.parse(JSON.stringify(local));
  merged.exported_at = new Date().toISOString();

  for (const nb of newBookmarks) {
    for (const rootNode of Object.values(merged.roots)) {
      if (rootNode.title === nb.parent) {
        if (!rootNode.children) rootNode.children = [];
        rootNode.children.push({ title: nb.title, url: nb.url });
        break;
      }
    }
  }
  return merged;
}

// ---- GitHub API ----

async function githubRequest(config, method, path, body) {
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${config.token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BookGit/1.0'
  };
  const opts = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: resp.status, ok: resp.ok, json, text };
}

async function fetchRemote(config) {
  const path = `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(config.path)}`;
  const r = await githubRequest(config, 'GET', path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${r.status}: ${r.text}`);
  return {
    data: JSON.parse(base64Decode(r.json.content)),
    sha: r.json.sha
  };
}

async function pushRemote(config, data, existingSha) {
  const path = `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(config.path)}`;
  const body = {
    message: `BookGit sync ${new Date().toISOString()}`,
    content: base64Encode(JSON.stringify(data, null, 2)),
    branch: config.branch || 'main'
  };
  if (existingSha) body.sha = existingSha;
  const r = await githubRequest(config, 'PUT', path, body);
  if (!r.ok) throw new Error(`GitHub PUT ${r.status}: ${r.text}`);
  return r.json.content.sha;
}

// ---- 全覆盖写入（用于下载模式）----

async function createFullTree(parentId, nodes) {
  let created = 0;
  let existingChildren;
  try { existingChildren = await chrome.bookmarks.getChildren(parentId); } catch { existingChildren = []; }

  for (const node of nodes) {
    try {
      if (node.url && node.url.startsWith('place:')) continue;

      if (node.url) {
        // 仅按 URL 匹配（不要求标题一致）避免同 URL 不同标题导致重复
        const match = existingChildren.find(c => c.url === node.url);
        if (match) continue;
        await chrome.bookmarks.create({ parentId, title: node.title || '', url: node.url });
        created++;
      } else {
        if (!node.children || node.children.length === 0) continue;
        const match = existingChildren.find(c => !c.url && c.title === node.title);
        if (match) {
          created += await createFullTree(match.id, node.children);
        } else {
          const result = await chrome.bookmarks.create({ parentId, title: node.title || '' });
          created++;
          created += await createFullTree(result.id, node.children);
        }
      }
    } catch (e) {
      console.warn('BookGit: skip', node?.title, e?.message);
    }
  }
  return created;
}

async function replaceLocalBookmarks(data) {
  isApplying = true;
  let totalCreated = 0;
  try {
    const cleanData = dedupBookmarksData(data);  // ★ 替换前去重
    const [root] = await chrome.bookmarks.getTree();
    const chromeRoots = root.children;
    const remoteRoots = Object.values(cleanData.roots || {});
    for (let i = 0; i < remoteRoots.length; i++) {
      const actualRoot = resolveRootFor(i, chromeRoots);
      if (!actualRoot) continue;
      const children = await chrome.bookmarks.getChildren(actualRoot.id);
      for (const child of children) {
        try { await chrome.bookmarks.removeTree(child.id); } catch {}
      }
      if (remoteRoots[i].children && remoteRoots[i].children.length > 0) {
        totalCreated += await createFullTree(actualRoot.id, remoteRoots[i].children);
      }
    }
  } finally {
    isApplying = false;
  }
  return totalCreated;
}

// ---- 注册本地变更监听 ----

function registerListeners() {
  chrome.bookmarks.onCreated.addListener(() => { if (!isApplying) localModified = true; });
  chrome.bookmarks.onChanged.addListener(() => { if (!isApplying) localModified = true; });
  chrome.bookmarks.onRemoved.addListener(() => { if (!isApplying) localModified = true; });
  chrome.bookmarks.onMoved.addListener(() => { if (!isApplying) localModified = true; });
}

// ---- 主同步函数（三种模式）----

async function sync(mode) {
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.token || !config.owner || !config.repo) {
    return { status: 'error', message: '未配置' };
  }

  try {
    const rawLocal = await getLocalBookmarks();
    const localData = dedupBookmarksData(rawLocal);  // ★ 以去重后数据为准
    const localCount = countBookmarks(localData);
    const localChecksum = await sha256(stripExp(localData));

    const remote = await fetchRemote(config);

    // ---- 首次同步：直接上传（先去重）----
    if (!remote) {
      const cleanLocal = dedupBookmarksData(localData);
      const cleanCount = countBookmarks(cleanLocal);
      const cleanChecksum = await sha256(stripExp(cleanLocal));
      await pushRemote(config, cleanLocal, null);
      await chrome.storage.local.set({ lastSyncChecksum: cleanChecksum, lastSyncTime: Date.now() });
      localModified = false;
      return { status: 'success', message: `首次同步完成（${cleanCount} 个书签已上传）`, count: cleanCount };
    }

    // ★ 远程数据也先去重再比较
    const remoteData = dedupBookmarksData(remote.data);
    const remoteCount = countBookmarks(remoteData);
    const remoteChecksum = await sha256(stripExp(remoteData));

    // ==================== 上传模式（总是执行）====================
    if (mode === 'upload') {
      const cleanLocal = dedupBookmarksData(localData);
      const cleanCount = countBookmarks(cleanLocal);
      await pushRemote(config, cleanLocal, remote.sha);
      const newChecksum = await sha256(stripExp(cleanLocal));
      await chrome.storage.local.set({ lastSyncChecksum: newChecksum, lastSyncTime: Date.now() });
      localModified = false;
      return { status: 'success', message: `已上传到远程（${cleanCount} 个书签）`, count: cleanCount };
    }

    // ==================== 下载模式（总是执行）====================
    if (mode === 'download') {
      const createdCount = await replaceLocalBookmarks(remote.data);
      const verify = await getBookmarkStats();
      const newChecksum = await sha256(stripExp(remoteData));
      await chrome.storage.local.set({ lastSyncChecksum: newChecksum, lastSyncTime: Date.now() });
      localModified = false;
      const detail = `（书签 ${verify.bookmarks} 个，文件夹 ${verify.folders} 个）`;
      return { status: 'success', message: `已从远程下载${detail}`, createdCount, count: verify.bookmarks };
    }

    // ==================== 智能合并 ====================
    // ---- 两边一致（仅合并模式可走快捷路径）----
    if (localChecksum === remoteChecksum) {
      return { status: 'success', message: `已是最新（${localCount} 个书签）`, count: localCount };
    }
    const remoteUrls = collectUrlsFromTree(remoteData);
    const localUrls = collectUrlsFromTree(localData);
    const needDownload = [...remoteUrls].some(u => !localUrls.has(u));
    const needUpload = [...localUrls].some(u => !remoteUrls.has(u));

    let addedCount = 0;
    if (needDownload) {
      addedCount = await applyRemoteBookmarks(remoteData);
    }

    let afterCount = -1;
    if (needDownload) {
      const verify = await getBookmarkStats();
      afterCount = verify.bookmarks;
    }

    // ★ 上传前用去重后的本地书签，避免污染远程
    if (needUpload) {
      const rawLocalNow = await getLocalBookmarks();
      const cleanLocalNow = dedupBookmarksData(rawLocalNow);
      await pushRemote(config, cleanLocalNow, remote.sha);
    }

    const finalLocal = await getLocalBookmarks();
    const newChecksum = await sha256(stripExp(dedupBookmarksData(finalLocal)));
    await chrome.storage.local.set({ lastSyncChecksum: newChecksum, lastSyncTime: Date.now() });
    localModified = false;

    let msg;
    if (needDownload && needUpload) {
      msg = `已双向同步（本地 +${addedCount}，同步至远程）`;
    } else if (needDownload) {
      msg = `已从远程同步（✓ ${afterCount} 个书签）`;
    } else {
      msg = `已上传到远程（${localCount} 个书签）`;
    }
    return { status: 'success', message: msg, localCount, remoteCount, afterCount, addedCount };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ---- 远程数据修复：下载 → 去重 → 重新上传 ----

async function repairRemoteData() {
  const { config } = await chrome.storage.local.get('config');
  if (!config || !config.token || !config.owner || !config.repo) {
    return { status: 'error', message: '未配置' };
  }
  try {
    const remote = await fetchRemote(config);
    if (!remote) {
      return { status: 'error', message: '远程无数据，无需修复' };
    }

    const before = countBookmarks(remote.data);
    const cleanData = dedupBookmarksData(remote.data);
    const after = countBookmarks(cleanData);
    const removed = before - after;

    await pushRemote(config, cleanData, remote.sha);
    return {
      status: 'success',
      message: removed > 0
        ? `远程数据修复完成：移除 ${removed} 个重复项，剩余 ${after} 个`
        : `远程数据无重复（${after} 个书签），已重新保存`,
      removed
    };
  } catch (err) {
    return { status: 'error', message: `修复失败: ${err.message}` };
  }
}

// ---- 连接测试 ----

async function testConnection(config) {
  const r1 = await githubRequest(config, 'GET', '/user');
  if (!r1.ok) return { ok: false, message: `认证失败: ${r1.status}` };
  const r2 = await githubRequest(config, 'GET', `/repos/${config.owner}/${config.repo}`);
  if (!r2.ok) return { ok: false, message: `仓库访问失败: ${r2.status}` };
  return { ok: true, message: `已连接 ${r1.json.login}` };
}

// ---- GitHub 查询 ----

async function fetchUserInfo(config) {
  const r = await githubRequest(config, 'GET', '/user');
  if (!r.ok) throw new Error(`认证失败: ${r.status}`);
  return r.json;
}

async function fetchRepos(config) {
  const r = await githubRequest(config, 'GET', '/user/repos?per_page=100&sort=updated');
  if (!r.ok) throw new Error(`仓库列表获取失败: ${r.status}`);
  return r.json.map(repo => ({
    name: repo.name,
    full_name: repo.full_name,
    owner: repo.owner.login,
    private: repo.private,
    default_branch: repo.default_branch
  }));
}

async function fetchBranches(config) {
  const path = `/repos/${config.owner}/${config.repo}/branches?per_page=100`;
  const r = await githubRequest(config, 'GET', path);
  if (!r.ok) throw new Error(`分支列表获取失败: ${r.status}`);
  return r.json.map(b => b.name);
}

// ---- 配置管理 ----

function exportConfig(config) {
  return JSON.stringify({
    type: 'BookGitConfig',
    version: 1,
    config: {
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      path: config.path,
      interval: config.interval,
      autoSync: config.autoSync
    },
    exportedAt: new Date().toISOString()
  }, null, 2);
}

function validateImportConfig(text) {
  try {
    const data = JSON.parse(text);
    if (data.type !== 'BookGitConfig') throw new Error('invalid');
    return data.config;
  } catch { return null; }
}

// ============================================================
// 本地书签去重：扫描 → 确认 → 移除
// ============================================================

async function scanLocalDuplicates() {
  const [root] = await chrome.bookmarks.getTree();
  const urlMap = new Map(); // url → [{id, title, path}]

  function walk(nodes, path) {
    for (const n of nodes) {
      if (n.url && !n.url.startsWith('place:')) {
        if (!urlMap.has(n.url)) urlMap.set(n.url, []);
        urlMap.get(n.url).push({ id: n.id, title: n.title || '', path });
      }
      if (n.children) {
        const childPath = n.title ? `${path} > ${n.title}` : path;
        walk(n.children, childPath);
      }
    }
  }

  for (const child of root.children) {
    walk(child.children || [], child.title || '');
  }

  const duplicates = [];
  for (const [url, nodes] of urlMap) {
    if (nodes.length > 1) {
      for (let i = 1; i < nodes.length; i++) {
        duplicates.push({
          url,
          title: nodes[i].title,
          path: nodes[i].path,
          id: nodes[i].id
        });
      }
    }
  }

  return {
    status: 'success',
    totalUnique: urlMap.size,
    totalDup: duplicates.length,
    // 预览：最多 15 条
    preview: duplicates.slice(0, 15).map(d => ({ title: d.title, path: d.path })),
    dupIds: duplicates.map(d => d.id),
    hasMore: duplicates.length > 15
  };
}

async function removeLocalDuplicates(dupIds) {
  if (!dupIds || dupIds.length === 0) {
    return { status: 'error', message: '无可移除项' };
  }
  let removed = 0;
  for (const id of dupIds) {
    try {
      await chrome.bookmarks.remove(id);
      removed++;
    } catch (e) {
      console.warn('BookGit: skip removal', e.message);
    }
  }
  return { status: 'success', message: `已移除 ${removed} 个重复书签`, removed };
}
