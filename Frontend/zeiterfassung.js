/**
 * Time Tracking Timer Module
 * 
 * This module handles the core time tracking functionality including:
 * - Real-time timer display with client-side countdown
 * - Server synchronization to prevent data loss
 * - Auto cut-off at 23:59 (midnight) with recovery
 * - Work session start/stop/pause/resume functionality
 * - Persistent timer state across browser sessions
 * 
 * Architecture:
 * - Client-side timer for smooth UX (no server requests every second)
 * - Periodic server sync (every 10 seconds) for data integrity
 * - Auto-recovery from network issues and browser refreshes
 * - Midnight auto-cutoff protection with silent handling
 * 
 * @author Dan
 * @version 2.0.0
 */

// ================================
// CONSTANTS AND GLOBAL VARIABLES
// ================================

/** @const {string} localStorage key for persisting work report text */
const LS_BERICHT_TEXT = 'workdayBerichtText';

/** @type {number|null} Interval ID for the visual timer update */
let visualTimerInterval = null;

/** @type {boolean} True if visual timer is actively counting down on the client */
let istVisuellAktiv = false;

/** @type {Date|null} Timestamp when the currently running segment started */
let currentSegmentStartTime = null;

/** @type {number} Previous completed work duration from server (prevents flickering) */
let serverTotalDurationMs = 0;

/** @const {number} Default expected work hours per day */
const DEFAULT_WORKDAY_HOURS = 8;

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Formats milliseconds into HH:MM:SS time display format
 * 
 * Converts millisecond duration into human-readable time string.
 * Ensures non-negative values and proper zero-padding.
 * 
 * @param {number} milliseconds - Duration in milliseconds to format
 * @returns {string} Formatted time string (HH:MM:SS)
 * 
 * @example
 * formatRemainingTime(3661000) // Returns "01:01:01"
 * formatRemainingTime(-1000)   // Returns "00:00:00" (negative clamped)
 */
function formatRemainingTime(milliseconds) {
    // Clamp negative values to zero
    if (milliseconds < 0) milliseconds = 0;
    
    // Convert to seconds and extract time components
    const totalSeconds = Math.floor(milliseconds / 1000);
    const stunden = Math.floor(totalSeconds / 3600);
    const minuten = Math.floor((totalSeconds % 3600) / 60);
    const sekunden = totalSeconds % 60;
    
    // Format with zero-padding
    return `${String(stunden).padStart(2, "0")}:${String(minuten).padStart(2, "0")}:${String(sekunden).padStart(2, "0")}`;
}

// ================================
// CORE TIMER FUNCTIONS
// ================================

/**
 * Main timer display update function
 * 
 * This is the heart of the client-side timer system. It handles:
 * - Periodic server synchronization (every 10 seconds)
 * - Auto-cutoff detection and recovery
 * - Real-time countdown display
 * - Timer state management
 * - UI updates based on current work status
 * 
 * The function balances smooth UX (client-side updates) with data integrity
 * (server synchronization) while handling edge cases like midnight cutoff.
 * 
 * @async
 * @function aktualisiereTimerDisplay
 */
async function aktualisiereTimerDisplay() {
    // Calculate target work duration (8 hours in milliseconds)
    const nominalDurationMs = DEFAULT_WORKDAY_HOURS * 3600 * 1000;
    
    // Get timer display element
    const timeDisplay = document.getElementById("current-time");
    if (!timeDisplay) {
        logger.error("Timer display element not found");
        return;
    }

    // ================================
    // SERVER SYNCHRONIZATION
    // ================================
    // Sync with server every 10 seconds to ensure data integrity
    // This prevents data loss and handles auto-cutoff scenarios
    if (!window.lastServerSync || (Date.now() - window.lastServerSync) > 10000) {
        try {
            logger.timer('Fetching server status for sync...');
            const response = await fetch('/api/zeiterfassung/status', { credentials: 'include' });
            logger.timer('Fetch response status:', response.status);
            const result = await response.json();
            logger.timer('Server result:', result);
            if (!result.success) {
                logger.error("Server status fetch failed:", result.message);
                return;
            }
            
            // Handle auto-cutoff first (no popup - keep logic only)
            if (result.autoCutoffDetected && result.cutoffMessage) {
                // Auto-cutoff detected - reset timer state without showing popup
                console.log('[AUTOCUT] Timer was automatically cut off at 23:59 - resetting UI');
                resetTimerStateAndUI();
                return; // Exit early, timer has been reset
            }
            
            // Store server's completed work for consistent local calculations
            serverTotalDurationMs = result.totalDurationMs || 0;
            let totalWorkedMs = serverTotalDurationMs;
            if (result.activeSegmentStartTime) {
                const segmentStartMs = new Date(result.activeSegmentStartTime).getTime();
                totalWorkedMs += (Date.now() - segmentStartMs);
                currentSegmentStartTime = segmentStartMs;
                istVisuellAktiv = true;
            } else {
                istVisuellAktiv = false;
                currentSegmentStartTime = null;
            }
            const remainingTimeMs = nominalDurationMs - totalWorkedMs;
            timeDisplay.textContent = formatRemainingTime(remainingTimeMs);
            timeDisplay.style.color = remainingTimeMs <= 0 ? "red" : "";
            window.lastServerSync = Date.now();
        } catch (error) {
            logger.error('Error fetching status:', error);
            // Avoid resetting display to prevent flickering
        }
    }
    
    // Only use local state for smooth updates if we're not syncing with server
    else if (istVisuellAktiv && currentSegmentStartTime) {
        // Use local state for smooth updates - include previous completed work!
        const currentSegmentMs = Date.now() - currentSegmentStartTime;
        const totalWorkedMs = serverTotalDurationMs + currentSegmentMs;
        const remainingTimeMs = nominalDurationMs - totalWorkedMs;
        timeDisplay.textContent = formatRemainingTime(remainingTimeMs);
        timeDisplay.style.color = remainingTimeMs <= 0 ? "red" : "";
    }
}

async function startArbeit() {
    if (istVisuellAktiv) {
        logger.warn("startArbeit called while visual tracking appears active.");
        return;
    }

    try {
        logger.api('/api/zeiterfassung/start_segment', 'POST', 'Sending start_segment request...');
        const response = await fetch("/api/zeiterfassung/start_segment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include"
        });
        logger.api('/api/zeiterfassung/start_segment', 'POST', 'Response status:', response.status);
        const data = await response.json();
        logger.api('/api/zeiterfassung/start_segment', 'POST', 'Server data:', data);
        if (!response.ok || !data.success) {
            alert(`Fehler vom Server beim Starten des Segments: ${data.message || 'Unbekannter Fehler'}`);
            return;
        }
        // Set UI to running state immediately
        istVisuellAktiv = true;
        currentSegmentStartTime = Date.now();
        const startButton = document.getElementById("startButton");
        const stopButton = document.getElementById("stopButton");
        const endDayButton = document.getElementById("endDay");
        if (!startButton || !stopButton || !endDayButton) {
            logger.error("Missing DOM elements in startArbeit:", {
                startButton: !!startButton,
                stopButton: !!stopButton,
                endDayButton: !!endDayButton
            });
            return;
        }
        logger.debug('Updating UI to running state');
        startButton.style.display = "none";
        stopButton.style.display = "block";
        endDayButton.disabled = false;
        // Start timer interval
        if (visualTimerInterval) clearInterval(visualTimerInterval);
        visualTimerInterval = setInterval(aktualisiereTimerDisplay, 1000);
        // Save bericht text
        const berichtTextElement = document.getElementById("arbeitsBericht");
        if (berichtTextElement) {
            const berichtText = berichtTextElement.value.trim();
            localStorage.setItem(LS_BERICHT_TEXT, berichtText);
        } else {
            logger.error("arbeitsBericht element not found");
        }
        // Sync with server
        await initZeiterfassung();
    } catch (err) {
        logger.error("API Fehler beim Starten des Segments:", err);
        alert("Netzwerkfehler oder Server nicht erreichbar beim Starten des Segments.");
    }
}

async function pauseArbeit() {
    if (!istVisuellAktiv) return;

    clearInterval(visualTimerInterval);
    istVisuellAktiv = false;

    const bericht = document.getElementById("arbeitsBericht").value.trim();
    localStorage.setItem(LS_BERICHT_TEXT, bericht);

    try {
        const response = await fetch("/api/zeiterfassung/pause_segment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bericht }),
            credentials: "include"
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            alert(`Fehler vom Server beim Pausieren: ${data.message || 'Unbekannter Fehler'}`);
        } else if (data.message && data.message.includes('zu kurz')) {
            alert(data.message);
        }
    } catch (err) {
        logger.error("API Fehler beim Pausieren des Segments:", err);
        alert("Netzwerkfehler oder Server nicht erreichbar beim Pausieren.");
    }
    
    await initZeiterfassung();
}

async function beendeArbeitstag() {
    const wasVisuallyActive = istVisuellAktiv;
    if (wasVisuallyActive) {
        clearInterval(visualTimerInterval);
        istVisuellAktiv = false;
    }

    const bericht = document.getElementById("arbeitsBericht").value.trim();
    
    try {
        const response = await fetch("/api/zeiterfassung/end_workday", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bericht }),
            credentials: "include"
        });
        const data = await response.json();
        
        alert(data.message || (data.success ? "Arbeitstag erfolgreich beendet." : "Fehler beim Beenden des Arbeitstages."));
        
        logger.debug('Syncing frontend state with server after end_workday...');
        await initZeiterfassung();
        logger.debug('Frontend sync completed');
        
        if (data.success && typeof ladeBerichte === "function") {
            ladeBerichte();
        }
    } catch (err) {
        logger.error("Fehler beim Beenden des Arbeitstages:", err);
        alert("Netzwerkfehler: " + err.message);
        try {
            await initZeiterfassung();
        } catch (syncErr) {
            logger.error("Fehler beim Synchronisieren mit Server:", syncErr);
            if (wasVisuallyActive) {
                istVisuellAktiv = true;
                if (visualTimerInterval) clearInterval(visualTimerInterval);
                visualTimerInterval = setInterval(aktualisiereTimerDisplay, 1000);
                document.getElementById("stopButton").style.display = "block";
            }
        }
    }
}

function resetTimerStateAndUI() {
    clearInterval(visualTimerInterval);
    visualTimerInterval = null;
    istVisuellAktiv = false;
    currentSegmentStartTime = null;
    serverTotalDurationMs = 0; // Reset stored server duration
    
    localStorage.removeItem(LS_BERICHT_TEXT);

    const nominalDuration = (DEFAULT_WORKDAY_HOURS * 3600 * 1000);
    const timeDisplay = document.getElementById("current-time");
    const berichtTextarea = document.getElementById("arbeitsBericht");
    const startButton = document.getElementById("startButton");
    const stopButton = document.getElementById("stopButton");
    const endDayButton = document.getElementById("endDay");

    if (!timeDisplay || !berichtTextarea || !startButton || !stopButton || !endDayButton) {
        logger.error("Missing DOM elements:", {
            timeDisplay: !!timeDisplay,
            berichtTextarea: !!berichtTextarea,
            startButton: !!startButton,
            stopButton: !!stopButton,
            endDayButton: !!endDayButton
        });
        return;
    }

    timeDisplay.textContent = formatRemainingTime(nominalDuration);
    timeDisplay.style.color = "";
    berichtTextarea.value = "";
    startButton.style.display = "block";
    startButton.innerHTML = "<i class=\"bi bi-play-circle\"></i> Arbeit beginnen";
    startButton.disabled = false;
    stopButton.style.display = "none";
    endDayButton.disabled = true;
}

async function initZeiterfassung() {
    try {
        const dateElement = document.getElementById("current-date");
        const startButton = document.getElementById("startButton");
        const stopButton = document.getElementById("stopButton");
        const endDayButton = document.getElementById("endDay");

        if (!startButton || !stopButton || !endDayButton) {
            logger.error("Missing DOM elements for initialization:", {
                startButton: !!startButton,
                stopButton: !!stopButton,
                endDayButton: !!endDayButton
            });
            return;
        }

        if (dateElement) {
            const heute = new Date();
            dateElement.textContent = heute.toLocaleDateString("de-DE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
        }

        startButton.addEventListener("click", startArbeit);
        stopButton.addEventListener("click", pauseArbeit);
        endDayButton.addEventListener("click", beendeArbeitstag);

        logger.debug('Initializing - fetching status...');
        const response = await fetch('/api/zeiterfassung/status');
        logger.debug('Init fetch response status:', response.status);
        const result = await response.json();
        logger.debug('Init server result:', result);
        if (!result.success) {
            throw new Error(result.message || "Konnte den Zeitstatus nicht vom Server laden.");
        }

        const { totalDurationMs, activeSegmentStartTime, autoCutoffDetected, cutoffMessage } = result;

        if (autoCutoffDetected && cutoffMessage) {
            // Auto-cutoff detected during initialization - reset without popup
            console.log('[AUTOCUT] Auto-cutoff detected during initialization - resetting UI');
            resetTimerStateAndUI();
            // Reload berichte to show the auto-cutoff entry
            if (typeof ladeBerichte === "function") {
                ladeBerichte();
            }
        } else if (activeSegmentStartTime) {
            logger.state('RUNNING', 'Setting UI to RUNNING state');
            istVisuellAktiv = true;
            currentSegmentStartTime = new Date(activeSegmentStartTime).getTime();
            startButton.style.display = "none";
            stopButton.style.display = "block";
            endDayButton.disabled = false;
            if (visualTimerInterval) clearInterval(visualTimerInterval);
            visualTimerInterval = setInterval(aktualisiereTimerDisplay, 1000);
        } else if (totalDurationMs > 0) {
            logger.state('PAUSED', 'Setting UI to PAUSED state (resume available)');
            istVisuellAktiv = false;
            currentSegmentStartTime = null;
            startButton.style.display = "block";
            startButton.innerHTML = "<i class=\"bi bi-play-circle\"></i> Arbeit fortsetzen";
            stopButton.style.display = "none";
            endDayButton.disabled = false;
        } else {
            logger.state('NEW_DAY', 'Setting UI to NEW DAY state');
            resetTimerStateAndUI();
        }

        await aktualisiereTimerDisplay();
    } catch (err) {
        logger.error("Fehler bei der Initialisierung der Zeiterfassung:", err);
        alert("Zeiterfassung konnte nicht initialisiert werden!");
        resetTimerStateAndUI();
    }
}

// HTML escaping function for XSS protection
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    const div = document.createElement('div');
    div.textContent = str.toString();
    return div.innerHTML;
}

async function ladeBerichte() {
    try {
        const response = await fetch('/api/berichte');
        const berichte = await response.json();
        
        // Convert to the format expected by zeigeBerichte (which expects reportEntries)
        const reportEntries = Array.isArray(berichte) ? berichte.map(bericht => ({
            datum: bericht.datum,
            startzeit: bericht.startzeit,
            endzeit: bericht.endzeit,  
            dauer: bericht.dauer,
            beschreibung: bericht.bericht,
            type: 'Arbeit',
            id: bericht.id
        })) : [];
        
        if (typeof zeigeBerichte === 'function') {
            zeigeBerichte(reportEntries);
        }
    } catch (error) {
        logger.error('Fehler beim Laden der Berichte:', error);
    }
}

function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
    var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
    var weekNo = Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
    return [d.getUTCFullYear(), weekNo];
}

function druckeBerichte() {
    const monthInput = document.getElementById('monatAuswahlBerichtePraktikant');
    const selectedMonth = monthInput ? monthInput.value : new Date().toISOString().slice(0, 7);

    if (!selectedMonth) {
        alert("Bitte wählen Sie einen Monat aus.");
        return;
    }

    fetch(`/api/berichte/monat/${selectedMonth}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Netzwerkantwort war nicht ok.');
            }
            return response.json();
        })
        .then(data => {
            if (data.reportEntries && data.reportEntries.length > 0) {
                const printWindow = window.open('', '_blank');
                const reportTitle = `Tätigkeitsbericht ${new Date(selectedMonth + '-02').toLocaleString('de-DE', { month: 'long', year: 'numeric' })}`;
                printWindow.document.write(`<html><head><title>${reportTitle}</title>`);
                printWindow.document.write('<link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">');
                printWindow.document.write(`
                    <style>
                        body { font-family: Arial, sans-serif; margin: 20px; }
                        .header, .footer { text-align: center; margin-bottom: 20px; }
                        .signature-section { margin-top: 80px; display: flex; justify-content: space-between; }
                        .signature-box { width: 45%; }
                        .signature-area {
                            border-bottom: 1px solid #000;
                            height: 120px; /* Taller for bigger signature */
                            position: relative;
                        }
                        .signature-date {
                            position: absolute;
                            bottom: 5px;
                            left: 0;
                        }
                        .signature-image {
                            position: absolute;
                            bottom: 5px;
                            left: 50%;
                            transform: translateX(-50%);
                            height: 120px; /* 100% larger than original 60px */
                        }
                        .signature-text { text-align: center; margin-top: 5px; }
                        .week-table { margin-bottom: 30px; }
                        h4 { margin-top: 20px; }
                    </style>
                `);
                printWindow.document.write('</head><body>');
                printWindow.document.write(`<div class="header"><h3>Tätigkeitsbericht für ${new Date(selectedMonth + '-02').toLocaleString('de-DE', { month: 'long', year: 'numeric' })}</h3></div>`);
                printWindow.document.write(`<p><strong>Praktikant:</strong> ${escapeHTML(data.vorname)} ${escapeHTML(data.nachname)}</p>`);
                
                const entriesByWeek = {};
                const absenceEntries = [];
                data.reportEntries.forEach(entry => {
                    if (entry.type === 'Arbeit') {
                        const [day, month, year] = entry.datum.split('.');
                        const date = new Date(`${year}-${month}-${day}`);
                        const weekArray = getWeekNumber(date);
                        const weekKey = `${weekArray[0]}-W${String(weekArray[1]).padStart(2, '0')}`;

                        if (!entriesByWeek[weekKey]) {
                            entriesByWeek[weekKey] = [];
                        }
                        entriesByWeek[weekKey].push(entry);
                    } else if (entry.type === 'Urlaub' || entry.type === 'Krankheit') {
                        absenceEntries.push(entry);
                    }
                });

                const sortedWeeks = Object.keys(entriesByWeek).sort();

                if (sortedWeeks.length > 0) {
                    sortedWeeks.forEach(week => {
                        printWindow.document.write(`<h4>Kalenderwoche: ${week.split('-W')[1]}</h4>`);
                        let table = '<table class="table table-bordered table-sm week-table"><thead><tr><th>Datum</th><th>Start</th><th>Ende</th><th>Dauer</th><th>Tätigkeitsbericht</th></tr></thead><tbody>';
                        entriesByWeek[week].forEach(entry => {
                            table += `<tr>
                                <td>${escapeHTML(entry.datum)}</td>
                                <td>${escapeHTML(entry.startzeit)}</td>
                                <td>${escapeHTML(entry.endzeit)}</td>
                                <td>${escapeHTML(entry.dauer)}</td>
                                <td>${escapeHTML(entry.beschreibung || '')}</td>
                            </tr>`;
                        });
                        table += '</tbody></table>';
                        printWindow.document.write(table);
                    });
                } else {
                    printWindow.document.write('<p>Keine Arbeitseinträge für diesen Monat gefunden.</p>');
                }

                if (absenceEntries.length > 0) {
                    printWindow.document.write(`<h4>Abwesenheiten</h4>`);
                    let absenceTable = '<table class="table table-bordered table-sm week-table"><thead><tr><th>Datum</th><th>Typ</th><th>Beschreibung</th></tr></thead><tbody>';
                    absenceEntries.forEach(entry => {
                        absenceTable += `<tr>
                            <td>${escapeHTML(entry.datum)}</td>
                            <td>${escapeHTML(entry.type)}</td>
                            <td>${escapeHTML(entry.beschreibung || '')}</td>
                        </tr>`;
                    });
                    absenceTable += '</tbody></table>';
                    printWindow.document.write(absenceTable);
                }

                if(data.calculatedTotalMonthlyHours) {
                    const totalHours = data.calculatedTotalMonthlyHours;
                    const hours = Math.floor(totalHours);
                    const minutes = Math.round((totalHours - hours) * 60);
                    const formattedTotalTime = `${hours} Std. ${String(minutes).padStart(2, '0')} Min.`;
                    printWindow.document.write(`<h5>Gesamte Arbeitszeit in diesem Monat: ${formattedTotalTime}</h5>`);
                }

                const today = new Date().toLocaleDateString('de-DE');
                printWindow.document.write(`<div class="signature-section">
                    <div class="signature-box">
                        <div class="signature-area">
                            <span class="signature-date">${today}</span>
                        </div>
                        <p class="signature-text">Datum, Unterschrift Praktikant/in</p>
                    </div>
                    <div class="signature-box">
                        <div class="signature-area">
                            <img src="images/admin-signature-placeholder.svg" class="signature-image">
                        </div>
                        <p class="signature-text">${today}, Unterschrift Betreuer/in</p>
                    </div>
                </div>`);

                printWindow.document.write('</body></html>');
                printWindow.document.close();
                setTimeout(() => {
                    printWindow.print();
                }, 500);
            } else {
                alert('Keine Daten für den ausgewählten Monat gefunden.');
            }
        })
        .catch(error => {
            logger.error('Fehler beim Drucken der Berichte:', error);
            alert('Fehler beim Abrufen der Berichtsdaten für den Druck.');
        });
}

document.addEventListener("DOMContentLoaded", () => {
    initZeiterfassung(); 
    
    // Other initializations...
    
    // Load Berichte if table exists (initial check)
    if (document.getElementById('berichteTabelle')) {
        ladeBerichte();
    }
    
    // Add event to reload Berichte when berichte link is clicked
    const berichteTabLink = document.getElementById('berichteLink');
    if (berichteTabLink) {
        berichteTabLink.addEventListener('click', () => {
            // Use a small delay to ensure the section is shown first
            setTimeout(() => {
                logger.debug('Berichte section shown - loading reports');
                if (typeof ladeMonatsBerichte === 'function') {
                    ladeMonatsBerichte();
                } else {
                    ladeBerichte();
                }
            }, 100);
        });
    } else {
        logger.debug('Berichte tab link not found - may not be needed on this page');
    }
    
    const druckButton = document.getElementById('druckButton');
    if (druckButton) {
        druckButton.addEventListener('click', druckeBerichte);
    }
});
//grok