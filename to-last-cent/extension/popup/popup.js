/**
 * To Last Cent — popup script.
 * `config.js` is loaded before this file and exposes `self.TLC_CONFIG`.
 */

const { STORAGE_KEYS, API_ROUTES, API_BASE_URL, WEBSITE_URL } = self.TLC_CONFIG;

const els = {
  statusBadge: document.getElementById("tlc-status-badge"),
  statusLabel: document.getElementById("tlc-status-label"),

  authView: document.getElementById("tlc-auth-view"),
  authTitle: document.getElementById("tlc-auth-title"),
  authForm: document.getElementById("tlc-auth-form"),
  authToggle: document.getElementById("tlc-auth-toggle"),
  authError: document.getElementById("tlc-auth-error"),
  authSubmit: document.getElementById("tlc-auth-submit"),
  email: document.getElementById("tlc-email"),
  password: document.getElementById("tlc-password"),

  mainView: document.getElementById("tlc-main-view"),
  balancePending: document.getElementById("tlc-balance-pending"),
  balanceAvailable: document.getElementById("tlc-balance-available"),

  currentSite: document.getElementById("tlc-current-site"),
  currentSiteName: document.getElementById("tlc-current-site-name"),
  currentSiteRate: document.getElementById("tlc-current-site-rate"),
  currentSiteActivate: document.getElementById("tlc-current-site-activate"),

  searchInput: document.getElementById("tlc-search-input"),
  storeList: document.getElementById("tlc-store-list"),
  emptyState: document.getElementById("tlc-empty-state"),

  dashboardLink: document.getElementById("tlc-dashboard-link"),
  signoutBtn: document.getElementById("tlc-signout-btn"),
};

let authMode = "login"; // "login" | "signup"
let allMerchants = [];
let activeMerchantForTab = null;

init();

async function init() {
  els.dashboardLink.href = WEBSITE_URL;

  const [userId, merchants] = await Promise.all([
    getStorage(STORAGE_KEYS.USER_ID),
    loadMerchants(),
  ]);
  allMerchants = merchants;

  if (userId) {
    showMainView();
    refreshBalance();
    detectCurrentSite();
  } else {
    showAuthView();
  }

  renderStoreList(allMerchants);

  els.authForm.addEventListener("submit", onAuthSubmit);
  els.authToggle.addEventListener("click", toggleAuthMode);
  els.searchInput.addEventListener("input", onSearchInput);
  els.signoutBtn.addEventListener("click", onSignOut);
  els.currentSiteActivate.addEventListener("click", () =>
    activateMerchant(activeMerchantForTab, els.currentSiteActivate)
  );
}

// ---------------------------------------------------------------------------
// View toggling
// ---------------------------------------------------------------------------

function showAuthView() {
  els.authView.hidden = false;
  els.mainView.hidden = true;
  els.signoutBtn.hidden = true;
  setStatus("idle", "Sign in required");
}

function showMainView() {
  els.authView.hidden = true;
  els.mainView.hidden = false;
  els.signoutBtn.hidden = false;
}

function setStatus(kind, label) {
  els.statusBadge.className = `tlc-badge tlc-badge-${kind}`;
  els.statusLabel.textContent = label;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function toggleAuthMode() {
  authMode = authMode === "login" ? "signup" : "login";
  els.authTitle.textContent = authMode === "login" ? "Welcome back" : "Create your account";
  els.authSubmit.textContent = authMode === "login" ? "Sign In" : "Sign Up";
  els.authToggle.textContent =
    authMode === "login" ? "Need an account? Sign up" : "Already have an account? Sign in";
  hideAuthError();
}

async function onAuthSubmit(event) {
  event.preventDefault();
  hideAuthError();
  els.authSubmit.disabled = true;
  els.authSubmit.textContent = authMode === "login" ? "Signing in…" : "Creating account…";

  const email = els.email.value.trim();
  const password = els.password.value;
  const route = authMode === "login" ? API_ROUTES.AUTH_LOGIN : API_ROUTES.AUTH_SIGNUP;

  try {
    const res = await fetch(`${API_BASE_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Authentication failed");

    await setStorage(STORAGE_KEYS.USER_ID, String(data.userId));
    await setStorage(STORAGE_KEYS.AUTH_TOKEN, data.token);

    showMainView();
    refreshBalance();
    detectCurrentSite();
  } catch (err) {
    showAuthError(err.message || "Something went wrong. Please try again.");
  } finally {
    els.authSubmit.disabled = false;
    els.authSubmit.textContent = authMode === "login" ? "Sign In" : "Sign Up";
  }
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
}

function hideAuthError() {
  els.authError.hidden = true;
}

async function onSignOut() {
  await Promise.all([
    removeStorage(STORAGE_KEYS.USER_ID),
    removeStorage(STORAGE_KEYS.AUTH_TOKEN),
    removeStorage(STORAGE_KEYS.BALANCE_CACHE),
  ]);
  showAuthView();
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

async function refreshBalance() {
  const cached = await getStorage(STORAGE_KEYS.BALANCE_CACHE);
  if (cached) renderBalance(cached);

  const response = await chrome.runtime.sendMessage({ type: "TLC_GET_BALANCE" });
  if (response?.ok) renderBalance(response.balance);
}

function renderBalance(balance) {
  els.balancePending.textContent = formatCurrency(balance.pending);
  els.balanceAvailable.textContent = formatCurrency(balance.available);
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(amount || 0));
}

// ---------------------------------------------------------------------------
// Current tab merchant detection
// ---------------------------------------------------------------------------

async function detectCurrentSite() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:\/\//.test(tab.url)) {
    setStatus("idle", "Not a partner store");
    return;
  }

  let hostname;
  try {
    hostname = new URL(tab.url).hostname;
  } catch {
    setStatus("idle", "Not a partner store");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "TLC_GET_MERCHANT_FOR_TAB",
    hostname,
  });

  if (response?.ok && response.merchant) {
    activeMerchantForTab = response.merchant;
    els.currentSite.hidden = false;
    els.currentSiteName.textContent = response.merchant.name;
    els.currentSiteRate.textContent = response.merchant.cashbackLabel;

    if (response.active) {
      setStatus("active", "Cashback Active");
      els.currentSiteActivate.textContent = "Activated ✓";
      els.currentSiteActivate.disabled = true;
    } else {
      setStatus("available", "Cashback Available");
      els.currentSiteActivate.textContent = "Activate";
      els.currentSiteActivate.disabled = false;
    }
  } else {
    activeMerchantForTab = null;
    els.currentSite.hidden = true;
    setStatus("idle", "Not a partner store");
  }
}

// ---------------------------------------------------------------------------
// Store search
// ---------------------------------------------------------------------------

async function loadMerchants() {
  // Prefer the background worker's catalog — it's the live backend data
  // (with cashback rates computed from real CJ commission figures) when
  // reachable, falling back to the bundled snapshot only if the backend
  // can't be reached at all.
  try {
    const response = await chrome.runtime.sendMessage({ type: "TLC_GET_MERCHANTS" });
    if (response?.ok && Array.isArray(response.merchants)) {
      return response.merchants;
    }
  } catch {
    // background worker unavailable — fall through to the bundled snapshot
  }

  try {
    const url = chrome.runtime.getURL(self.TLC_CONFIG.MERCHANTS_DATA_PATH);
    const res = await fetch(url);
    const data = await res.json();
    return (data.merchants || []).filter((m) => m.active);
  } catch {
    return [];
  }
}

function onSearchInput() {
  const query = els.searchInput.value.trim().toLowerCase();
  const filtered = query
    ? allMerchants.filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          (m.domains || []).some((d) => d.toLowerCase().includes(query))
      )
    : allMerchants;
  renderStoreList(filtered);
}

function renderStoreList(merchants) {
  els.storeList.innerHTML = "";
  els.emptyState.hidden = merchants.length !== 0;

  const fragment = document.createDocumentFragment();
  for (const merchant of merchants.slice(0, 25)) {
    fragment.appendChild(buildStoreItem(merchant));
  }
  els.storeList.appendChild(fragment);
}

function buildStoreItem(merchant) {
  const li = document.createElement("li");
  li.className = "tlc-store-item";

  const initial = document.createElement("div");
  initial.className = "tlc-store-avatar";
  initial.textContent = merchant.name.charAt(0).toUpperCase();

  const info = document.createElement("div");
  info.className = "tlc-store-info";
  const name = document.createElement("span");
  name.className = "tlc-store-name";
  name.textContent = merchant.name;
  const rate = document.createElement("span");
  rate.className = "tlc-store-rate";
  rate.textContent = merchant.cashbackLabel;
  info.append(name, rate);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tlc-btn tlc-btn-outline tlc-btn-sm";
  button.textContent = "Activate";
  button.addEventListener("click", () => activateMerchant(merchant, button));

  li.append(initial, info, button);
  return li;
}

async function activateMerchant(merchant, button) {
  if (!merchant || !button) return;
  const userId = await getStorage(STORAGE_KEYS.USER_ID);
  if (!userId) {
    showAuthView();
    return;
  }

  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Activating…";

  const response = await chrome.runtime.sendMessage({
    type: "TLC_ACTIVATE_CASHBACK",
    merchant,
  });

  if (response?.ok) {
    button.textContent = "Activated ✓";
    if (activeMerchantForTab && activeMerchantForTab.id === merchant.id) {
      setStatus("active", "Cashback Active");
    }
  } else {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// ---------------------------------------------------------------------------
// chrome.storage helpers
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

function removeStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.remove([key], () => resolve());
  });
}
