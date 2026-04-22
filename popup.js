document.addEventListener("DOMContentLoaded", () => {
	// ─── DOM Elements ───────────────────────────────────────────────────────────
	const apiKeyInput = document.getElementById("apiKey");
	const modelSelect = document.getElementById("modelSelect");
	const saveBtn = document.getElementById("saveBtn");
	const statusDiv = document.getElementById("status");
	const keyView = document.getElementById("key-view");
	const keyEdit = document.getElementById("key-edit");
	const editKeyBtn = document.getElementById("editKeyBtn");

	// Memory viewer elements
	const memoryContent = document.getElementById("memoryContent");
	const memoryHostname = document.getElementById("memoryHostname");
	const memoryBadge = document.getElementById("memoryBadge");
	const memoryStats = document.getElementById("memoryStats");
	const clearSiteBtn = document.getElementById("clearSiteBtn");
	const clearAllBtn = document.getElementById("clearAllBtn");
	const optimizeSelectionBtn = document.getElementById("optimizeSelectionBtn");

	/** @type {string|null} The active tab's hostname */
	let currentHostname = null;

	// ─── Initialize ─────────────────────────────────────────────────────────────

	// Load preferences
	chrome.storage.local.get(["groqApiKey", "selectedModel"], (result) => {
		if (result.groqApiKey) {
			apiKeyInput.value = result.groqApiKey;
			showKeyView();
		} else {
			showKeyEdit();
		}

		if (result.selectedModel) {
			modelSelect.value = result.selectedModel;
		} else {
			modelSelect.value = "llama-3.3-70b-versatile";
		}
	});

	// Load memory viewer for active tab
	loadSiteMemory();

	// ─── Event Listeners ───────────────────────────────────────────────────────

	editKeyBtn.addEventListener("click", () => showKeyEdit());

	saveBtn.addEventListener("click", () => {
		const key = apiKeyInput.value.trim();
		const model = modelSelect.value;

		if (!key) {
			showStatus("Please enter an API key.", "#ef4444");
			return;
		}

		chrome.storage.local.set(
			{
				groqApiKey: key,
				selectedModel: model,
			},
			() => {
				showStatus("Preferences saved successfully!", "#10b981");
				showKeyView();
			},
		);
	});

	clearSiteBtn.addEventListener("click", () => {
		if (!currentHostname) return;
		chrome.storage.local.get(["curatedContext"], (result) => {
			const history = result.curatedContext || {};
			delete history[currentHostname];
			chrome.storage.local.set({ curatedContext: history }, () => {
				showStatus("Site context cleared!", "#10b981");
				loadSiteMemory();
			});
		});
	});

	clearAllBtn.addEventListener("click", () => {
		chrome.storage.local.set({ curatedContext: {} }, () => {
			showStatus("All contexts cleared!", "#10b981");
			loadSiteMemory();
		});
	});

	if (optimizeSelectionBtn) {
		optimizeSelectionBtn.addEventListener("click", () => {
			chrome.runtime.sendMessage(
				{ action: "optimizeCurrentSelection" },
				(response) => {
					if (chrome.runtime.lastError) {
						showStatus("Error: Extension context invalidated.", "#ef4444");
						return;
					}
					if (response?.error) {
						showStatus(response.error, "#ef4444");
					} else {
						window.close(); // Close popup on success
					}
				},
			);
		});
	}

	// ─── Memory Viewer ──────────────────────────────────────────────────────────

	/**
	 * Queries the active tab's hostname, reads optHistory from storage,
	 * and renders the memory entries for that site.
	 */
	async function loadSiteMemory() {
		try {
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});

			if (tab?.url) {
				try {
					currentHostname = new URL(tab.url).hostname;
				} catch {
					currentHostname = null;
				}
			}
		} catch {
			currentHostname = null;
		}

		chrome.storage.local.get(["curatedContext"], (result) => {
			const history = result.curatedContext || {};
			renderMemory(history);
		});
	}

	/**
	 * Renders memory entries for the current site + global stats.
	 * @param {Object} history - The full optHistory object
	 */
	function renderMemory(history) {
		const allHostnames = Object.keys(history);
		const totalEntries = allHostnames.reduce((sum, h) => {
			const entries =
				history[h]?.entries || (Array.isArray(history[h]) ? history[h] : []);
			return sum + entries.length;
		}, 0);

		// Global stats
		const totalSize = new Blob([JSON.stringify({ curatedContext: history })])
			.size;
		if (allHostnames.length > 0) {
			memoryStats.textContent = `${allHostnames.length} site${allHostnames.length !== 1 ? "s" : ""} · ${totalEntries} snippet${totalEntries !== 1 ? "s" : ""} · ${formatBytes(totalSize)}`;
		} else {
			memoryStats.textContent = "No context stored";
		}

		// Update clear all button state
		const hasAny = allHostnames.length > 0;
		clearAllBtn.disabled = !hasAny;
		clearAllBtn.style.opacity = hasAny ? "1" : "0.5";
		clearAllBtn.style.cursor = hasAny ? "pointer" : "not-allowed";

		// No active hostname
		if (!currentHostname) {
			memoryHostname.textContent = "Open a webpage to view its context";
			memoryBadge.classList.add("hidden");
			clearSiteBtn.classList.add("hidden");
			if (optimizeSelectionBtn) optimizeSelectionBtn.classList.add("hidden");
			memoryContent.innerHTML = "";
			return;
		}

		// Show hostname
		memoryHostname.textContent = currentHostname;

		// Get entries for this site
		const entries = history[currentHostname] || [];

		if (entries.length === 0) {
			memoryBadge.classList.add("hidden");
			clearSiteBtn.classList.add("hidden");
			if (optimizeSelectionBtn) optimizeSelectionBtn.classList.add("hidden");
			memoryContent.innerHTML = `
        <div class="memory-empty">
          No curated context for this site.<br>
          Highlight text and right-click "Add to Optimizer Context" to start.
        </div>
      `;
			return;
		}

		// Show badge and clear button
		memoryBadge.textContent = `${entries.length} snippet${entries.length !== 1 ? "s" : ""}`;
		memoryBadge.classList.remove("hidden");
		clearSiteBtn.classList.remove("hidden");
		if (optimizeSelectionBtn) optimizeSelectionBtn.classList.remove("hidden");

		// Render entries (newest first for display)
		const reversedEntries = [...entries].reverse();
		memoryContent.innerHTML = reversedEntries
			.map((entry, displayIndex) => {
				const realIndex = entries.length - 1 - displayIndex;
				const timeStr = entry.ts ? formatRelativeTime(entry.ts) : "unknown";
				const snippetPreview = truncate(entry.text || "(empty)", 250);

				return `
        <div class="memory-entry no-expand" data-index="${realIndex}">
          <div class="memory-entry-label">Snippet</div>
          <div class="memory-entry-text">${escapeHtml(snippetPreview)}</div>
          <div class="memory-entry-meta">
            <span class="memory-entry-time">${timeStr}</span>
          </div>
          <button class="memory-delete-btn" data-index="${realIndex}" title="Delete entry">🗑</button>
        </div>
      `;
			})
			.join("");

		// Attach click-to-expand handlers
		memoryContent.querySelectorAll(".memory-entry").forEach((card) => {
			card.addEventListener("click", (e) => {
				// Don't expand if clicking the delete button
				if (e.target.closest(".memory-delete-btn")) return;
				card.classList.toggle("expanded");
			});
			card.style.cursor = "pointer";
		});

		// Attach delete handlers
		memoryContent.querySelectorAll(".memory-delete-btn").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const index = parseInt(btn.dataset.index, 10);
				deleteEntry(currentHostname, index);
			});
		});
	}

	/**
	 * Deletes a single entry from a site's history and re-renders.
	 * @param {string} hostname
	 * @param {number} index - Index into the entries array
	 */
	function deleteEntry(hostname, index) {
		chrome.storage.local.get(["curatedContext"], (result) => {
			const history = result.curatedContext || {};
			const entries = history[hostname] || [];

			if (index < 0 || index >= entries.length) return;

			entries.splice(index, 1);

			if (entries.length === 0) {
				delete history[hostname];
			} else {
				history[hostname] = entries;
			}

			chrome.storage.local.set({ curatedContext: history }, () => {
				loadSiteMemory();
			});
		});
	}

	// ─── Utilities ──────────────────────────────────────────────────────────────

	/**
	 * Converts a unix timestamp to a relative human-readable string.
	 * @param {number} timestamp
	 * @returns {string}
	 */
	function formatRelativeTime(timestamp) {
		const now = Date.now();
		const diff = now - timestamp;
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);

		if (seconds < 60) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		return new Date(timestamp).toLocaleDateString();
	}

	/**
	 * Formats bytes into a human-readable string.
	 * @param {number} bytes
	 * @returns {string}
	 */
	function formatBytes(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	/**
	 * Truncates text to a maximum length with ellipsis.
	 * @param {string} text
	 * @param {number} maxLen
	 * @returns {string}
	 */
	function truncate(text, maxLen) {
		if (!text) return "";
		return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
	}

	/**
	 * Escapes HTML special characters to prevent XSS in rendered content.
	 * @param {string} str
	 * @returns {string}
	 */
	function escapeHtml(str) {
		const div = document.createElement("div");
		div.textContent = str;
		return div.innerHTML;
	}

	// ─── UI Helpers ─────────────────────────────────────────────────────────────

	function showKeyView() {
		keyView.classList.remove("hidden");
		keyEdit.classList.add("hidden");
	}

	function showKeyEdit() {
		keyView.classList.add("hidden");
		keyEdit.classList.remove("hidden");
		apiKeyInput.focus();
	}

	function showStatus(text, color) {
		statusDiv.textContent = text;
		statusDiv.style.color = color;
		statusDiv.style.opacity = "1";

		setTimeout(() => {
			statusDiv.style.opacity = "0";
			setTimeout(() => {
				statusDiv.textContent = "";
			}, 300);
		}, 2500);
	}
});
