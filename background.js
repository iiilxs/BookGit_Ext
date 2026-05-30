// ============================================================
// BookGit 后台 Service Worker
// 定时同步 + 消息路由 + 徽章状态
// ============================================================

importScripts('sync-core.js');

// 初始化
registerListeners();
updateBadge('waiting');

// ----- 定时同步 -----

/**
 * 安全创建 alarm：仅当 interval > 0 且 autoSync 开启时创建
 */
function safeCreateAlarm(config) {
  chrome.alarms.clear('bookgit-sync');
  if (config && config.autoSync && config.interval > 0) {
    chrome.alarms.create('bookgit-sync', { periodInMinutes: config.interval });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get('config');
  safeCreateAlarm(config);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'bookgit-sync') return;

  const result = await sync();

  // 记录同步历史
  const { syncHistory } = await chrome.storage.local.get('syncHistory');
  const history = (syncHistory || []).slice(0, 19);
  history.unshift({
    time: new Date().toISOString(),
    status: result.status,
    message: result.message
  });
  await chrome.storage.local.set({
    lastSync: {
      timestamp: new Date().toISOString(),
      status: result.status,
      message: result.message
    },
    syncHistory: history
  });

  updateBadge(result.status);

  // 冲突通知
  if (result.status === 'conflict') {
    chrome.notifications.create('bookgit-conflict', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'BookGit 同步',
      message: '检测到冲突，已自动合并',
      priority: 1
    });
  }
});

function updateBadge(status) {
  const badges = {
    success: { text: '✓', color: '#3a6a3a' },
    error:   { text: '✗', color: '#6a3a3a' },
    conflict:{ text: '!', color: '#6a5a3a' },
    waiting: { text: '…', color: '#4a4a4a' }
  };
  const b = badges[status] || badges.waiting;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
}

// ----- 消息路由（与 popup 通信）-----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    sync: async () => {
      const result = await sync(msg.mode);
      const { syncHistory } = await chrome.storage.local.get('syncHistory');
      const history = (syncHistory || []).slice(0, 19);
      history.unshift({
        time: new Date().toISOString(),
        status: result.status,
        message: result.message
      });
      await chrome.storage.local.set({
        lastSync: {
          timestamp: new Date().toISOString(),
          status: result.status,
          message: result.message
        },
        syncHistory: history
      });
      updateBadge(result.status);
      return result;
    },
    repairRemote: async () => {
      return await repairRemoteData();
    },
    scanLocalDup: async () => {
      return await scanLocalDuplicates();
    },
    removeLocalDup: async () => {
      return await removeLocalDuplicates(msg.dupIds);
    },
    updateConfig: async () => {
      await chrome.storage.local.set({ config: msg.config });
      safeCreateAlarm(msg.config);
      return { ok: true };
    },
    getStatus: async () => {
      const data = await chrome.storage.local.get(['config', 'lastSync', 'syncHistory', 'tokenVerified', 'tokenUser']);
      return data;
    },
    lockToken: async () => {
      await chrome.storage.local.set({ tokenVerified: true, tokenUser: msg.login || '已连接' });
      return { ok: true };
    },
    testConnection: async () => {
      return await testConnection(msg.config);
    },
    getStats: async () => {
      return await getBookmarkStats();
    },
    fetchRepos: async () => {
      const { config } = await chrome.storage.local.get('config');
      if (!config || !config.token) return { ok: false, message: '未配置 Token' };
      try {
        const repos = await fetchRepos(config);
        return { ok: true, repos };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    fetchBranches: async () => {
      const cfg = (msg.config && msg.config.repo) ? msg.config : (await chrome.storage.local.get('config')).config;
      if (!cfg || !cfg.token || !cfg.owner || !cfg.repo) {
        return { ok: false, message: '请先选择仓库' };
      }
      try {
        const branches = await fetchBranches(cfg);
        return { ok: true, branches, defaultBranch: cfg.branch || 'main' };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    fetchUserInfo: async () => {
      const { config } = await chrome.storage.local.get('config');
      if (!config || !config.token) return { ok: false, message: '未配置 Token' };
      try {
        const user = await fetchUserInfo(config);
        return { ok: true, login: user.login };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    exportConfig: async () => {
      const { config } = await chrome.storage.local.get('config');
      return exportConfig(config || {});
    },
    importConfig: async () => {
      const cfg = validateImportConfig(msg.text);
      if (cfg) {
        await chrome.storage.local.set({ config: cfg });
        safeCreateAlarm(cfg);
        return { ok: true, config: cfg };
      }
      return { ok: false };
    }
  };

  const fn = handlers[msg.action];
  if (fn) {
    fn().then(sendResponse);
    return true; // 保持通道打开
  }
});
