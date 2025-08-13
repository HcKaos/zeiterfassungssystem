/**
 * Environment-aware logging utility for Zeiterfassungssystem
 * Only shows debug logs in development environment
 */

class Logger {
    constructor() {
        // Detect development environment
        this.isDevelopment = this.detectDevelopmentMode();
    }

    /**
     * Detect if we're running in development mode
     * @returns {boolean} true if development, false if production
     */
    detectDevelopmentMode() {
        // Check for localhost or common development hosts
        const hostname = window.location.hostname;
        const isDev = hostname === 'localhost' || 
                     hostname === '127.0.0.1' || 
                     hostname.startsWith('192.168.') ||
                     hostname.endsWith('.local') ||
                     window.location.port !== '';
        
        return isDev;
    }

    /**
     * Debug logging - only shown in development
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    debug(message, ...args) {
        if (this.isDevelopment) {
            console.log(`[DEBUG] ${message}`, ...args);
        }
    }

    /**
     * Info logging - only shown in development  
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    info(message, ...args) {
        if (this.isDevelopment) {
            console.info(`[INFO] ${message}`, ...args);
        }
    }

    /**
     * Warning logging - always shown
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    warn(message, ...args) {
        console.warn(`[WARN] ${message}`, ...args);
    }

    /**
     * Error logging - always shown
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    error(message, ...args) {
        console.error(`[ERROR] ${message}`, ...args);
    }

    /**
     * Timer/sync logging - only in development
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    timer(message, ...args) {
        if (this.isDevelopment) {
            console.log(`⏱️ ${message}`, ...args);
        }
    }

    /**
     * State change logging - only in development
     * @param {string} state - State name
     * @param {string} message - Log message
     * @param {...any} args - Additional arguments
     */
    state(state, message, ...args) {
        if (this.isDevelopment) {
            const stateEmoji = this.getStateEmoji(state);
            console.log(`${stateEmoji} ${message}`, ...args);
        }
    }

    /**
     * API request logging - only in development
     * @param {string} endpoint - API endpoint
     * @param {string} method - HTTP method
     * @param {...any} args - Additional arguments
     */
    api(endpoint, method = 'GET', ...args) {
        if (this.isDevelopment) {
            console.log(`🌐 API ${method} ${endpoint}`, ...args);
        }
    }

    /**
     * Get emoji for UI state
     * @param {string} state - State name
     * @returns {string} Emoji representing the state
     */
    getStateEmoji(state) {
        const stateEmojis = {
            'NEW_DAY': '🔵',
            'RUNNING': '🟢', 
            'PAUSED': '🟡',
            'COMPLETED': '✅',
            'ERROR': '❌',
            'WARNING': '⚠️'
        };
        return stateEmojis[state] || '🔶';
    }

    /**
     * Environment info - shown once on load
     */
    showEnvironmentInfo() {
        const mode = this.isDevelopment ? '🔧 DEVELOPMENT' : '🚀 PRODUCTION';
        console.log(`Zeiterfassungssystem - ${mode} Mode`);
        
        if (this.isDevelopment) {
            console.log('Debug logging enabled. To disable, deploy to production environment.');
        }
    }
}

// Create global logger instance
window.logger = new Logger();

// Show environment info on load
logger.showEnvironmentInfo();