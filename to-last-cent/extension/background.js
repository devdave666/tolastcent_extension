/**
 * To Last Cent — background service worker (Manifest V3).
 *
 * Responsibilities:
 *  - Maintain a local cache of the merchant catalog (bundled + remote refresh).
 *  - Watch navigation events and detect when the active tab is on a known
 *    merchant domain, updating the toolbar badge and notifying the content
 *    script so it can render the "Activate Cashback" banner.
 *  - Handle "activate cashback" requests by opening the backend's tracking
 *    redirect endpoint (which forwards to CJ Affiliate with the user's sid)
 *    in a background tab, then marking the session active for that domain.
 *  - Periodically refresh the user's balance and merchant catalog via
 *    chrome.alarms so the popup can render instantly from cache.
 */

importScripts("config.js");

const { STORAGE_KEYS, API_ROUTES, API_BASE_URL, SYNC_INTERVAL_MINUTES } =
  self.TLC_CONFIG;

const ALARM_SYNC = "tlc-periodic-sync";

// ---------------------------------------------------------------------------
// Merchant catalog helpers
// ---------------------------------------------------------------------------

let merchantIndexPromise = null;

/** Builds a Map of registrable-domain -> merchant record for O(1) lookups. */
async function loadMerchantIndex(forceRefresh = false) {
  if (merchantIndexPromise && !forceRefresh) return merchantIndexPromise;

  merchantIndexPromise = (async () => {
    let merchants = [];
    try {
      const cached = await getStorage(STORAGE_KEYS.MERCHANTS_CACHE);
      if (cached && Array.isArray(cached.merchants) && !forceRefresh) {
        merchants = cached.merchants;
      } else {
        merchants = await fetchMerchantCatalog();
      }
    } catch (err) {
      console.warn("[TLC] Falling back to bundled merchant catalog:", err);
      merchants = await fetchBundledMerchants();
    }

    const index = new Map();
    for (const m of merchants) {
      if (!m.active) continue;
      for (const domain of m.domains || []) {
        index.set(domain.toLowerCase(), m);
      }
    }
    return index;
  })();

  return merchantIndexPromise;
}

async function fetchBundledMerchants() {
  const url = chrome.runtime.getURL(self.TLC_CONFIG.MERCHANTS_DATA_PATH);
  const res = await fetch(url);
  const data = await res.json();
  return data.merchants || [];
}

/** Tries the live backend catalog first, falls back to the bundled JSON. */
async function fetchMerchantCatalog() {
  try {
    const res = await fetch(`${API_BASE_URL}${API_ROUTES.MERCHANTS}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Merchant API ${res.status}`);
    const data = await res.json();
    const merchants = data.merchants || [];
    await setStorage(STORAGE_KEYS.MERCHANTS_CACHE, {
      merchants,
      fetchedAt: Date.now(),
    });
    return merchants;
  } catch (err) {
    const merchants = await fetchBundledMerchants();
    await setStorage(STORAGE_KEYS.MERCHANTS_CACHE, {
      merchants,
      fetchedAt: Date.now(),
      source: "bundled-fallback",
    });
    return merchants;
  }
}

function matchMerchantForHostname(hostname, index) {
  if (!hostname) return null;
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (index.has(hostname.toLowerCase())) return index.get(hostname.toLowerCase());
  if (index.has(host)) return index.get(host);
  if (index.has(`www.${host}`)) return index.get(`www.${host}`);
  return null;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result[key]));
  });
}

function setStorage(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Session state: which domains currently have cashback "Activated"
// ---------------------------------------------------------------------------

async function getActiveSessions() {
  return (await getStorage("tlc_active_sessions")) || {};
}

async function markSessionActive(merchantId) {
  const sessions = await getActiveSessions();
  sessions[merchantId] = { activatedAt: Date.now() };
  await setStorage("tlc_active_sessions", sessions);
}

async function isSessionActive(merchantId) {
  const sessions = await getActiveSessions();
  const session = sessions[merchantId];
  if (!session) return false;

  const expired = Date.now() - session.activatedAt > self.TLC_CONFIG.SESSION_ACTIVE_TTL_MS;
  if (expired) {
    delete sessions[merchantId];
    await setStorage("tlc_active_sessions", sessions);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Badge / icon updates
// ---------------------------------------------------------------------------

async function updateBadgeForTab(tabId, merchant, active) {
  if (!merchant) {
    chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  chrome.action.setBadgeText({ tabId, text: active ? "ON" : "$" });
  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: active ? "#10b981" : "#f59e0b",
  });
}

// ---------------------------------------------------------------------------
// Navigation watcher
// ---------------------------------------------------------------------------

async function handleNavigation(tabId, url) {
  if (!url || !/^https?:\/\//.test(url)) return;
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }

  const index = await loadMerchantIndex();
  const merchant = matchMerchantForHostname(hostname, index);
  if (!merchant) {
    updateBadgeForTab(tabId, null, false);
    return;
  }

  const active = await isSessionActive(merchant.id);
  updateBadgeForTab(tabId, merchant, active);

  chrome.tabs
    .sendMessage(tabId, {
      type: "TLC_MERCHANT_DETECTED",
      merchant,
      active,
    })
    .catch(() => {
      // Content script may not be injected yet (e.g. chrome:// pages) — ignore.
    });
}

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  handleNavigation(details.tabId, details.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    handleNavigation(tabId, tab.url);
  }
});

// ---------------------------------------------------------------------------
// Message handling (from content script + popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "TLC_GET_MERCHANT_FOR_TAB": {
      const index = await loadMerchantIndex();
      const merchant = matchMerchantForHostname(message.hostname, index);
      const active = merchant ? await isSessionActive(merchant.id) : false;
      return { ok: true, merchant, active };
    }

    case "TLC_ACTIVATE_CASHBACK": {
      return activateCashback(message.merchant, sender.tab?.id);
    }

    case "TLC_DISMISS_BANNER": {
      const dismissed = (await getStorage(STORAGE_KEYS.DISMISSED_BANNERS)) || {};
      dismissed[message.merchantId] = Date.now();
      await setStorage(STORAGE_KEYS.DISMISSED_BANNERS, dismissed);
      return { ok: true };
    }

    case "TLC_GET_BALANCE": {
      return { ok: true, balance: await refreshBalance() };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

/**
 * Opens the backend redirect endpoint in a new background tab. The backend
 * logs the click session and 302s to the CJ Affiliate tracking link with the
 * user's sid appended, so CJ attributes the resulting purchase to this user.
 */
async function activateCashback(merchant, originTabId) {
  const userId = await getStorage(STORAGE_KEYS.USER_ID);
  if (!userId) {
    return { ok: false, error: "not_authenticated" };
  }

  const redirectUrl = new URL(`${API_BASE_URL}${API_ROUTES.REDIRECT}`);
  redirectUrl.searchParams.set("user_id", userId);
  redirectUrl.searchParams.set("merchant", merchant.id);

  let trackingTab;
  try {
    trackingTab = await chrome.tabs.create({
      url: redirectUrl.toString(),
      active: false,
    });
  } catch (err) {
    return { ok: false, error: "tab_create_failed" };
  }

  const outcome = await waitForTrackingOutcome(trackingTab.id, redirectUrl.origin);
  chrome.tabs.remove(trackingTab.id).catch(() => {});

  if (!outcome.ok) {
    return outcome;
  }

  await markSessionActive(merchant.id);
  if (originTabId != null) {
    updateBadgeForTab(originTabId, merchant, true);
  }

  return { ok: true };
}

/**
 * Watches the tracking tab's navigation to confirm the backend's redirect
 * actually fired (i.e. the tab left our own backend origin), rather than
 * assuming success — a dead/unreachable backend previously still reported
 * "Activated" to the user even though nothing was logged server-side.
 */
function waitForTrackingOutcome(tabId, backendOrigin) {
  return new Promise((resolve) => {
    const TIMEOUT_MS = 8000;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.webNavigation.onErrorOccurred.removeListener(onNavError);
      clearTimeout(timer);
      resolve(result);
    };

    const onNavError = (details) => {
      if (details.tabId !== tabId || details.frameId !== 0) return;
      settle({ ok: false, error: "backend_unreachable" });
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || !tab.url) return;

      // Navigated away from our backend (through CJ, on to the merchant) —
      // the redirect endpoint responded and logged the click.
      if (!tab.url.startsWith(backendOrigin) && !tab.url.startsWith("chrome:")) {
        settle({ ok: true });
        return;
      }

      // Finished loading but still sitting on our own backend origin means
      // the redirect endpoint returned an error page instead of a 302.
      if (changeInfo.status === "complete" && tab.url.startsWith(backendOrigin)) {
        settle({ ok: false, error: "redirect_failed" });
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.webNavigation.onErrorOccurred.addListener(onNavError);
    const timer = setTimeout(() => settle({ ok: false, error: "timeout" }), TIMEOUT_MS);
  });
}

async function refreshBalance() {
  const userId = await getStorage(STORAGE_KEYS.USER_ID);
  const token = await getStorage(STORAGE_KEYS.AUTH_TOKEN);
  if (!userId) return { pending: 0, available: 0, authenticated: false };

  try {
    const res = await fetch(
      `${API_BASE_URL}${API_ROUTES.BALANCE}?user_id=${encodeURIComponent(userId)}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) throw new Error(`Balance API ${res.status}`);
    const data = await res.json();
    const balance = {
      pending: data.pending ?? 0,
      available: data.available ?? 0,
      currency: data.currency || "USD",
      authenticated: true,
      fetchedAt: Date.now(),
    };
    await setStorage(STORAGE_KEYS.BALANCE_CACHE, balance);
    return balance;
  } catch (err) {
    console.warn("[TLC] Balance refresh failed:", err);
    const cached = await getStorage(STORAGE_KEYS.BALANCE_CACHE);
    return cached || { pending: 0, available: 0, authenticated: true, stale: true };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: install + periodic alarms
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await loadMerchantIndex(true);
  chrome.alarms.create(ALARM_SYNC, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_SYNC, {
    periodInMinutes: SYNC_INTERVAL_MINUTES,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_SYNC) {
    loadMerchantIndex(true);
    refreshBalance();
  }
});
