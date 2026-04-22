/**
 * Groq Prompt Optimizer — Background Service Worker
 * v1.0.0 — Production Release
 *
 * Handles context menu creation, keyboard shortcut listening,
 * Groq API communication, and optimization history management.
 */

// ─── Configuration ──────────────────────────────────────────────────────────────

const CONFIG = {
	API_ENDPOINT: "https://api.groq.com/openai/v1/chat/completions",
	REQUEST_TIMEOUT_MS: 15000,
	DEFAULT_MODEL: "llama-3.3-70b-versatile",
	HISTORY: {
		MAX_ENTRIES_PER_SITE: 3,
		MAX_HOSTNAMES: 20,
		TTL_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
		STORAGE_SAFETY_BYTES: 4 * 1024 * 1024, // 4MB (limit is 5MB)
	},
	// Rough context window sizes (in tokens) for budget awareness
	MODEL_CONTEXT_WINDOWS: {
		"llama-3.3-70b-versatile": 128000,
		"meta-llama/llama-4-scout-17b-16e-instruct": 131072,
		"openai/gpt-oss-120b": 131072,
		"qwen/qwen3-32b": 32768,
	},
};

// ─── Core System Instruction ────────────────────────────────────────────────────

const CORE_SYSTEM_INSTRUCTION = `You are a Prompt Optimizer. You ONLY rewrite prompts — never execute them.

<RULES>
1. OUTPUT the optimized prompt directly. No preamble, commentary, or code block wrappers.
2. STRUCTURE using relevant sections from: Role, Context, Task, Requirements, Constraints, Output Format, Tone. Omit sections that don't apply.
3. SHARPEN vague language into specific, actionable instructions. Preserve the user's explicit terms and intent.
4. CONTEXT FILLING: Use your knowledge to define known tools/concepts. Use [PLACEHOLDER] only for truly unknown user-specific values (file paths, project names, versions).
5. FOLLOW-UPS: When conversation history is provided, write the prompt as a contextual follow-up — reference prior exchanges, don't repeat background.
</RULES>

<EXAMPLES>
In: "explain how memory works in computers"
Out:
# Role
You are a computer science educator.
# Task
Explain how computer memory works, covering the hierarchy from registers and cache to RAM and virtual memory.
# Constraints
Use analogies for accessibility. Avoid unnecessary jargon.
# Output Format
Structured explanation with a brief summary.

In: "help me write a professional email declining a meeting"
Out:
# Context
User needs to compose a professional email politely declining a meeting invitation.
# Task
Draft a concise, professional email that declines the meeting while maintaining a positive relationship. Offer an alternative (e.g., async update or rescheduled time).
# Tone
Polite, professional, and constructive.
</EXAMPLES>

Remember: Output ONLY the optimized prompt. Never answer, execute, or discuss the task itself.`;

// ─── State ──────────────────────────────────────────────────────────────────────

/** @type {AbortController|null} Active request controller for cancellation */
let activeController = null;

// ─── Context Menu Setup ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
	chrome.contextMenus.create({
		id: "optimize-prompt",
		title: "Optimize with Groq",
		contexts: ["selection"],
	});
	chrome.contextMenus.create({
		id: "add-to-context",
		title: "Add to Optimizer Context",
		contexts: ["selection"],
	});
});

// ─── Restricted Page Check ──────────────────────────────────────────────────────

/**
 * Determines if a URL belongs to a restricted browser page where
 * content scripts cannot be injected.
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isRestrictedPage(url) {
	if (!url) return true;
	const restrictedProtocols = [
		"chrome:",
		"edge:",
		"about:",
		"brave:",
		"view-source:",
	];
	const restrictedHosts = ["chrome.google.com/webstore"];

	return (
		restrictedProtocols.some((p) => url.startsWith(p)) ||
		restrictedHosts.some((h) => url.includes(h))
	);
}

// ─── Event Listeners ────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
	if (isRestrictedPage(tab?.url)) {
		console.warn("Cannot perform actions on restricted browser pages.");
		return;
	}
	if (info.menuItemId === "optimize-prompt") {
		handleOptimization(info.selectionText, tab);
	} else if (info.menuItemId === "add-to-context") {
		addToCuratedContext(info.selectionText, tab);
	}
});

async function addToCuratedContext(text, tab) {
	try {
		const hostname = new URL(tab.url).hostname;
		const result = await chrome.storage.local.get(["curatedContext"]);
		const contextMap = result.curatedContext || {};
		const siteContext = contextMap[hostname] || [];

		siteContext.push({
			id: Date.now().toString() + Math.random().toString(36).substring(2, 9),
			text: text.trim(),
			ts: Date.now(),
		});

		contextMap[hostname] = siteContext;
		await chrome.storage.local.set({ curatedContext: contextMap });

		sendMessageToTab(tab.id, {
			action: "toast",
			message: "Added to Optimizer Context",
			type: "success",
			duration: 2500,
		});
	} catch (err) {
		console.error("Failed to add context:", err);
		sendMessageToTab(tab.id, {
			action: "toast",
			message: "Failed to add context",
			type: "error",
			duration: 2500,
		});
	}
}

// Handle messages from the popup (e.g. Optimize Current Selection)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "optimizeCurrentSelection") {
		(async () => {
			try {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				if (!tab || isRestrictedPage(tab.url)) {
					sendResponse({ error: "Cannot optimize on restricted pages." });
					return;
				}

				const [{ result: selectedText }] = await chrome.scripting.executeScript(
					{
						target: { tabId: tab.id },
						func: () => window.getSelection().toString(),
					},
				);

				if (!selectedText || selectedText.trim().length === 0) {
					sendResponse({
						error: "No text selected. Highlight a prompt first.",
					});
					return;
				}

				handleOptimization(selectedText, tab);
				sendResponse({ success: true });
			} catch (err) {
				sendResponse({ error: "Could not capture selection." });
			}
		})();
		return true; // Keep message channel open for async response
	}
});

chrome.commands.onCommand.addListener(async (command) => {
	if (command !== "optimize-selection" && command !== "add-to-context") return;

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab) return;

	if (isRestrictedPage(tab.url)) {
		console.warn("Cannot perform actions on restricted browser pages.");
		return;
	}

	try {
		const [{ result: selectedText }] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			func: () => window.getSelection().toString(),
		});

		if (!selectedText || selectedText.trim().length === 0) {
			sendMessageToTab(tab.id, {
				error: `No text selected. Highlight a ${command === "add-to-context" ? "snippet" : "prompt"} first.`,
			});
			return;
		}

		if (command === "optimize-selection") {
			handleOptimization(selectedText, tab);
		} else {
			addToCuratedContext(selectedText, tab);
		}
	} catch (err) {
		console.error("Selection capture failed:", err);
		sendMessageToTab(tab.id, {
			error: "Could not capture selection. Refresh the page.",
		});
	}
});

// ─── Optimization Handler ───────────────────────────────────────────────────────

/**
 * Unified optimization flow: reads storage, calls API, saves history, responds.
 * Cancels any in-flight request before starting a new one.
 * @param {string} rawText - The user-selected text to optimize
 * @param {chrome.tabs.Tab} tab - The active tab
 */
async function handleOptimization(rawText, tab) {
	// Cancel any in-flight request
	if (activeController) {
		activeController.abort();
		activeController = null;
	}

	let hostname = "unknown";
	try {
		hostname = new URL(tab.url).hostname;
	} catch (_e) {
		console.error("Could not parse URL:", tab.url);
	}

	try {
		const result = await chrome.storage.local.get([
			"groqApiKey",
			"selectedModel",
			"optHistory",
			"curatedContext",
		]);
		const apiKey = result.groqApiKey;
		const model = result.selectedModel || CONFIG.DEFAULT_MODEL;
		let history = result.optHistory || {};
		const curatedContextMap = result.curatedContext || {};

		if (!apiKey) {
			sendMessageToTab(tab.id, {
				error: "No API key found. Configure the extension.",
			});
			return;
		}

		// Capture the latest AI response from the page (if on an AI chat site)
		let capturedResponse = null;
		try {
			const resp = await chrome.tabs.sendMessage(tab.id, {
				action: "captureResponse",
			});
			capturedResponse = resp?.response
				? truncateText(resp.response, 800)
				: null;
		} catch {
			// Silently fail — page may not be an AI chat site or content script not ready
		}

		// Prune stale entries before reading
		history = pruneHistory(history);
		const siteHistory = history[hostname]?.entries || [];

		const siteCuratedContext = curatedContextMap[hostname] || [];

		sendMessageToTab(tab.id, { status: "loading", model: model });

		const optimizedText = await callGroqAPI(
			rawText,
			apiKey,
			model,
			siteHistory,
			siteCuratedContext,
		);

		// Update history: store optimizer output (a) and site AI response (r) — no raw user input
		const now = Date.now();
		const newEntry = {
			a: truncateText(optimizedText, 400),
			r: capturedResponse,
			ts: now,
		};
		if (!history[hostname]) {
			history[hostname] = { entries: [], lastUsed: now };
		}
		history[hostname].entries = [...siteHistory, newEntry].slice(
			-CONFIG.HISTORY.MAX_ENTRIES_PER_SITE,
		);
		history[hostname].lastUsed = now;

		// Safe write with quota protection
		await safeSetHistory(history);

		sendMessageToTab(tab.id, {
			action: "replaceText",
			text: optimizedText,
			hostname: hostname,
			entryCount: history[hostname]?.entries?.length || 0,
		});
	} catch (error) {
		sendMessageToTab(tab.id, { error: error.message });
	}
}

// ─── Groq API Call ──────────────────────────────────────────────────────────────

/**
 * Calls the Groq API with model-aware system instructions and multi-message history.
 * History entries contain: a (optimizer output) and r (site AI response).
 * @param {string} prompt - Raw user prompt text
 * @param {string} apiKey - Groq API key
 * @param {string} model - Model identifier
 * @param {Array<{a: string, r: string|null, ts: number}>} history - Site conversation history
 * @param {Array<{id: string, text: string, ts: number}>} curatedContext - User manually selected snippets
 * @returns {Promise<string>} Optimized prompt text
 */
async function callGroqAPI(
	prompt,
	apiKey,
	model,
	history = [],
	curatedContext = [],
) {
	// Build system instruction with model-specific addendum
	const systemContent = CORE_SYSTEM_INSTRUCTION + getModelAddendum(model);

	// Build messages array: system → context → current prompt
	const messages = [{ role: "system", content: systemContent }];

	// Use curated context if available, otherwise fallback to automatic history
	if (curatedContext.length > 0) {
		const curatedBlock = curatedContext
			.map((c, i) => `--- Snippet ${i + 1} ---\n${c.text}`)
			.join("\n\n");
		messages.push({
			role: "user",
			content: `[Curated Context selected by user — use this explicit context to optimize the prompt]:\n${curatedBlock}`,
		});
		messages.push({
			role: "assistant",
			content:
				"Understood. I will strictly use the curated snippets provided as context for the prompt optimization.",
		});
	} else if (history.length > 0) {
		const contextBlock = history
			.map((turn, i) => {
				let block = `--- Turn ${i + 1} ---\nOptimized prompt sent: ${turn.a}`;
				if (turn.r) {
					block += `\n[Site AI responded]: ${turn.r}`;
				}
				return block;
			})
			.join("\n\n");

		messages.push({
			role: "user",
			content: `[Conversation context from this site — use this to optimize follow-up prompts]:\n${contextBlock}`,
		});
		messages.push({
			role: "assistant",
			content:
				"Understood. I have the conversation context and will optimize the next prompt accordingly.",
		});
	}

	// Token budget check: trim history if we're approaching context limits
	const contextWindow = CONFIG.MODEL_CONTEXT_WINDOWS[model] || 32768;
	const budgetLimit = Math.floor(contextWindow * 0.8);
	trimMessagesToBudget(messages, prompt, budgetLimit);

	messages.push({
		role: "user",
		content: `[USER INPUT TO OPTIMIZE]:\n"""\n${prompt}\n"""`,
	});

	const payload = {
		model: model,
		messages: messages,
		temperature: 0.1,
		max_tokens: 2048,
	};

	// Create a new abort controller for this request
	activeController = new AbortController();
	const timeoutId = setTimeout(
		() => activeController.abort(),
		CONFIG.REQUEST_TIMEOUT_MS,
	);

	try {
		const response = await fetch(CONFIG.API_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
			signal: activeController.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			const errData = await response.json().catch(() => ({}));
			throw new Error(
				errData.error?.message || `API HTTP Error: ${response.status}`,
			);
		}

		const data = await response.json();
		if (!data.choices?.[0]?.message) {
			throw new Error("Invalid response structure from API.");
		}

		let content = data.choices[0].message.content.trim();

		// ── Pre-processing / Cleaning ─────────────────────────────────
		// 1. Strip thinking blocks (common in reasoning models)
		content = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

		// 2. Extract from markdown code blocks if the model wrapped it
		// (matches ```[lang] ... ``` and takes the content)
		const codeBlockMatch = content.match(/```(?:[a-z]*)\n?([\s\S]*?)```/i);
		if (codeBlockMatch?.[1]) {
			content = codeBlockMatch[1].trim();
		}

		return content;
	} catch (error) {
		clearTimeout(timeoutId);
		if (error.name === "AbortError") {
			throw new Error(
				`API request timed out after ${CONFIG.REQUEST_TIMEOUT_MS / 1000} seconds.`,
			);
		}
		throw error;
	} finally {
		activeController = null;
	}
}

// ─── Model-Aware Instruction Routing ────────────────────────────────────────────

/**
 * Returns a model-specific addendum to append to the core system instruction.
 * Reasoning-capable models get explicit chain-of-thought guidance.
 * @param {string} model - Model identifier
 * @returns {string}
 */
function getModelAddendum(model) {
	const lower = model.toLowerCase();
	if (lower.includes("qwen") || lower.includes("r1")) {
		return "\n\nUse step-by-step reasoning to analyze the input before producing the optimized prompt. Place your reasoning in a <think> block, then output the final optimized prompt outside of it.";
	}
	return "";
}

// ─── Token Budget Management ────────────────────────────────────────────────────

/**
 * Rough token estimation (~4 characters per token).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}

/**
 * Truncates text to a maximum character length, preserving word boundaries.
 * @param {string} text
 * @param {number} maxLen - Maximum characters
 * @returns {string}
 */
function truncateText(text, maxLen) {
	if (!text || text.length <= maxLen) return text;
	// Cut at the last space before maxLen to avoid mid-word truncation
	const truncated = text.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	return `${lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated}…`;
}

/**
 * Trims the oldest history message pairs from the messages array
 * if the total estimated tokens exceed the budget.
 * Mutates the messages array in place.
 * @param {Array<{role: string, content: string}>} messages - Messages array (system + history)
 * @param {string} currentPrompt - The current user prompt (not yet in the array)
 * @param {number} budgetTokens - Maximum token budget
 */
function trimMessagesToBudget(messages, currentPrompt, budgetTokens) {
	const currentPromptTokens = estimateTokens(currentPrompt);
	const maxTokensForReply = 2048;

	while (messages.length > 1) {
		const totalTokens =
			messages.reduce((sum, m) => sum + estimateTokens(m.content), 0) +
			currentPromptTokens +
			maxTokensForReply;

		if (totalTokens <= budgetTokens) break;

		// Remove oldest user/assistant pair (index 1 and 2, right after system message)
		messages.splice(1, 2);
	}
}

// ─── History Management ─────────────────────────────────────────────────────────

/**
 * Prunes history by removing expired entries (TTL) and evicting
 * least-recently-used hostnames when the global cap is exceeded.
 * @param {Object} history - The raw optHistory object from storage
 * @returns {Object} Pruned history
 */
function pruneHistory(history) {
	const now = Date.now();
	const pruned = {};

	// Pass 1: Remove expired entries and empty hostnames
	for (const [host, data] of Object.entries(history)) {
		// Migrate legacy format: array → { entries, lastUsed }
		const entries = Array.isArray(data) ? data : data.entries || [];
		const lastUsed = data.lastUsed || now;

		const validEntries = entries.filter(
			(entry) => entry.ts && now - entry.ts < CONFIG.HISTORY.TTL_MS,
		);

		if (validEntries.length > 0) {
			pruned[host] = {
				entries: validEntries.slice(-CONFIG.HISTORY.MAX_ENTRIES_PER_SITE),
				lastUsed: lastUsed,
			};
		}
	}

	// Pass 2: Evict LRU hostnames if over the global cap
	const hostnames = Object.keys(pruned);
	if (hostnames.length > CONFIG.HISTORY.MAX_HOSTNAMES) {
		const sorted = hostnames.sort(
			(a, b) => pruned[a].lastUsed - pruned[b].lastUsed,
		);
		const toEvict = sorted.slice(
			0,
			hostnames.length - CONFIG.HISTORY.MAX_HOSTNAMES,
		);
		for (const host of toEvict) {
			delete pruned[host];
		}
	}

	return pruned;
}

/**
 * Writes history to storage with quota protection.
 * If the serialized size approaches the storage limit, performs
 * aggressive pruning before writing.
 * @param {Object} history - Pruned history object
 */
async function safeSetHistory(history) {
	let pruned = pruneHistory(history);
	const sizeEstimate = new Blob([JSON.stringify({ optHistory: pruned })]).size;

	if (sizeEstimate > CONFIG.HISTORY.STORAGE_SAFETY_BYTES) {
		pruned = aggressivePrune(pruned);
	}

	try {
		await chrome.storage.local.set({ optHistory: pruned });
	} catch (storageErr) {
		console.warn("Storage write failed, clearing all history:", storageErr);
		await chrome.storage.local.set({ optHistory: {} });
	}
}

/**
 * Emergency pruning: keeps only the most recent entry per site
 * and retains only the 10 most recently used hostnames.
 * @param {Object} history
 * @returns {Object} Aggressively pruned history
 */
function aggressivePrune(history) {
	const sorted = Object.entries(history).sort(
		(a, b) => b[1].lastUsed - a[1].lastUsed,
	);
	const kept = sorted.slice(0, 10);
	const result = {};

	for (const [host, data] of kept) {
		result[host] = {
			entries: data.entries.slice(-1), // Keep only the most recent entry
			lastUsed: data.lastUsed,
		};
	}

	return result;
}

// ─── Tab Communication ──────────────────────────────────────────────────────────

/**
 * Sends a message to a tab's content script with defensive error handling.
 * Silently handles cases where the content script is not injected.
 * @param {number} tabId
 * @param {Object} message
 */
function sendMessageToTab(tabId, message) {
	chrome.tabs.sendMessage(tabId, message).catch((err) => {
		if (err.message.includes("Could not establish connection")) {
			console.warn(
				"Content script not ready. Target page may be restricted or require a refresh.",
			);
		} else {
			console.error("Tab communication error:", err);
		}
	});
}
