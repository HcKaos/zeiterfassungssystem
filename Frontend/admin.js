/**
 * Admin Dashboard JavaScript Module
 * 
 * This module provides administrative functionality for managing interns (Praktikanten)
 * in the time tracking system. It handles CRUD operations for user management.
 * 
 * Features:
 * - Load and display list of all interns
 * - Show detailed intern information
 * - Delete intern records with confirmation
 * - XSS protection for displayed data
 * 
 * Security:
 * - All API calls include credentials for session-based authentication
 * - HTML escaping prevents XSS attacks
 * - User confirmation required for destructive operations
 * 
 * @author Dan
 * @version 1.0.0
 */

/**
 * Loads all interns from the server and displays them in the table
 * 
 * Makes an authenticated API call to fetch all intern data including
 * their vacation day balances and status information.
 * 
 * @async
 * @function ladePraktikanten
 * @returns {Promise<Array|null>} Array of intern objects or null on error
 */
async function ladePraktikanten() {
    try {
        // Fetch intern data from server with authentication
        const response = await fetch("/api/praktikanten", {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include"  // Include session cookies for authentication
        });

        // Check if request was successful
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Response nicht ok`);
        }

        // Parse JSON response and display data
        const praktikanten = await response.json();
        zeigePraktikanten(praktikanten);
        return praktikanten;

    } catch (err) {
        // Log error for debugging and show user-friendly message
        logger.error("Fehler beim Laden der Praktikanten:", err);
        alert("Praktikanten konnten nicht geladen werden!");
        return null;
    }
}

/**
 * Escapes HTML characters to prevent XSS attacks
 * 
 * Uses the browser's built-in HTML escaping by setting textContent
 * and reading back innerHTML. This ensures all special characters
 * are properly escaped.
 * 
 * @param {string|null|undefined} str - String to escape
 * @returns {string} HTML-escaped string safe for insertion
 */
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = str.toString();
    return div.innerHTML;
}

/**
 * Displays interns in the HTML table
 * 
 * Populates the praktikantenListe table with intern data including
 * ID, email, role, status, and remaining vacation days. Each row
 * includes action buttons for viewing details, editing, and deletion.
 * 
 * Security: All user data is HTML-escaped to prevent XSS
 * 
 * @param {Array} praktikanten - Array of intern objects from API
 */
function zeigePraktikanten(praktikanten) {
    const tabelle = document.getElementById("praktikantenListe");
    
    // Clear existing table content
    tabelle.innerHTML = ""; 

    // Create table row for each intern
    praktikanten.forEach(praktikant => {
        const zeile = document.createElement("tr");
        
        // Calculate remaining vacation days (rounded for display)
        const remainingUrlaubstage = praktikant.remainingUrlaubstage !== null && 
                                     praktikant.remainingUrlaubstage !== undefined ? 
                                     Math.round(praktikant.remainingUrlaubstage) : 'N/A';
        
        // Build table row with escaped data and action buttons
        // Note: innerHTML is safe here because all data is escaped
        zeile.innerHTML = `
            <td>${escapeHTML(praktikant.id)}</td>
            <td>${escapeHTML(praktikant.email)}</td>
            <td>${escapeHTML(praktikant.rolle)}</td>
            <td>${escapeHTML(praktikant.status)}</td>
            <td>${escapeHTML(remainingUrlaubstage)}</td>
            <td>
                <button class="btn btn-sm btn-info" onclick="zeigeDetails(${parseInt(praktikant.id)})">
                    <i class="bi bi-eye"></i> Details
                </button>
                <button class="btn btn-sm btn-warning" onclick="bearbeiten(${parseInt(praktikant.id)})">
                    <i class="bi bi-pencil"></i> Bearbeiten
                </button>
                <button class="btn btn-sm btn-danger" onclick="löschen(${parseInt(praktikant.id)})">
                    <i class="bi bi-trash"></i> Löschen
                </button>
            </td>`;
        
        tabelle.appendChild(zeile);
    });
}

/**
 * Shows detailed information for a specific intern
 * 
 * Fetches and displays comprehensive intern details including
 * ID, username, role, and assigned supervisor information.
 * 
 * @async
 * @param {number} id - Intern ID to fetch details for
 */
async function zeigeDetails(id) {
    try {
        // Fetch detailed intern data
        const response = await fetch(`/api/praktikanten/${id}`, {
            method: "GET",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include"  // Include authentication
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Response nicht ok`);
        }

        // Parse and display intern details
        const praktikant = await response.json();
        alert(`
            Praktikant Details:
            ID: ${praktikant.id}
            Name: ${praktikant.benutzername}
            Rolle: ${praktikant.rolle}
            Betreuer: ${praktikant.betreuerId || 'Nicht zugewiesen'}
        `);

    } catch (err) {
        logger.error("Fehler beim Laden der Detail:", err);
        alert("Details konnten nicht geladen werden!");
    }
}

/**
 * Deletes an intern after user confirmation
 * 
 * Shows confirmation dialog before permanently removing intern
 * from the system. Refreshes the intern list after successful deletion.
 * 
 * Security: Requires explicit user confirmation for destructive action
 * 
 * @async
 * @param {number} id - ID of intern to delete
 */
async function löschen(id) {
    // Require user confirmation for destructive action
    if (!confirm("Möchten Sie diesen Praktikanten wirklich löschen?")) {
        return;
    }

    try {
        // Send DELETE request to server
        const response = await fetch(`/api/praktikanten/${id}`, {
            method: "DELETE",
            headers: {
                "Content-Type": "application/json"
            },
            credentials: "include"  // Include authentication
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: Fehler beim Löschen`);
        }
        
        // Show success message and refresh list
        alert("Praktikant erfolgreich gelöscht");
        ladePraktikanten(); 
        
    } catch (fehler) {
        logger.error("Fehler beim Löschen:", fehler);
        alert("Praktikant konnte nicht gelöscht werden!");
    }
}

/**
 * Initialize the admin interface when DOM is loaded
 * 
 * Automatically loads and displays the intern list when the page
 * is ready for interaction.
 */
document.addEventListener("DOMContentLoaded", () => {
    ladePraktikanten();
});