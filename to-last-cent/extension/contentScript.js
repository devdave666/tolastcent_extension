/**
 * To Last Cent — content script.
 *
 * Renders a cashback popup, docked to the left edge of the page, when the
 * current site is a known cashback merchant. Deliberately left rather than
 * the bottom-right corner most competing cashback extensions (Honey,
 * Rakuten, Capital One Shopping) default to — so ours doesn't get visually
 * buried under/behind a competitor's card fighting for the same pixels.
 *
 * Two states, sharing one edge anchor so switching between them doesn't
 * jump position:
 *  - "full": the bold entrance card with the big rate callout and an
 *    Activate/Refresh CTA. Shown on first detection, and whenever the edge
 *    tab is clicked to expand.
 *  - "compact": a slim edge-docked tab (icon + status dot only) once
 *    cashback is active. Exists so there's always something on screen to
 *    click if someone wants to re-assert tracking (e.g. right before
 *    checkout, or after using a competing extension) — previously, once
 *    activated, the card vanished for 24h with no way back in short of
 *    reloading the page — while staying far less visually intrusive than a
 *    floating card left open the whole session.
 *
 * `config.js` runs before this file (see manifest.json) and exposes
 * `self.TLC_CONFIG`.
 */

(function () {
  const { STORAGE_KEYS, BANNER_SNOOZE_MS } = self.TLC_CONFIG;
  const CONTAINER_ID = "tlc-cashback-popup";

  let currentMerchant = null;
  let containerEl = null;

  init();

  async function init() {
    const hostname = window.location.hostname;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLC_GET_MERCHANT_FOR_TAB",
        hostname,
      });
      if (response?.ok && response.merchant) {
        maybeShow(response.merchant, response.active);
      }
    } catch (err) {
      // Extension context may be reloading — fail silently.
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "TLC_MERCHANT_DETECTED" && message.merchant) {
      maybeShow(message.merchant, message.active);
    }
  });

  async function maybeShow(merchant, active) {
    currentMerchant = merchant;

    const dismissed = await getStorage(STORAGE_KEYS.DISMISSED_BANNERS);
    const dismissedAt = dismissed?.[merchant.id];
    if (dismissedAt && Date.now() - dismissedAt < BANNER_SNOOZE_MS) return;

    render(merchant, active ? "compact" : "full");
  }

  function render(merchant, mode) {
    if (document.getElementById(CONTAINER_ID)) return;

    containerEl = document.createElement("div");
    containerEl.id = CONTAINER_ID;
    containerEl.setAttribute("role", "complementary");
    containerEl.setAttribute("aria-label", "To Last Cent cashback");

    if (mode === "compact") {
      renderCompact(merchant);
    } else {
      renderFull(merchant, { isRefresh: false });
    }

    document.documentElement.appendChild(containerEl);
    requestAnimationFrame(() => containerEl.classList.add("tlc-visible"));
  }

  function renderCompact(merchant) {
    containerEl.classList.remove("tlc-activated");
    containerEl.classList.add("tlc-compact");
    containerEl.innerHTML = `
      <button
        type="button"
        class="tlc-edge-tab"
        data-action="expand"
        aria-label="To Last Cent — cashback active, click to refresh"
        title="Cashback active — click to refresh"
      >
        <span class="tlc-edge-mark">¢</span>
        <span class="tlc-edge-dot"></span>
      </button>
    `;
    containerEl.querySelector('[data-action="expand"]').addEventListener("click", () => {
      renderFull(merchant, { isRefresh: true });
    });
  }

  function renderFull(merchant, { isRefresh }) {
    containerEl.classList.remove("tlc-compact", "tlc-activated");
    const initial = merchant.name.charAt(0).toUpperCase();
    const ctaLabel = isRefresh ? "Refresh Tracking" : "Activate Cashback";

    containerEl.innerHTML = `
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
        ${ctaLabel}
      </button>
      <p class="tlc-popup-fineprint">No extra cost to your order</p>
      <p class="tlc-popup-warning">Using another cashback or coupon extension on this order may cost you this cashback. For the best chance, refresh To Last Cent right before checkout.</p>
    `;

    containerEl
      .querySelector('[data-action="activate"]')
      .addEventListener("click", (e) => onActivateClick(e, merchant, isRefresh));
    containerEl.querySelector('[data-action="dismiss"]').addEventListener("click", onDismissClick);
  }

  async function onActivateClick(event, merchant, isRefresh) {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Activating…";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "TLC_ACTIVATE_CASHBACK",
        merchant,
      });

      if (response?.ok) {
        button.textContent = isRefresh ? "Tracking Refreshed ✓" : "Cashback Activated ✓";
        containerEl.classList.add("tlc-activated");
        setTimeout(() => renderCompact(merchant), 1800);
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
    hide();
  }

  function hide() {
    if (!containerEl) return;
    containerEl.classList.remove("tlc-visible");
    setTimeout(() => containerEl?.remove(), 300);
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
