/**
 * To Last Cent — content script.
 *
 * Renders a cashback popup, docked to the left edge of the page, when the
 * current site is a known cashback merchant. Deliberately left rather than
 * the bottom-right corner most competing cashback extensions (Honey,
 * Rakuten, Capital One Shopping) default to — so ours doesn't get visually
 * buried under/behind a competitor's card fighting for the same pixels.
 *
 * Two shapes, sharing one edge anchor so switching between them doesn't
 * jump position:
 *  - "full": the bold entrance card with the big rate callout and an
 *    Activate/Refresh CTA. Shown on first detection (green edge tab isn't
 *    active yet), and whenever the edge tab is clicked to expand.
 *  - "compact" edge tab: icon + status dot only, in one of two colors —
 *    green ("active", cashback already tracking) or amber ("available",
 *    not yet activated). Reached either by cashback becoming active, or by
 *    dismissing the full card — dismissing used to hide everything for
 *    24h with no way back short of reloading the page; now it only
 *    downgrades to this small persistent tab, which stays reachable to
 *    reopen the full card on demand either way.
 *
 * `config.js` runs before this file (see manifest.json) and exposes
 * `self.TLC_CONFIG`.
 */

(function () {
  const { STORAGE_KEYS, BANNER_SNOOZE_MS } = self.TLC_CONFIG;
  const CONTAINER_ID = "tlc-cashback-popup";

  let currentMerchant = null;
  let containerEl = null;
  let dragState = null;

  // Attached once at module scope (rather than per-render) so dragging the
  // edge tab never accumulates duplicate document-level listeners across
  // repeated compact/full transitions.
  document.addEventListener("mousemove", (event) => {
    if (!dragState || !containerEl) return;
    const delta = event.clientY - dragState.startY;
    if (Math.abs(delta) > 4) dragState.moved = true;
    const maxTop = window.innerHeight - containerEl.offsetHeight - 8;
    const nextTop = Math.max(8, Math.min(dragState.startTop + delta, maxTop));
    containerEl.style.top = `${nextTop}px`;
    containerEl.style.bottom = "auto";
  });

  document.addEventListener("mouseup", async () => {
    if (!dragState || !containerEl) return;
    const { moved, onClick } = dragState;
    dragState = null;
    containerEl.classList.remove("tlc-dragging");

    if (moved) {
      const top = parseFloat(containerEl.style.top);
      await setStorage(STORAGE_KEYS.TAB_POSITION, top);
    } else {
      onClick();
    }
  });

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

    if (active) {
      render(merchant, "compact-active");
      return;
    }

    // Dismissing the full card used to suppress everything for 24h with no
    // way back short of reloading — now it only downgrades to the small
    // edge tab (still available to open on demand), never to nothing.
    const dismissed = await getStorage(STORAGE_KEYS.DISMISSED_BANNERS);
    const dismissedAt = dismissed?.[merchant.id];
    const isDismissed = dismissedAt && Date.now() - dismissedAt < BANNER_SNOOZE_MS;

    render(merchant, isDismissed ? "compact-available" : "full");
  }

  async function render(merchant, mode) {
    if (document.getElementById(CONTAINER_ID)) return;

    containerEl = document.createElement("div");
    containerEl.id = CONTAINER_ID;
    containerEl.setAttribute("role", "complementary");
    containerEl.setAttribute("aria-label", "To Last Cent cashback");

    await applySavedPosition();

    if (mode === "compact-active") {
      renderCompact(merchant, { active: true });
    } else if (mode === "compact-available") {
      renderCompact(merchant, { active: false });
    } else {
      renderFull(merchant, { isRefresh: false });
    }

    document.documentElement.appendChild(containerEl);
    requestAnimationFrame(() => containerEl.classList.add("tlc-visible"));
  }

  /** Remembers where the user last dragged the edge tab so it stays put
   *  across page loads, instead of resetting to the default spot every time. */
  async function applySavedPosition() {
    const savedTop = await getStorage(STORAGE_KEYS.TAB_POSITION);
    if (typeof savedTop === "number") {
      containerEl.style.top = `${savedTop}px`;
      containerEl.style.bottom = "auto";
    }
  }

  function renderCompact(merchant, { active }) {
    containerEl.classList.remove("tlc-activated");
    containerEl.classList.add("tlc-compact");
    containerEl.classList.toggle("tlc-compact-active", active);
    containerEl.classList.toggle("tlc-compact-available", !active);

    const label = active
      ? "To Last Cent — cashback active. Click to refresh, or drag to reposition."
      : "To Last Cent — cashback available. Click to view the offer, or drag to reposition.";
    const title = active
      ? "Cashback active — click to refresh, drag to reposition"
      : "Cashback available — click to view offer, drag to reposition";

    containerEl.innerHTML = `
      <button
        type="button"
        class="tlc-edge-tab"
        data-action="expand"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(title)}"
      >
        <span class="tlc-edge-mark">¢</span>
        <span class="tlc-edge-dot"></span>
      </button>
    `;
    const tab = containerEl.querySelector('[data-action="expand"]');
    makeDraggable(tab, () => renderFull(merchant, { isRefresh: active }));
  }

  /**
   * Vertical drag-to-reposition along the left edge — keeps the "docked
   * ribbon" look (still flush against the edge) while letting the user
   * move it out of the way of page content, the way Honey's badge can be
   * dragged. A plain click (no meaningful movement) still expands the
   * full card; only an actual drag is treated as a reposition. The
   * document-level mousemove/mouseup listeners live at module scope (see
   * top of file) — this just arms them via mousedown on the current handle.
   */
  function makeDraggable(handle, onClick) {
    handle.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      dragState = {
        startY: event.clientY,
        startTop: containerEl.getBoundingClientRect().top,
        moved: false,
        onClick,
      };
      containerEl.classList.add("tlc-dragging");
      event.preventDefault();
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
    containerEl
      .querySelector('[data-action="dismiss"]')
      .addEventListener("click", () => onDismissClick(merchant, isRefresh));

    // The much-taller full card can overflow past the viewport bottom if it
    // opens at a `top` position that was only valid for the short edge tab
    // (e.g. dragged near the bottom of the screen) — pull it up if needed.
    if (containerEl.style.top) {
      const maxTop = window.innerHeight - containerEl.offsetHeight - 8;
      if (parseFloat(containerEl.style.top) > maxTop) {
        containerEl.style.top = `${Math.max(8, maxTop)}px`;
      }
    }
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
        setTimeout(() => renderCompact(merchant, { active: true }), 1800);
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

  /**
   * Dismissing the full card no longer removes the popup entirely — that
   * left no way back in short of reloading the page. It now collapses to
   * the small edge tab instead, which stays clickable to reopen the full
   * card on demand.
   */
  async function onDismissClick(merchant, active) {
    await chrome.runtime.sendMessage({
      type: "TLC_DISMISS_BANNER",
      merchantId: merchant.id,
    });
    renderCompact(merchant, { active });
  }

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

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  }
})();
