/**
 * Groq Prompt Optimizer — Content Script
 * v1.0.0
 *
 * Injected into web pages to handle:
 * - Visually appealing native-style alert popup for loading/success/error statuses
 * - Text replacement in active input fields
 */

// ─── Unified Native Alert System ──────────────────────────────────────────────────

let groqAlertTimeout = null;
let currentProgressInterval = null;

function renderAlertDOM() {
	if (document.getElementById("groq-alert-modal")) return;
	const overlay = document.createElement("div");
	overlay.id = "groq-alert-overlay";
	document.body.appendChild(overlay);

	const modal = document.createElement("div");
	modal.id = "groq-alert-modal";
	modal.innerHTML = `
    <div class="groq-alert-header">
      <span class="groq-alert-icon" id="groq-alert-icon">⚡</span>
      <span id="groq-alert-title">Prompt Optimizer</span>
    </div>
    <div class="groq-alert-body" id="groq-alert-message"></div>
    <div class="groq-progress-container" id="groq-progress-container">
      <div class="groq-progress-bar" id="groq-progress-bar"></div>
    </div>
    <button class="groq-alert-btn groq-hidden" id="groq-alert-btn">OK</button>
  `;
	document.body.appendChild(modal);

	document
		.getElementById("groq-alert-btn")
		.addEventListener("click", hideLoading);
}

function updateAlert(opts) {
	renderAlertDOM();
	clearTimeout(groqAlertTimeout);
	clearInterval(currentProgressInterval);

	const modal = document.getElementById("groq-alert-modal");
	const overlay = document.getElementById("groq-alert-overlay");
	const title = document.getElementById("groq-alert-title");
	const icon = document.getElementById("groq-alert-icon");
	const msg = document.getElementById("groq-alert-message");
	const progContainer = document.getElementById("groq-progress-container");
	const progBar = document.getElementById("groq-progress-bar");
	const btn = document.getElementById("groq-alert-btn");

	title.textContent = opts.title;
	msg.textContent = opts.message;

	if (opts.type === "loading") {
		icon.textContent = "⚡";
		title.style.color = "#f8fafc";
		progContainer.classList.remove("groq-hidden");
		btn.classList.add("groq-hidden");

		progBar.style.width = "0%";
		progBar.style.background = "linear-gradient(90deg, #38bdf8, #818cf8)";

		let progress = 0;
		currentProgressInterval = setInterval(() => {
			progress += (90 - progress) * 0.15; // Smoothly ease to 90%
			progBar.style.width = `${progress}%`;
		}, 100);
	} else if (opts.type === "success") {
		icon.textContent = "✓";
		title.style.color = "#34d399";
		progContainer.classList.remove("groq-hidden");
		btn.classList.add("groq-hidden");

		progBar.style.width = "100%";
		progBar.style.background = "#34d399";

		// Auto collapse after success
		groqAlertTimeout = setTimeout(hideLoading, 2000);
	} else if (opts.type === "error") {
		icon.textContent = "❌";
		title.style.color = "#f87171";
		progContainer.classList.add("groq-hidden");
		btn.classList.remove("groq-hidden");
	}

	modal.classList.add("groq-show");
	overlay.classList.add("groq-show");
}

function hideLoading() {
	const modal = document.getElementById("groq-alert-modal");
	const overlay = document.getElementById("groq-alert-overlay");
	if (modal) {
		modal.classList.remove("groq-show");
		setTimeout(() => {
			if (modal.parentNode) modal.remove();
		}, 300);
	}
	if (overlay) {
		overlay.classList.remove("groq-show");
		setTimeout(() => {
			if (overlay.parentNode) overlay.remove();
		}, 300);
	}
	clearTimeout(groqAlertTimeout);
	clearInterval(currentProgressInterval);
}

function showLoading(modelName) {
	const displayName = modelName.includes("/")
		? modelName.split("/")[1]
		: modelName;
	const prettyName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
	updateAlert({
		type: "loading",
		title: "Optimizing Prompt...",
		message: `Using ${prettyName}`,
	});
}

function showToast(message, type = "error", _duration = 2000) {
	updateAlert({
		type: type,
		title: type === "error" ? "Optimization Failed" : "Success!",
		message: message,
	});
}

// ─── Message Handler ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
	// ── Capture AI Response from page ───────────────────────────────
	if (request.action === "captureResponse") {
		const hostname = window.location.hostname;
		const response =
			typeof extractLastResponse === "function"
				? extractLastResponse(hostname)
				: null;
		sendResponse({ response: response });
		return; // synchronous response
	}

	if (request.status === "loading") {
		showLoading(request.model || "AI");
	}

	if (request.error) {
		showToast(request.error, "error");
	}

	if (request.action === "replaceText") {
		const activeElement = document.activeElement;

		// Build success message with memory context info
		const memoryInfo = request.entryCount
			? ` (${request.entryCount} in memory)`
			: "";

		let replaced = false;

		if (
			activeElement &&
			(activeElement.tagName === "TEXTAREA" ||
				activeElement.tagName === "INPUT")
		) {
			const start = activeElement.selectionStart;
			const end = activeElement.selectionEnd;
			const text = activeElement.value;

			activeElement.value =
				text.slice(0, start) + request.text + text.slice(end);
			activeElement.dispatchEvent(new Event("input", { bubbles: true }));
			replaced = true;
		} else if (activeElement?.isContentEditable) {
			document.execCommand("insertText", false, request.text);
			replaced = true;
		}

		if (replaced) {
			showToast(`Prompt optimized${memoryInfo}`, "success", 2500);
		} else {
			navigator.clipboard.writeText(request.text).then(() => {
				showToast(
					`Copied to clipboard${memoryInfo}. (Could not auto-insert)`,
					"success",
					4000,
				);
			});
		}
	}
});

// ─── Cleanup on Context Invalidation ────────────────────────────────────────────

if (chrome.runtime?.id) {
	const port = chrome.runtime.connect();
	port.onDisconnect.addListener(() => {
		hideLoading();
		const styleEl = document.getElementById("groq-optimizer-styles");
		if (styleEl) styleEl.remove();
	});
}
