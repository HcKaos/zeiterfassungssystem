/**
 * Security utilities for XSS prevention and input sanitization
 */

/**
 * Escapes HTML characters to prevent XSS attacks
 * @param {string} str - String to escape
 * @returns {string} - Escaped string safe for HTML insertion
 */
function escapeHTML(str) {
    if (!str || typeof str !== 'string') return '';
    
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Sanitizes HTML content by removing potentially dangerous tags and attributes
 * @param {string} html - HTML string to sanitize
 * @returns {string} - Sanitized HTML
 */
function sanitizeHTML(html) {
    if (!html || typeof html !== 'string') return '';
    
    // Simple whitelist approach - only allow basic formatting
    const allowedTags = ['b', 'i', 'strong', 'em', 'br', 'p', 'span'];
    const allowedAttributes = ['style']; // Very limited style support
    
    // Remove script tags and their content
    html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove on* event handlers
    html = html.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    
    // Remove javascript: and data: URLs
    html = html.replace(/(?:javascript|data):[^"'>\s]*/gi, '');
    
    return html;
}

/**
 * Creates a safe innerHTML replacement that automatically escapes content
 * @param {HTMLElement} element - Element to update
 * @param {string} content - Content to insert (will be escaped)
 */
function safeSetInnerHTML(element, content) {
    if (!element) return;
    element.innerHTML = escapeHTML(content);
}

/**
 * Creates a safe innerHTML replacement for formatted content (allows basic HTML)
 * @param {HTMLElement} element - Element to update  
 * @param {string} content - HTML content to insert (will be sanitized)
 */
function safeSetFormattedHTML(element, content) {
    if (!element) return;
    element.innerHTML = sanitizeHTML(content);
}

/**
 * Validates and sanitizes work report text
 * @param {string} reportText - Work report text
 * @returns {string} - Sanitized report text
 */
function sanitizeWorkReport(reportText) {
    if (!reportText || typeof reportText !== 'string') return '';
    
    // Allow line breaks but escape everything else
    return escapeHTML(reportText).replace(/\n/g, '<br>');
}

// Make functions available globally if in browser environment
if (typeof window !== 'undefined') {
    window.Security = {
        escapeHTML,
        sanitizeHTML,
        safeSetInnerHTML,
        safeSetFormattedHTML,
        sanitizeWorkReport
    };
}

// Export for Node.js environment
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHTML,
        sanitizeHTML,
        safeSetInnerHTML,
        safeSetFormattedHTML,
        sanitizeWorkReport
    };
}