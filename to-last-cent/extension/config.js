/**
 * To Last Cent — shared extension configuration.
 * Loaded as a classic script by background.js (importScripts), content
 * scripts, and the popup, so it must not use ES module import/export.
 * Everything is attached to `self.TLC_CONFIG` (works in both the service
 * worker global scope and the window global scope).
 */
(function () {
  const TLC_CONFIG = {
    // Base URL of the To Last Cent backend API. Point this at your deployed
    // Express server (see /backend). Defaults to local dev.
    API_BASE_URL: "http://localhost:4000",

    // Public marketing site (GitHub Pages).
    WEBSITE_URL: "https://devdave666.github.io/tolastcent_extension",

    API_ROUTES: {
      BALANCE: "/api/v1/user/balance",
      REDIRECT: "/api/v1/redirect",
      MERCHANTS: "/api/v1/merchants",
      AUTH_LOGIN: "/api/v1/auth/login",
      AUTH_SIGNUP: "/api/v1/auth/signup",
    },

    // Local path (web-accessible) to the bundled merchant catalog used for
    // fast, offline domain-detection before the backend catalog is fetched.
    MERCHANTS_DATA_PATH: "data/merchants.json",

    // chrome.storage.local keys.
    STORAGE_KEYS: {
      USER_ID: "tlc_user_id",
      AUTH_TOKEN: "tlc_auth_token",
      BALANCE_CACHE: "tlc_balance_cache",
      MERCHANTS_CACHE: "tlc_merchants_cache",
      DISMISSED_BANNERS: "tlc_dismissed_banners",
      SETTINGS: "tlc_settings",
    },

    // How often (minutes) the background worker refreshes the balance and
    // merchant catalog via chrome.alarms.
    SYNC_INTERVAL_MINUTES: 30,

    // How long (ms) a dismissed banner stays hidden for a given merchant.
    BANNER_SNOOZE_MS: 1000 * 60 * 60 * 24, // 24h

    CJ_PUBLISHER_ID: "YOUR_CJ_PUBLISHER_ID",
  };

  self.TLC_CONFIG = TLC_CONFIG;
})();
