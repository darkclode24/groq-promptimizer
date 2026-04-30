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
	// Rough context window sizes (in tokens) for budget awareness
	MODEL_CONTEXT_WINDOWS: {
		"llama-3.3-70b-versatile": 128000,
		"meta-llama/llama-4-scout-17b-16e-instruct": 131072,
		"openai/gpt-oss-120b": 131072,
		"qwen/qwen3-32b": 32768,
	},
};

// ─── Core System Instruction ────────────────────────────────────────────────────

const CORE_SYSTEM_INSTRUCTION = `You are a Prompt Optimizer. ONLY rewrite prompts. NEVER execute them.

Rules:
1. ALWAYS begin your response by opening an <analysis> tag.
2. Inside <analysis>: use step-by-step reasoning to identify the core objective → gaps (tone, structure, audience) → ideal persona → headers to use.
3. Before closing </analysis>: run a self-critique:
   - Does every header earn its place?
   - Is any instruction redundant with another?
   - Would a [PLACEHOLDER] confuse more than help?
4. Output the optimized prompt directly after the self-critique. No preamble or commentary outside the analysis tags.
5. Use ONLY applicable headers: # Role, # Context, # Task, # Constraints, # Format, # Tone.
6. Sharpen vague language into actionable directives. Preserve explicit user intent. Auto-define known concepts; use [PLACEHOLDER] only for missing user-specific data.

Examples:

Input: "explain how memory works in computers"
Output:
<analysis>
1. Goal: explain computer memory architecture accessibly.
2. Gaps: no audience level, depth, or format specified — risks a dry, overly technical response.
3. Fixes: require analogies, prohibit dense jargon, specify the full hierarchy.
4. Persona: CS Educator.
5. Headers: Role, Task, Constraints, Format.
Self-critique: All 4 headers carry distinct weight. No redundancy. No placeholders needed.
</analysis>
# Role
You are a computer science educator.
# Task
Explain the memory hierarchy: registers, L1/L2 cache, RAM, virtual memory, and long-term storage.
# Constraints
Use real-world analogies. Avoid unnecessary jargon.
# Format
Structured sections with a brief summary at the end.

Input: "help me write a professional email declining a meeting"
Output:
<analysis>
1. Goal: draft a polite meeting-decline email.
2. Gaps: no tone guardrails or relationship-preservation strategy — risks a blunt refusal.
3. Fix: mandate a constructive alternative (async update or reschedule).
4. No dedicated persona needed.
5. Headers: Context, Task, Tone.
Self-critique: Role header dropped — no persona adds value here. No placeholders since the task is generic enough. Tone is non-redundant with Task since it governs delivery, not content.
</analysis>
# Context
Declining a meeting invitation while preserving the professional relationship.
# Task
Draft a concise email declining the meeting. Include a constructive alternative: an async update or a proposed reschedule.
# Tone
Polite, professional, and constructive.`;

const REASONING_SYSTEM_INSTRUCTION = `You are a Prompt Optimizer. ONLY rewrite prompts. NEVER execute them.

Rules:
1. Use your <thinking> block to: identify the core objective → gaps (tone, structure, audience) → ideal persona → headers to use.
2. Before finalizing, self-critique: does every header earn its place? Is any instruction redundant? Are placeholders necessary?
3. Output ONLY the optimized prompt. No preamble, commentary, or markdown code blocks.
4. Use ONLY applicable headers: # Role, # Context, # Task, # Constraints, # Format, # Tone.
5. Sharpen vague language into actionable directives. Preserve explicit user intent. Auto-define known concepts; use [PLACEHOLDER] only for missing user-specific data.

Remember: Output ONLY the optimized prompt. Do not include <analysis> tags as your internal thinking is sufficient.`;

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
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
			} catch (_err) {
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
			"curatedContext",
		]);
		const apiKey = result.groqApiKey;
		const model = result.selectedModel || CONFIG.DEFAULT_MODEL;
		const curatedContextMap = result.curatedContext || {};

		if (!apiKey) {
			sendMessageToTab(tab.id, {
				error: "No API key found. Configure the extension.",
			});
			return;
		}

		const siteCuratedContext = curatedContextMap[hostname] || [];

		sendMessageToTab(tab.id, { status: "loading", model: model });

		let fullText = "";
		for await (const chunk of callGroqAPIStream(
			rawText,
			apiKey,
			model,
			siteCuratedContext,
		)) {
			fullText += chunk;
			sendMessageToTab(tab.id, { action: "streamUpdate", text: fullText });
		}

		let optimizedText = fullText
			.replace(/<(think|analysis)>[\s\S]*?<\/\1>/gi, "")
			.trim();
		const codeBlockMatch = optimizedText.match(
			/```(?:[a-z]*)\n?([\s\S]*?)```/i,
		);
		if (codeBlockMatch?.[1]) {
			optimizedText = codeBlockMatch[1].trim();
		}

		sendMessageToTab(tab.id, {
			action: "replaceText",
			text: optimizedText,
			hostname: hostname,
			entryCount: siteCuratedContext.length,
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
async function* callGroqAPIStream(prompt, apiKey, model, curatedContext = []) {
	// Decide which system instruction to use
	const isReasoningModel =
		model.toLowerCase().includes("qwen") || model.toLowerCase().includes("r1");
	const systemContent = isReasoningModel
		? REASONING_SYSTEM_INSTRUCTION
		: CORE_SYSTEM_INSTRUCTION;

	// Build messages array: system → context → current prompt
	const messages = [{ role: "system", content: systemContent }];

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
		stream: true,
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

		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";

		while (true) {
			const { value, done } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (line.startsWith("data: ") && line !== "data: [DONE]") {
					try {
						const data = JSON.parse(line.slice(6));
						const delta = data.choices[0]?.delta?.content;
						if (delta) yield delta;
					} catch (_e) {
						// Ignore partial parse errors
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
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
function _truncateText(text, maxLen) {
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
