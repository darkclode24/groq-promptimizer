/**
 * Groq Prompt Optimizer — Response Extractors
 * v1.0.0
 *
 * Captures the latest AI response from downstream LLM chat interfaces.
 * Uses a tiered strategy: known selectors → semantic fallbacks → generic heuristics.
 *
 * This file is injected as a content script before content.js.
 */

// ─── Tier 1: Known Site-Specific Selectors ──────────────────────────────────────
// These are fragile and WILL need periodic updates as sites change their DOM.

const SITE_EXTRACTORS = {
	// ChatGPT
	"chatgpt.com": [
		'[data-message-author-role="assistant"]',
		".agent-turn .markdown",
		".message-content",
	],
	"chat.openai.com": [
		'[data-message-author-role="assistant"]',
		".agent-turn .markdown",
		".message-content",
	],

	// Google Gemini
	"gemini.google.com": [
		"message-content.model-response-text",
		".response-container .markdown",
		"model-response message-content",
	],

	// Anthropic Claude
	"claude.ai": [
		'[data-is-streaming="false"] .font-claude-message',
		".font-claude-message",
		".prose",
	],

	// LMSYS Chatbot Arena
	"lmarena.ai": [
		".chatbot .message.bot",
		".bot-message",
		'[data-testid="bot"]',
	],
	"chat.lmsys.org": [
		".chatbot .message.bot",
		".bot-message",
		'[data-testid="bot"]',
	],
};

// ─── Tier 2: Semantic / ARIA-based Fallbacks ────────────────────────────────────
// More resilient across redesigns — targets accessible attributes.

const SEMANTIC_SELECTORS = [
	'[data-role="assistant"]',
	'[data-message-author-role="assistant"]',
	'[role="log"] [aria-label*="assistant" i]',
	'[aria-label*="response" i]',
	'[data-author="bot"]',
];

// ─── Tier 3: Generic Heuristic Selectors ────────────────────────────────────────
// Broad class-name patterns common across AI chat interfaces.

const GENERIC_SELECTORS = [
	'[class*="assistant-message" i]',
	'[class*="bot-message" i]',
	'[class*="ai-message" i]',
	'[class*="model-response" i]',
	'[class*="response-content" i]',
	'[class*="chat-response" i]',
];

// ─── Extraction Logic ───────────────────────────────────────────────────────────

/**
 * Attempts to extract the last AI response text from the current page.
 * Tries known selectors for the hostname first, then falls back through tiers.
 *
 * @param {string} hostname - The current page's hostname
 * @returns {string|null} The extracted response text, or null if not found
 */
function _extractLastResponse(hostname) {
	// Tier 1: Known site-specific selectors
	const siteSelectors = SITE_EXTRACTORS[hostname];
	if (siteSelectors) {
		const result = trySelectors(siteSelectors);
		if (result) return result;
	}

	// Tier 2: Semantic / ARIA fallbacks
	const semanticResult = trySelectors(SEMANTIC_SELECTORS);
	if (semanticResult) return semanticResult;

	// Tier 3: Generic heuristics
	const genericResult = trySelectors(GENERIC_SELECTORS);
	if (genericResult) return genericResult;

	return null;
}

/**
 * Iterates over an array of CSS selectors. For each selector, finds all matches
 * and returns the innerText of the LAST match (most recent response).
 *
 * @param {string[]} selectors - Array of CSS selectors to try
 * @returns {string|null} Extracted text or null
 */
function trySelectors(selectors) {
	for (const selector of selectors) {
		try {
			const elements = document.querySelectorAll(selector);
			if (elements.length > 0) {
				const lastElement = elements[elements.length - 1];
				const text = lastElement.innerText?.trim();
				// Only return if we got meaningful text (more than a few characters)
				if (text && text.length > 20) {
					return text;
				}
			}
		} catch (_e) {}
	}
	return null;
}
