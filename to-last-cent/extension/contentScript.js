/**
 * To Last Cent — content script.
 *
 * Renders a dark/emerald "Activate Cashback" banner at the top of the page
 * when the current site is a known cashback merchant. `config.js` runs
 * before this file (see manifest.json) and exposes `self.TLC_CONFIG`.
 */

(function () {
  const { STORAGE_KEYS, BANNER_SNOOZE_MS } = self.TLC_CONFIG;
  const BANNER_ID = "tlc-cashback-banner";

  let currentMerchant = null;
  let bannerEl = null;

  init();

  async function init() {
    const hostname = window.location.hostname;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLC_GET_MERCHANT_FOR_TAB",
        hostname,
      });
      if (response?.ok && response.merchant) {
        maybeShowBanner(response.merchant, response.active);
      }
    } catch (err) {
      // Extension context may be reloading — fail silently.
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TLC_MERCHANT_DETECTED" && message.merchant) {
      maybeShowBanner(message.merchant, message.active);
    }
  });

  async function maybeShowBanner(merchant, active) {
    if (active) return; // already activated for this merchant this session
    currentMerchant = merchant;

    const dismissed = await getStorage(STORAGE_KEYS.DISMISSED_BANNERS);
    const dismissedAt = dismissed?.[merchant.id];
    if (dismissedAt && Date.now() - dismissedAt < BANNER_SNOOZE_MS) return;

    renderBanner(merchant);
  }

  function renderBanner(merchant) {
    if (document.getElementById(BANNER_ID)) return;

    bannerEl = document.createElement("div");
    bannerEl.id = BANNER_ID;
    bannerEl.setAttribute("role", "complementary");
    bannerEl.innerHTML = `
      <div class="tlc-banner-inner">
        <div class="tlc-banner-brand">
          <span class="tlc-banner-dot"></span>
          <span class="tlc-banner-logo">To Last Cent</span>
        </div>
        <div class="tlc-banner-message">
          <strong>${escapeHtml(merchant.name)}</strong> offers
          <span class="tlc-banner-rate">${escapeHtml(merchant.cashbackLabel)}</span>
          — activate before you check out.
        </div>
        <div class="tlc-banner-actions">
          <button type="button" class="tlc-btn tlc-btn-primary" data-action="activate">
            Activate Cashback
          </button>
          <button type="button" class="tlc-btn-icon" data-action="dismiss" aria-label="Dismiss">
            &times;
          </button>
        </div>
      </div>
    `;

    document.documentElement.prepend(bannerEl);
    requestAnimationFrame(() => bannerEl.classList.add("tlc-visible"));

    bannerEl
      .querySelector('[data-action="activate"]')
      .addEventListener("click", onActivateClick);
    bannerEl
      .querySelector('[data-action="dismiss"]')
      .addEventListener("click", onDismissClick);
  }

  async function onActivateClick(event) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Activating…";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLC_ACTIVATE_CASHBACK",
        merchant: currentMerchant,
      });

      if (response?.ok) {
        button.textContent = "Cashback Activated ✓";
        bannerEl.classList.add("tlc-activated");
        setTimeout(hideBanner, 3500);
      } else if (response?.error === "not_authenticated") {
        button.disabled = false;
        button.textContent = "Sign in to activate";
        button.addEventListener(
          "click",
          () => chrome.runtime.sendMessage({ type: "TLC_OPEN_POPUP" }),
          { once: true }
        );
      } else {
        button.disabled = false;
        button.textContent = "Try again";
      }
    } catch (err) {
      button.disabled = false;
      button.textContent = "Try again";
    }
  }

  async function onDismissClick() {
    if (currentMerchant) {
      await chrome.runtime.sendMessage({
        type: "TLC_DISMISS_BANNER",
        merchantId: currentMerchant.id,
      });
    }
    hideBanner();
  }

  function hideBanner() {
    if (!bannerEl) return;
    bannerEl.classList.remove("tlc-visible");
    setTimeout(() => bannerEl?.remove(), 300);
  }

  function getStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => resolve(result[key]));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }
})();
