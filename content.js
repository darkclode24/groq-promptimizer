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
      <div class="groq-alert-icon" id="groq-alert-icon">⚡</div>
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

function renderToastDOM() {
	if (document.getElementById("groq-toast")) return;
	const toast = document.createElement("div");
	toast.id = "groq-toast";
	toast.innerHTML = `
    <div class="groq-alert-icon" id="groq-toast-icon">✓</div>
    <div class="groq-alert-body" id="groq-toast-message"></div>
  `;
	document.body.appendChild(toast);
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

		let progress = 0;
		currentProgressInterval = setInterval(() => {
			progress += (90 - progress) * 0.1; // Smoothly ease to 90%
			progBar.style.width = `${progress}%`;
		}, 100);

		modal.classList.add("groq-show");
		overlay.classList.add("groq-show");
	} else if (opts.type === "error") {
		// For errors in modal context (e.g. timeout during optimization)
		icon.textContent = "❌";
		title.style.color = "#f87171";
		progContainer.classList.add("groq-hidden");
		btn.classList.remove("groq-hidden");
		modal.classList.add("groq-show");
		overlay.classList.add("groq-show");
	}
}

function hideLoading() {
	const modal = document.getElementById("groq-alert-modal");
	const overlay = document.getElementById("groq-alert-overlay");
	if (modal) {
		modal.classList.remove("groq-show");
		setTimeout(() => modal.remove(), 400);
	}
	if (overlay) {
		overlay.classList.remove("groq-show");
		setTimeout(() => overlay.remove(), 400);
	}
	clearTimeout(groqAlertTimeout);
	clearInterval(currentProgressInterval);
}

function showToast(message, type = "success", duration = 3000) {
	renderToastDOM();
	const toast = document.getElementById("groq-toast");
	const icon = document.getElementById("groq-toast-icon");
	const msg = document.getElementById("groq-toast-message");

	msg.textContent = message;
	if (type === "success") {
		icon.textContent = "✓";
		icon.style.color = "#10b981";
	} else if (type === "error") {
		icon.textContent = "❌";
		icon.style.color = "#f87171";
	} else {
		icon.textContent = "⚡";
		icon.style.color = "#818cf8";
	}

	// Snappy show
	requestAnimationFrame(() => {
		toast.classList.add("groq-show");
	});

	clearTimeout(groqAlertTimeout);
	groqAlertTimeout = setTimeout(() => {
		toast.classList.remove("groq-show");
		setTimeout(() => toast.remove(), 400);
	}, duration);
}

function showLoading(modelName) {
	const displayName = modelName.includes("/")
		? modelName.split("/")[1]
		: modelName;
	const prettyName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
	updateAlert({
		type: "loading",
		title: "Optimizing...",
		message: `Drafting with ${prettyName}`,
	});
}

// ─── Message Handler ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
	if (request.action === "captureResponse") {
		const hostname = window.location.hostname;
		const response =
			typeof extractLastResponse === "function"
				? extractLastResponse(hostname)
				: null;
		sendResponse({ response: response });
		return;
	}

	if (request.status === "loading") {
		showLoading(request.model || "AI");
	}

	if (request.error) {
		hideLoading();
		showToast(request.error, "error", 4000);
	}

	if (request.action === "toast") {
		showToast(
			request.message,
			request.type || "success",
			request.duration || 3000,
		);
	}

	if (request.action === "replaceText") {
		hideLoading();
		const activeElement = document.activeElement;
		const memoryInfo = request.entryCount
			? ` (+${request.entryCount} context)`
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
			showToast(`Prompt Refined${memoryInfo}`, "success");
		} else {
			navigator.clipboard.writeText(request.text).then(() => {
				showToast(`Copied to clipboard${memoryInfo}`, "success");
			});
		}
	}
});

// ─── Cleanup ────────────────────────────────────────────────────────────────────

if (chrome.runtime?.id) {
	const port = chrome.runtime.connect();
	port.onDisconnect.addListener(() => {
		hideLoading();
		const toast = document.getElementById("groq-toast");
		if (toast) toast.remove();
	});
}
