/**
 * To Last Cent — content script.
 *
 * Renders a floating "Activate Cashback" popup card, bottom-left, when the
 * current site is a known cashback merchant. Deliberately bottom-left
 * rather than the bottom-right corner most competing cashback extensions
 * (Honey, Rakuten, Capital One Shopping) default to — so ours doesn't get
 * visually buried under/behind a competitor's card fighting for the same
 * pixels. `config.js` runs before this file (see manifest.json) and
 * exposes `self.TLC_CONFIG`.
 */

(function () {
  const { STORAGE_KEYS, BANNER_SNOOZE_MS } = self.TLC_CONFIG;
  const POPUP_ID = "tlc-cashback-popup";

  let currentMerchant = null;
  let popupEl = null;

  init();

  async function init() {
    const hostname = window.location.hostname;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLC_GET_MERCHANT_FOR_TAB",
        hostname,
      });
      if (response?.ok && response.merchant) {
        maybeShowPopup(response.merchant, response.active);
      }
    } catch (err) {
      // Extension context may be reloading — fail silently.
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TLC_MERCHANT_DETECTED" && message.merchant) {
      maybeShowPopup(message.merchant, message.active);
    }
  });

  async function maybeShowPopup(merchant, active) {
    if (active) return; // already activated for this merchant this session
    currentMerchant = merchant;

    const dismissed = await getStorage(STORAGE_KEYS.DISMISSED_BANNERS);
    const dismissedAt = dismissed?.[merchant.id];
    if (dismissedAt && Date.now() - dismissedAt < BANNER_SNOOZE_MS) return;

    renderPopup(merchant);
  }

  function renderPopup(merchant) {
    if (document.getElementById(POPUP_ID)) return;

    const initial = merchant.name.charAt(0).toUpperCase();

    popupEl = document.createElement("div");
    popupEl.id = POPUP_ID;
    popupEl.setAttribute("role", "complementary");
    popupEl.setAttribute("aria-label", "To Last Cent cashback offer");
    popupEl.innerHTML = `
      <button type="button" class="tlc-popup-close" data-action="dismiss" aria-label="Dismiss">
        &times;
      </button>
      <div class="tlc-popup-brand">
        <span class="tlc-popup-mark">¢</span>
        <span class="tlc-popup-brand-name">To Last Cent</span>
        <span class="tlc-popup-verified">Verified tracking</span>
      </div>
      <div class="tlc-popup-body">
        <div class="tlc-popup-store">
          <span class="tlc-popup-avatar">${escapeHtml(initial)}</span>
          <span class="tlc-popup-store-name">${escapeHtml(merchant.name)}</span>
        </div>
        <div class="tlc-popup-rate-row">
          <span class="tlc-popup-rate">${escapeHtml(merchant.cashbackLabel)}</span>
          <span class="tlc-popup-rate-caption">available right now</span>
        </div>
      </div>
      <button type="button" class="tlc-popup-cta" data-action="activate">
        Activate Cashback
      </button>
      <p class="tlc-popup-fineprint">No extra cost · Powered by CJ Affiliate</p>
    `;

    document.documentElement.appendChild(popupEl);
    requestAnimationFrame(() => popupEl.classList.add("tlc-visible"));

    popupEl
      .querySelector('[data-action="activate"]')
      .addEventListener("click", onActivateClick);
    popupEl
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
        popupEl.classList.add("tlc-activated");
        setTimeout(hidePopup, 3500);
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
    hidePopup();
  }

  function hidePopup() {
    if (!popupEl) return;
    popupEl.classList.remove("tlc-visible");
    setTimeout(() => popupEl?.remove(), 300);
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
