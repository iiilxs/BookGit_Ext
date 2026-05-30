// ============================================================
// BookGit 面板交互
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
  const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
  const cfg = status.config || {};

  if (cfg.token)    document.getElementById('token').value = cfg.token;
  if (cfg.owner)    document.getElementById('ownerSelect').value = cfg.owner;
  if (cfg.repo)     document.getElementById('repoSelect').value = cfg.repo;
  if (cfg.branch)   document.getElementById('branchSelect').value = cfg.branch;
  if (cfg.filePath) document.getElementById('filePath').value = cfg.filePath;
  if (cfg.autoSync !== undefined) document.getElementById('autoSync').checked = cfg.autoSync;

  // 间隔：默认 5 小时（300 分钟）
  const interval = cfg.interval !== undefined ? cfg.interval : 300;
  document.getElementById('interval').value = interval.toString();

  // 根据 autoSync 控制间隔显隐
  updateIntervalVisibility();

  // Token 安全：已连通则永久锁定，完全不显示输入框
  const { tokenVerified, tokenUser } = status;
  if (tokenVerified && cfg.token) {
    document.getElementById('tokenVerified').style.display = 'flex';
    document.getElementById('tokenUnconfigured').style.display = 'none';
    document.getElementById('tokenUser').textContent = tokenUser || '已连接';
    document.getElementById('lockTokenBtn').style.display = 'none';
  } else {
    document.getElementById('tokenVerified').style.display = 'none';
    document.getElementById('tokenUnconfigured').style.display = 'flex';
    if (cfg.token) document.getElementById('token').value = cfg.token;
  }

  updateStatus(status.lastSync);
  loadStats();
  renderHistory(status.syncHistory);

  if (cfg.token && (!status.repos || status.repos.length === 0)) {
    tryAutoLoadRepos();
  }

  // ---- 标签切换 ----
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ---- 同步按钮 → 弹窗选择模式 ----
  document.getElementById('syncBtn').addEventListener('click', () => {
    document.getElementById('syncModal').style.display = 'flex';
  });

  document.getElementById('syncModalCancel').addEventListener('click', () => {
    document.getElementById('syncModal').style.display = 'none';
  });

  document.querySelectorAll('.modal-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      document.getElementById('syncModal').style.display = 'none';

      const syncBtn = document.getElementById('syncBtn');
      syncBtn.disabled = true; syncBtn.textContent = '↻ 同步中...';
      try {
        const result = await chrome.runtime.sendMessage({ action: 'sync', mode });
        updateStatus({ timestamp: new Date().toISOString(), status: result.status, message: result.message });
        loadStats();
        const s = await chrome.runtime.sendMessage({ action: 'getStatus' });
        renderHistory(s.syncHistory);
        if (result.status === 'success') {
          await chrome.runtime.sendMessage({ action: 'lockToken' });
        }
      } catch (e) { updateStatus({ status: 'error', message: e.message }); }
      syncBtn.disabled = false; syncBtn.textContent = '↻ 立即同步';
    });
  });

  // ---- 刷新状态 ----
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    const s = await chrome.runtime.sendMessage({ action: 'getStatus' });
    updateStatus(s.lastSync); renderHistory(s.syncHistory); loadStats();
  });

  // ---- Token 锁定按钮：保存输入到存储（无法查看已存值）----
  document.getElementById('lockTokenBtn').addEventListener('click', () => {
    saveConfig();
    document.getElementById('token').blur();
    setStatusText('Token 已保存');
  });

  // ---- Token 变更 → 自动加载仓库 ----
  document.getElementById('token').addEventListener('input', debounce(() => {
    if (document.getElementById('token').value.trim().length > 10) {
      saveConfig();
      tryAutoLoadRepos();
    }
  }, 1500));

  // ---- 加载仓库列表 ----
  document.getElementById('loadReposBtn').addEventListener('click', loadRepos);

  // ---- 选择仓库 → 加载分支 ----
  document.getElementById('repoSelect').addEventListener('change', () => {
    saveConfig(); loadBranches();
  });

  // ---- 变更保存 ----
  document.getElementById('ownerSelect').addEventListener('change', saveConfig);
  document.getElementById('branchSelect').addEventListener('change', saveConfig);

  // ---- 自动同步开关 → 控制间隔显隐 + 保存 ----
  document.getElementById('autoSync').addEventListener('change', () => {
    const on = document.getElementById('autoSync').checked;
    if (!on) {
      // 关闭自动同步，间隔切为"仅手动"
      document.getElementById('interval').value = '0';
    } else {
      // 开启自动同步，若间隔为 0 则默认 5 小时
      const cur = parseInt(document.getElementById('interval').value) || 0;
      if (cur === 0) document.getElementById('interval').value = '300';
    }
    updateIntervalVisibility();
    saveConfig();
    updateStatus({
      status: 'waiting',
      message: on ? '自动同步已开启' : '自动同步已关闭',
      timestamp: new Date().toISOString()
    });
  });

  // ---- 其他变更保存 ----
  ['filePath', 'interval'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('change', saveConfig);
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') {
      el.addEventListener('input', debounce(saveConfig, 600));
    }
  });

  // 间隔变更时联动 autoSync
  document.getElementById('interval').addEventListener('change', () => {
    const val = parseInt(document.getElementById('interval').value) || 0;
    if (val === 0) {
      document.getElementById('autoSync').checked = false;
      updateIntervalVisibility();
    }
    saveConfig();
  });

  // ---- 测试连接 ----
  document.getElementById('testBtn').addEventListener('click', async () => {
    const btn = document.getElementById('testBtn');
    btn.disabled = true; btn.textContent = '● 检测中...';
    try {
      const r = await chrome.runtime.sendMessage({ action: 'testConnection', config: getFormConfig() });
      if (r.ok) {
        btn.textContent = '✓ 连接成功';
        await chrome.runtime.sendMessage({ action: 'lockToken', login: r.login });
        location.reload();
      } else {
        btn.textContent = '✗ ' + r.message;
      }
    } catch (e) { btn.textContent = '✗ ' + e.message; }
    if (!btn.textContent.startsWith('✓')) {
      setTimeout(() => { btn.disabled = false; btn.textContent = '● 测试连接'; }, 2500);
    }
  });

  // ---- 导出配置 ----
  document.getElementById('exportBtn').addEventListener('click', async () => {
    const text = await chrome.runtime.sendMessage({ action: 'exportConfig' });
    const ta = document.getElementById('configArea');
    ta.value = text; ta.style.display = 'block'; ta.select();
    try { await navigator.clipboard.writeText(text); document.getElementById('exportBtn').textContent = '✓ 已复制'; }
    catch { document.getElementById('exportBtn').textContent = '✓ 已生成'; }
    setTimeout(() => { document.getElementById('exportBtn').textContent = '↗ 导出'; }, 2000);
  });

  // ---- 导入配置 ----
  document.getElementById('importBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const r = await chrome.runtime.sendMessage({ action: 'importConfig', text });
      if (r.ok) {
        setDropdownValue('ownerSelect', r.config.owner || '');
        setDropdownValue('repoSelect', r.config.repo || '');
        setDropdownValue('branchSelect', r.config.branch || 'main');
        document.getElementById('filePath').value = r.config.path || 'bookgit.json';
        document.getElementById('interval').value = (r.config.interval || 300).toString();
        document.getElementById('autoSync').checked = r.config.autoSync !== false;
        updateIntervalVisibility();
        if (r.config.token) {
          document.getElementById('token').value = r.config.token;
        }
        if (r.config.owner && r.config.repo) loadBranches();
        document.getElementById('importBtn').textContent = '✓ 已导入';
      } else { document.getElementById('importBtn').textContent = '✗ 配置无效'; }
    } catch { document.getElementById('importBtn').textContent = '✗ 读取剪贴板失败'; }
    setTimeout(() => { document.getElementById('importBtn').textContent = '↘ 导入'; }, 2000);
  });

  // ---- 修复远程数据 ----
  document.getElementById('repairBtn').addEventListener('click', async () => {
    const btn = document.getElementById('repairBtn');
    btn.disabled = true;
    const origText = btn.innerHTML;
    btn.innerHTML = '🔧 修复中...';
    try {
      const result = await chrome.runtime.sendMessage({ action: 'repairRemote' });
      setStatusText(result.message);
      if (result.status === 'error') {
        btn.innerHTML = '✗ 失败';
      } else {
        btn.innerHTML = '✓ 完成';
      }
    } catch (e) {
      setStatusText('修复失败: ' + e.message);
      btn.innerHTML = '✗ 失败';
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.innerHTML = origText;
    }, 3000);
  });

  // ---- 帮助指南 ----
  document.getElementById('helpBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'help.html' });
  });

  // ---- 一键去重 ----
  let pendingDupIds = null;

  document.getElementById('dedupBtn').addEventListener('click', async () => {
    const btn = document.getElementById('dedupBtn');
    btn.disabled = true;
    btn.innerHTML = '⏳ 扫描中...';

    try {
      const scan = await chrome.runtime.sendMessage({ action: 'scanLocalDup' });
      if (scan.totalDup === 0) {
        document.getElementById('dedupTitle').textContent = '✅ 无重复';
        document.getElementById('dedupInfo').textContent = '本地收藏夹没有重复书签。';
        document.getElementById('dedupList').innerHTML = '';
        document.getElementById('dedupConfirmBtn').style.display = 'none';
      } else {
        document.getElementById('dedupTitle').textContent = `🔍 发现 ${scan.totalDup} 个重复书签`;
        document.getElementById('dedupInfo').textContent = `共 ${scan.totalUnique} 个独特 URL，将保留首次出现的位置：`;
        let html = '';
        for (const item of scan.preview) {
          html += `<div class="h-item"><span class="h-msg">${escapeHtml(item.title)}</span><span style="color:var(--text3);font-size:10px;flex-shrink:0;margin-left:4px">${escapeHtml(item.path)}</span></div>`;
        }
        if (scan.hasMore) {
          html += `<div class="h-item" style="color:var(--text3);justify-content:center">…等共 ${scan.totalDup} 项</div>`;
        }
        document.getElementById('dedupList').innerHTML = html;
        document.getElementById('dedupConfirmBtn').style.display = 'block';
        pendingDupIds = scan.dupIds;
      }
    } catch (e) {
      document.getElementById('dedupTitle').textContent = '❌ 扫描失败';
      document.getElementById('dedupInfo').textContent = e.message;
      document.getElementById('dedupList').innerHTML = '';
      document.getElementById('dedupConfirmBtn').style.display = 'none';
    }

    document.getElementById('dedupModal').style.display = 'flex';
    btn.disabled = false;
    btn.innerHTML = '🗑 一键去重';
  });

  document.getElementById('dedupConfirmBtn').addEventListener('click', async () => {
    document.getElementById('dedupModal').style.display = 'none';
    if (!pendingDupIds || pendingDupIds.length === 0) return;

    const result = await chrome.runtime.sendMessage({ action: 'removeLocalDup', dupIds: pendingDupIds });
    setStatusText(result.message);
    pendingDupIds = null;
    loadStats();
  });

  document.getElementById('dedupModalCancel').addEventListener('click', () => {
    document.getElementById('dedupModal').style.display = 'none';
    pendingDupIds = null;
  });
});

// =============================================================
// 仓库/分支加载
// =============================================================

async function tryAutoLoadRepos() {
  const btn = document.getElementById('loadReposBtn');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '⏳';
  await loadReposInternal();
  btn.disabled = false; btn.textContent = '↻';
}

async function loadRepos() {
  const btn = document.getElementById('loadReposBtn');
  btn.disabled = true; btn.textContent = '⏳';
  if (!document.getElementById('token').value.trim()) {
    setStatusText('请先输入 Token');
    btn.disabled = false; btn.textContent = '↻';
    return;
  }
  saveConfig();
  await loadReposInternal();
  btn.disabled = false; btn.textContent = '↻';
}

async function loadReposInternal() {
  try {
    const userRes = await chrome.runtime.sendMessage({ action: 'fetchUserInfo' });
    if (!userRes.ok) { setStatusText(userRes.message || '用户信息获取失败'); return; }
    const repoRes = await chrome.runtime.sendMessage({ action: 'fetchRepos' });
    if (!repoRes.ok) { setStatusText(repoRes.message || '仓库列表获取失败'); return; }

    const repos = repoRes.repos;
    const ownerSelect = document.getElementById('ownerSelect');
    const repoSelect = document.getElementById('repoSelect');

    ownerSelect.innerHTML = `<option value="${userRes.login}">${userRes.login}</option>`;
    let html = '<option value="">— 请选择仓库 —</option>';
    for (const r of repos) {
      html += `<option value="${r.name}">${r.private ? '🔒 ' : ''}${r.name}</option>`;
    }
    repoSelect.innerHTML = html;

    const cfg = (await chrome.runtime.sendMessage({ action: 'getStatus' })).config || {};
    if (cfg.owner) setDropdownValue('ownerSelect', cfg.owner);
    if (cfg.repo) {
      setDropdownValue('repoSelect', cfg.repo);
      if (cfg.repo && repos.some(r => r.name === cfg.repo)) await loadBranches();
    }
    if (cfg.branch) setDropdownValue('branchSelect', cfg.branch);
    setStatusText(`已加载 ${repos.length} 个仓库`);
  } catch (e) { setStatusText('加载失败: ' + e.message); throw e; }
}

async function loadBranches() {
  const owner = document.getElementById('ownerSelect').value;
  const repo = document.getElementById('repoSelect').value;
  if (!owner || !repo) return;

  const branchSelect = document.getElementById('branchSelect');
  const res = await chrome.runtime.sendMessage({ action: 'fetchBranches', config: getFormConfig() });
  if (!res.ok) { branchSelect.innerHTML = `<option value="">加载失败: ${res.message}</option>`; return; }

  let html = '';
  for (const b of res.branches) html += `<option value="${b}">${b}</option>`;
  branchSelect.innerHTML = html;

  const savedCfg = (await chrome.runtime.sendMessage({ action: 'getStatus' })).config || {};
  if (savedCfg.branch && res.branches.includes(savedCfg.branch)) branchSelect.value = savedCfg.branch;
  else if (res.defaultBranch && res.branches.includes(res.defaultBranch)) branchSelect.value = res.defaultBranch;
  else if (res.branches.length > 0) branchSelect.value = res.branches[0];
}

// =============================================================
// 辅助函数
// =============================================================

function getFormConfig() {
  const tokenInput = document.getElementById('token');
  const intervalVal = parseInt(document.getElementById('interval').value) || 0;
  return {
    token: tokenInput.value.trim(),
    owner: document.getElementById('ownerSelect').value.trim(),
    repo: document.getElementById('repoSelect').value.trim(),
    branch: document.getElementById('branchSelect').value.trim() || 'main',
    path: document.getElementById('filePath').value.trim() || 'bookgit.json',
    autoSync: document.getElementById('autoSync').checked && intervalVal > 0,
    interval: intervalVal
  };
}

function saveConfig() {
  chrome.runtime.sendMessage({ action: 'updateConfig', config: getFormConfig() });
}

function setDropdownValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!Array.from(el.options).some(o => o.value === value)) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = value;
}

function setStatusText(text) {
  const el = document.getElementById('statusText');
  if (el) el.textContent = text;
}

function updateStatus(lastSync) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (!lastSync || !lastSync.status) {
    dot.className = 'dot waiting';
    text.textContent = '等待首次同步';
    return;
  }
  dot.className = 'dot ' + lastSync.status;
  const ago = lastSync.timestamp ? timeAgo(new Date(lastSync.timestamp)) : '';
  text.textContent = ago ? `${lastSync.message} · ${ago}` : lastSync.message;
}

async function loadStats() {
  try {
    const stats = await chrome.runtime.sendMessage({ action: 'getStats' });
    document.getElementById('localBookmarks').textContent = stats.bookmarks;
    document.getElementById('localFolders').textContent = stats.folders;
  } catch {}
  const s = await chrome.runtime.sendMessage({ action: 'getStatus' });
  if (s.lastSync && s.lastSync.timestamp) {
    document.getElementById('lastSyncTime').textContent = timeAgo(new Date(s.lastSync.timestamp));
  }
  try {
    await fetch('https://api.github.com', { method: 'HEAD', mode: 'no-cors' });
    document.getElementById('networkStatus').textContent = '可达';
    document.getElementById('networkStatus').style.color = '#5a8';
  } catch {
    document.getElementById('networkStatus').textContent = '不可达';
    document.getElementById('networkStatus').style.color = '#c55';
  }
}

function renderHistory(history) {
  const el = document.getElementById('historyList');
  if (!history || history.length === 0) {
    el.innerHTML = '<div class="empty">暂无同步记录</div>';
    return;
  }
  el.innerHTML = history.slice(0, 20).map(h => {
    const icons = { success: '✓', error: '✗', conflict: '⚠' };
    return `<div class="h-item">
      <span class="h-icon ${h.status}">${icons[h.status] || '?'}</span>
      <span class="h-msg">${escapeHtml(h.message)}</span>
      <span class="h-time">${formatTime(h.time)}</span>
    </div>`;
  }).join('');
}

// 根据 autoSync 状态隐藏/显示间隔下拉框
function updateIntervalVisibility() {
  const intervalField = document.getElementById('intervalField');
  const autoSync = document.getElementById('autoSync').checked;
  intervalField.classList.toggle('hidden', !autoSync);
}

function escapeHtml(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
function timeAgo(d) { const s = Math.floor((Date.now()-d)/1000); if(s<60) return '刚刚'; const m=Math.floor(s/60); if(m<60) return m+'分钟前'; return Math.floor(m/60)+'小时前'; }
function formatTime(t) { const d=new Date(t); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
