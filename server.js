/**
 * Zeiterfassungssystem - Time Tracking System Server
 * 
 * A comprehensive Node.js/Express server for managing intern time tracking,
 * work reports, absences, and administrative functions.
 * 
 * Features:
 * - Session-based authentication with bcrypt password hashing
 * - Role-based access control (Admin/Intern)
 * - Time tracking with automatic midnight cutoff
 * - Work report management with segment support
 * - Absence request system
 * - Comprehensive admin dashboard
 * - Security headers and input validation
 * - MySQL database with connection pooling
 * 
 * Architecture:
 * - RESTful API design
 * - Middleware-based authentication
 * - Prepared statements for SQL injection prevention
 * - Session persistence across server restarts
 * - Auto-recovery from network/browser issues
 * 
 * @author Dan
 * @version 2.0.0
 * @since 2025
 */

// ================================
// DEPENDENCIES AND SETUP
// ================================

const express = require("express");
const cors = require("cors");
const session = require("express-session");
const path = require("path");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
require("dotenv").config();

const app = express();

// Security Headers Middleware
app.use((req, res, next) => {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // XSS Protection (legacy browsers)
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Content Security Policy
    const isProduction = process.env.NODE_ENV === 'production';
    const cspPolicy = isProduction 
        ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self';"
        : "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self';";
    
    res.setHeader('Content-Security-Policy', cspPolicy);
    
    // Hide server information
    res.removeHeader('X-Powered-By');
    
    next();
});

// CORS Configuration
const allowedOrigins = process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_ORIGIN // Your production frontend URL
    : `http://localhost:${process.env.PORT || 3000}`; // Development URL

const corsOptions = {
    origin: allowedOrigins,
    credentials: true, // Allow cookies to be sent
    optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to false for dev (no HTTPS on localhost)
        httpOnly: true,
        sameSite: 'lax', // 'lax' works with credentials: include
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Request logging (only in development)
if (process.env.NODE_ENV !== 'production') {
    // Request logging (only in development)
    if (process.env.NODE_ENV !== 'production') {
        app.use((req, res, next) => {
            console.log(`${req.method} ${req.url}`);
            next();
        });
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'Zeiterfassung'
    // No timezone config - let MySQL handle datetime values as-is without conversion
});

// Midnight cutoff helper functions for 23:59 timer auto-end system
function getMidnightCutoffTime(date) {
    // Return datetime string in MySQL format to avoid timezone conversion issues
    // This ensures MySQL gets exactly 23:59:00 local time, not UTC-converted time
    const inputDate = new Date(date);
    const year = inputDate.getFullYear();
    const month = String(inputDate.getMonth() + 1).padStart(2, '0');
    const day = String(inputDate.getDate()).padStart(2, '0');
    
    const cutoffString = `${year}-${month}-${day} 23:59:00`;
    
    console.log(`[CUTOFF] Creating cutoff time string: ${cutoffString} (avoids timezone conversion)`);
    
    return cutoffString;
}

function isTimerFromPreviousDay(startTime) {
    // Use local date comparison instead of UTC to fix timezone issues
    // This ensures auto-cutoff triggers at midnight local time, not midnight UTC
    const timerDate = new Date(startTime).toLocaleDateString('en-CA'); // YYYY-MM-DD local format
    const todayDate = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local format
    console.log(`[DATE CHECK] Timer date (local): ${timerDate}, Today date (local): ${todayDate}`);
    return timerDate !== todayDate;
}

function isAutoCutoffEntry(entry) {
    // Check if entry was auto-cutoff by examining end time (23:59:00) and bericht content
    if (!entry.endZeit || !entry.bericht) return false;
    
    const endTime = new Date(entry.endZeit);
    const is2359 = endTime.getHours() === 23 && endTime.getMinutes() === 59 && endTime.getSeconds() === 0;
    const hasAutoCutoffMessage = entry.bericht.includes("Timer wurde automatisch um 23:59") || entry.bericht.includes("Auto cut-off Notification") || entry.bericht.includes("automatisch um 23:59 beendet");
    
    return is2359 && hasAutoCutoffMessage;
}

async function handleStaleTimer(connection, timerId, benutzerId, startTime, originalBericht) {
    const startDate = new Date(startTime);
    const cutoffTime = getMidnightCutoffTime(startDate);
    
    console.log(`[STALE TIMER] Auto-ending stale timer from previous day: ${startDate.toLocaleDateString('de-DE')}`);
    console.log(`[STALE TIMER] Original start: ${startDate.toString()}`);
    console.log(`[STALE TIMER] Original bericht: "${originalBericht}"`);
    console.log(`[STALE TIMER] Cutoff time string: ${cutoffTime}`);
    
    // Strategy: Instead of overwriting the original entry, create a separate auto-cutoff entry
    // This preserves the user's actual work data while still handling the midnight cutoff
    
    // Step 1: Close the original entry with the cutoff time, preserving original bericht
    await connection.execute(
        "UPDATE Arbeitszeiten SET endZeit = ? WHERE id = ?",
        [cutoffTime, timerId]
    );
    
    console.log(`[STALE TIMER] Original entry closed at cutoff time, preserving bericht: "${originalBericht}"`);
    
    // Step 2: Create a new entry to represent the auto-cutoff notification
    // This entry serves as a log that auto-cutoff occurred, without corrupting work data
    await connection.execute(
        "INSERT INTO Arbeitszeiten (benutzerId, startZeit, endZeit, bericht) VALUES (?, ?, ?, ?)",
        [
            benutzerId,
            cutoffTime,
            cutoffTime, // Same start and end time - represents a "notification" entry
            "Auto cut-off Notification: Timer wurde automatisch um 23:59 des vorherigen Tages beendet. Original-Arbeitszeit wurde bis zur Abschaltzeit verlängert."
        ]
    );
    
    console.log(`[STALE TIMER] Auto-cutoff notification entry created`);
    
    return {
        cutoffTime,
        originalStart: startDate,
        originalBericht: originalBericht,
        message: `Timer automatisch um 23:59 am ${startDate.toLocaleDateString('de-DE')} beendet, Original-Daten erhalten`
    };
}

app.get("/", (req, res) => {
    res.redirect("/login.html");
});

app.get("/login.html", (req, res) => {
    res.sendFile(path.join(__dirname, "Frontend", "login.html"));
});

//app.use(express.static("Frontend"));
app.use(express.static("Frontend", { maxAge: 0 }));

app.use('/api/', (req, res, next) => {
    console.log(`API Request: ${req.method} ${req.originalUrl}`);
    next();
});

// API Routes - Authentication
app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, passwort } = req.body;
        const [users] = await pool.execute("SELECT * FROM Praktikanten WHERE email = ?", [email]);
        if (users.length > 0) {
            const isValid = await bcrypt.compare(passwort, users[0].password);
            if (isValid) {
                req.session.user = { id: users[0].id, email: users[0].email, vorname: users[0].vorname, nachname: users[0].nachname, rolle: users[0].rolle };
                
                // Clean up old autocut session flags on login
                Object.keys(req.session).forEach(key => {
                    if (key.startsWith('autocut_handled_')) {
                        delete req.session[key];
                    }
                });
                
                return res.json({ success: true, user: req.session.user, rolle: users[0].rolle });
            }
        }
        res.status(401).json({ success: false, message: "Ungültige Anmeldedaten" });
    } catch (error) {
        console.error("Login-Fehler:", error);
        res.status(500).json({ success: false, message: "Interner Fehler" });
    }
});

app.post("/api/auth/register", async (req, res) => {
    try {
        const { vorname, nachname, email, passwort, adresse, telefonnummer, bildungstraeger } = req.body;
        if (!email || !passwort || !vorname || !nachname) {
            return res.status(400).json({ success: false, message: "Vorname, Nachname, Email und Passwort sind erforderlich." });
        }
        const [existingUsersByEmail] = await pool.execute("SELECT id FROM Praktikanten WHERE email = ?", [email]);
        if (existingUsersByEmail.length > 0) {
            return res.status(409).json({ success: false, message: "Email existiert bereits." });
        }
        const hashedPassword = await bcrypt.hash(passwort, 10);
        const [result] = await pool.execute(
            `INSERT INTO Praktikanten (vorname, nachname, email, password, rolle, status, adresse, telefonnummer, bildungstraeger) VALUES (?, ?, ?, ?, 'Praktikant', 'aktiv', ?, ?, ?)`,
            [vorname, nachname, email, hashedPassword, adresse || null, telefonnummer || null, bildungstraeger || null]
        );
        res.status(201).json({ success: true, message: `Registrierung erfolgreich.`, userId: result.insertId });
    } catch (error) {
        console.error("Registrierungsfehler:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler bei der Registrierung." });
    }
});

app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ success: false, message: "Logout fehlgeschlagen" });
        res.json({ success: true, message: "Erfolgreich ausgeloggt" });
    });
});

// User Profile
app.get("/api/users/me/profile", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const [rows] = await pool.execute("SELECT id, email, rolle, status, vorname, nachname, adresse, telefonnummer, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen, total_urlaubstage_annually FROM Praktikanten WHERE id = ?", [req.session.user.id]);
        if (rows.length > 0) {
            const profile = rows[0];
            
            // Calculate vacation days for current year
            const currentYear = new Date().getFullYear();
            const yearStartDate = `${currentYear}-01-01`;
            const yearEndDate = `${currentYear}-12-31`;
            
            const vacationHoursUsed = await getVacationHoursForPeriodHelper(req.session.user.id, yearStartDate, yearEndDate, pool);
            const usedUrlaubstageThisYear = vacationHoursUsed / HOURS_PER_URLAUBSTAG_GLOBAL;
            const totalUrlaubstage = profile.total_urlaubstage_annually || 0;
            
            profile.usedUrlaubstageThisYear = usedUrlaubstageThisYear;
            profile.remainingUrlaubstage = Math.max(0, totalUrlaubstage - usedUrlaubstageThisYear);
            
            res.json({ success: true, profile: profile });
        } else {
            res.status(404).json({ success: false, message: "Profil nicht gefunden" });
        }
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});

app.put("/api/users/me/profile", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const { vorname, nachname, adresse, telefonnummer, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen } = req.body;
        if (!vorname || !nachname) return res.status(400).json({ success: false, message: "Vorname und Nachname sind erforderlich." });
        await pool.execute(`UPDATE Praktikanten SET vorname = ?, nachname = ?, adresse = ?, telefonnummer = ?, bildungstraeger = ?, praktikumszeit_1_von_bis = ?, praktikumszeit_2_von_bis = ?, allgemeine_notizen = ? WHERE id = ?`,
            [vorname.trim(), nachname.trim(), adresse ? adresse.trim() : null, telefonnummer ? telefonnummer.trim() : null, bildungstraeger ? bildungstraeger.trim() : null, praktikumszeit_1_von_bis ? praktikumszeit_1_von_bis.trim() : null, praktikumszeit_2_von_bis ? praktikumszeit_2_von_bis.trim() : null, allgemeine_notizen ? allgemeine_notizen.trim() : null, req.session.user.id]
        );
        req.session.user.vorname = vorname.trim();
        req.session.user.nachname = nachname.trim();
        res.json({ success: true, message: "Profil erfolgreich aktualisiert" });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});

app.put("/api/users/me/password", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: "Aktuelles und neues Passwort sind erforderlich." });
        const [users] = await pool.execute("SELECT password FROM Praktikanten WHERE id = ?", [req.session.user.id]);
        if (users.length === 0) return res.status(404).json({ success: false, message: "Benutzer nicht gefunden." });
        if (!await bcrypt.compare(currentPassword, users[0].password)) return res.status(400).json({ success: false, message: "Aktuelles Passwort ist nicht korrekt." });
        await pool.execute("UPDATE Praktikanten SET password = ? WHERE id = ?", [await bcrypt.hash(newPassword, 10), req.session.user.id]);
        res.json({ success: true, message: "Passwort erfolgreich geändert." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

// Absences (User)
app.post("/api/absences", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const { start_datum, end_datum, abwesenheit_typ, beschreibung } = req.body;
        if (!start_datum || !end_datum || !abwesenheit_typ) return res.status(400).json({ success: false, message: "Startdatum, Enddatum und Typ sind erforderlich." });
        const [result] = await pool.execute("INSERT INTO Abwesenheiten (benutzerId, start_datum, end_datum, abwesenheit_typ, beschreibung) VALUES (?, ?, ?, ?, ?)", [req.session.user.id, start_datum, end_datum, abwesenheit_typ, beschreibung || null]);
        res.status(201).json({ success: true, message: "Abwesenheit erfolgreich erstellt", id: result.insertId });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});
app.get("/api/absences", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const [absences] = await pool.execute("SELECT id, DATE_FORMAT(start_datum, '%Y-%m-%d') as start_datum, DATE_FORMAT(end_datum, '%Y-%m-%d') as end_datum, abwesenheit_typ, beschreibung FROM Abwesenheiten WHERE benutzerId = ? ORDER BY start_datum DESC", [req.session.user.id]);
        res.json({ success: true, absences });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});
app.put("/api/absences/:id", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const { start_datum, end_datum, abwesenheit_typ, beschreibung } = req.body;
        if (!start_datum || !end_datum || !abwesenheit_typ) return res.status(400).json({ success: false, message: "Startdatum, Enddatum und Typ sind erforderlich." });
        const [result] = await pool.execute("UPDATE Abwesenheiten SET start_datum = ?, end_datum = ?, abwesenheit_typ = ?, beschreibung = ? WHERE id = ? AND benutzerId = ?", [start_datum, end_datum, abwesenheit_typ, beschreibung || null, req.params.id, req.session.user.id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Abwesenheit nicht gefunden oder Zugriff verweigert" });
        res.json({ success: true, message: "Abwesenheit erfolgreich aktualisiert" });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});
app.delete("/api/absences/:id", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    try {
        const [result] = await pool.execute("DELETE FROM Abwesenheiten WHERE id = ? AND benutzerId = ?", [req.params.id, req.session.user.id]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Abwesenheit nicht gefunden oder Zugriff verweigert" });
        res.json({ success: true, message: "Abwesenheit erfolgreich gelöscht" });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});

// Server-Authoritative Time Tracking Endpoints
app.post("/api/zeiterfassung/start_segment", async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    }
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const benutzerId = req.session.user.id;
        const startTime = new Date();
        
        // Check if there's already an active timer (with row lock) - removed date restriction for cross-midnight support
        const [existingActive] = await connection.execute(
            "SELECT id FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL FOR UPDATE",
            [benutzerId]
        );
        
        if (existingActive.length > 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Es läuft bereits ein aktiver Timer." });
        }
        
        // Store active timer in database with NULL endZeit
        await connection.execute(
            "INSERT INTO Arbeitszeiten (benutzerId, startZeit, endZeit, bericht) VALUES (?, ?, NULL, '')",
            [benutzerId, startTime]
        );
        
        await connection.commit();
        
        // Keep session for performance (optional backup)
        req.session.activeSegmentStartTime = startTime.toISOString();
        console.log(`User ${benutzerId} started segment at ${startTime.toISOString()}`);
        res.json({ success: true, message: "Arbeitssegment gestartet." });
    } catch (error) {
        await connection.rollback();
        console.error("Fehler beim Starten des Arbeitssegments:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler beim Starten des Segments." });
    } finally {
        connection.release();
    }
});

app.post("/api/zeiterfassung/pause_segment", async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    }
    
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const benutzerId = req.session.user.id;
        const segmentEndTime = new Date();
        const bericht = req.body.bericht || "";

        // Find the active timer record in database WITH ROW LOCK to prevent race conditions
        const [activeRows] = await connection.execute(
            "SELECT id, startZeit, bericht FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL FOR UPDATE",
            [benutzerId]
        );
        
        // Check for stale timers from previous day and auto-end them
        if (activeRows.length > 0) {
            const activeRecord = activeRows[0];
            if (isTimerFromPreviousDay(activeRecord.startZeit)) {
                await handleStaleTimer(connection, activeRecord.id, benutzerId, activeRecord.startZeit, activeRecord.bericht);
                // After handling stale timer, look for any new active timer
                const [newActiveRows] = await connection.execute(
                    "SELECT id, startZeit FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL FOR UPDATE",
                    [benutzerId]
                );
                if (newActiveRows.length === 0) {
                    await connection.rollback();
                    return res.status(400).json({ success: false, message: "Timer wurde automatisch um 23:59 beendet da er über Nacht lief. Bitte starte einen neuen Timer." });
                }
            }
        }

        if (activeRows.length === 0) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: "Kein aktives Arbeitssegment zum Pausieren gefunden." });
        }

        const activeRecord = activeRows[0];
        const segmentStartTime = new Date(activeRecord.startZeit);

        // Check minimum duration (30 seconds) to prevent database pollution
        const durationMs = segmentEndTime.getTime() - segmentStartTime.getTime();
        const MINIMUM_DURATION_MS = 30000; // 30 seconds
        
        console.log(`[DURATION CHECK] Segment duration: ${durationMs}ms (${Math.round(durationMs/1000)}s), minimum: ${MINIMUM_DURATION_MS}ms`);
        
        if (durationMs < MINIMUM_DURATION_MS) {
            // Delete the short segment instead of saving it
            await connection.execute("DELETE FROM Arbeitszeiten WHERE id = ?", [activeRecord.id]);
            await connection.commit();
            
            // Clear session
            delete req.session.activeSegmentStartTime;
            
            const durationSeconds = Math.round(durationMs / 1000);
            return res.json({ 
                success: true, 
                message: `Segment zu kurz (${durationSeconds}s). Mindestens 30 Sekunden erforderlich. Timer zurückgesetzt.` 
            });
        }

        // Normal timer operation (no cross-midnight split)
        await connection.execute(
            "UPDATE Arbeitszeiten SET endZeit = ?, bericht = ? WHERE id = ?",
            [segmentEndTime, bericht, activeRecord.id]
        );
        
        await connection.commit();
        
        // Clear session
        delete req.session.activeSegmentStartTime;
        res.json({ success: true, message: "Arbeitssegment pausiert und gespeichert." });
    } catch (error) {
        await connection.rollback();
        console.error("Fehler beim Pausieren des Arbeitssegments:", error);
        if(req.session) delete req.session.activeSegmentStartTime;
        res.status(500).json({ success: false, message: "Interner Serverfehler beim Pausieren: " + error.message });
    } finally {
        connection.release();
    }
});

app.post("/api/zeiterfassung/end_workday", async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    }
    
    const connection = await pool.getConnection();
    
    try {
        await connection.beginTransaction();
        
        const benutzerId = req.session.user.id;
        const segmentEndTime = new Date();
        const bericht = req.body.bericht || "";

        // Check for active timer in database WITH ROW LOCK to prevent race conditions
        const [activeRows] = await connection.execute(
            "SELECT id, startZeit, bericht FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL FOR UPDATE",
            [benutzerId]
        );
        
        // Check for stale timers from previous day and auto-end them
        if (activeRows.length > 0) {
            const activeRecord = activeRows[0];
            if (isTimerFromPreviousDay(activeRecord.startZeit)) {
                await handleStaleTimer(connection, activeRecord.id, benutzerId, activeRecord.startZeit, activeRecord.bericht);
                // After handling stale timer, look for any new active timer
                const [newActiveRows] = await connection.execute(
                    "SELECT id, startZeit FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL FOR UPDATE",
                    [benutzerId]
                );
                if (newActiveRows.length === 0) {
                    await connection.commit();
                    return res.json({ success: true, message: "Timer wurde automatisch um 23:59 beendet da er über Nacht lief. Arbeitstag ist abgeschlossen." });
                }
            }
        }

        if (activeRows.length > 0) {
            // Complete the active timer - only one request can reach here due to FOR UPDATE lock
            const activeRecord = activeRows[0];
            const segmentStartTime = new Date(activeRecord.startZeit);

            // Check minimum duration (30 seconds) to prevent database pollution
            const durationMs = segmentEndTime.getTime() - segmentStartTime.getTime();
            const MINIMUM_DURATION_MS = 30000; // 30 seconds
            
            if (durationMs < MINIMUM_DURATION_MS) {
                // Delete the short segment instead of saving it
                await connection.execute("DELETE FROM Arbeitszeiten WHERE id = ?", [activeRecord.id]);
                
                // Clear session
                delete req.session.activeSegmentStartTime;
                
                // After deleting short segment, check total work time for the day
                const todayWorkTimeMs = await getTodayWorkTimeHelper(benutzerId, connection);
                const workdayDurationMs = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
                const remainingTimeMs = workdayDurationMs - todayWorkTimeMs;
                
                await connection.commit();
                
                const durationSeconds = Math.round(durationMs / 1000);
                
                if (remainingTimeMs <= 0) {
                    // User has worked enough time today
                    return res.json({ 
                        success: true, 
                        message: `Letztes Segment zu kurz (${durationSeconds}s) und wurde entfernt. Arbeitstag erfolgreich beendet - du hast deine Arbeitszeit bereits erfüllt.` 
                    });
                } else {
                    // User hasn't worked enough time
                    const totalHours = Math.floor(todayWorkTimeMs / (1000 * 60 * 60));
                    const totalMinutes = Math.floor((todayWorkTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    const remainingHours = Math.floor(remainingTimeMs / (1000 * 60 * 60));
                    const remainingMinutes = Math.floor((remainingTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    
                    return res.status(400).json({ 
                        success: false, 
                        message: `Letztes Segment zu kurz (${durationSeconds}s) und wurde entfernt. Du hast heute ${totalHours}h ${totalMinutes}min gearbeitet. Noch ${remainingHours}h ${remainingMinutes}min erforderlich. Arbeite weiter oder melde dich beim Betreuer.` 
                    });
                }
            }

            // Normal timer completion - save the segment first
            await connection.execute(
                "UPDATE Arbeitszeiten SET endZeit = ?, bericht = ? WHERE id = ?",
                [segmentEndTime, bericht, activeRecord.id]
            );
            
            // Clear session
            delete req.session.activeSegmentStartTime;
            
            // Check total work time after saving the segment
            const todayWorkTimeMs = await getTodayWorkTimeHelper(benutzerId, connection);
            const workdayDurationMs = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
            const remainingTimeMs = workdayDurationMs - todayWorkTimeMs;
            
            await connection.commit();
            
            if (remainingTimeMs <= 0) {
                // User has worked enough time today
                const totalHours = Math.floor(todayWorkTimeMs / (1000 * 60 * 60));
                const totalMinutes = Math.floor((todayWorkTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                res.json({ 
                    success: true, 
                    message: `Arbeitstag erfolgreich beendet! Du hast heute ${totalHours}h ${totalMinutes}min gearbeitet.` 
                });
            } else {
                // User hasn't worked enough time
                const totalHours = Math.floor(todayWorkTimeMs / (1000 * 60 * 60));
                const totalMinutes = Math.floor((todayWorkTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                const remainingHours = Math.floor(remainingTimeMs / (1000 * 60 * 60));
                const remainingMinutes = Math.floor((remainingTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                
                res.status(400).json({ 
                    success: false, 
                    message: `Du hast heute ${totalHours}h ${totalMinutes}min gearbeitet. Noch ${remainingHours}h ${remainingMinutes}min erforderlich. Arbeite weiter oder melde dich beim Betreuer falls du nicht weiterarbeiten kannst.` 
                });
            }
        } else {
            // No active timer found - provide contextual error messages
            const todayWorkTimeMs = await getTodayWorkTimeHelper(benutzerId, connection);
            await connection.rollback();
            
            if (todayWorkTimeMs === 0) {
                // No work done today
                return res.status(400).json({ 
                    success: false, 
                    message: "Du hast heute noch nicht gearbeitet. Starte zuerst deinen Timer." 
                });
            } else {
                // User has worked but is currently paused
                const workdayDurationMs = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
                const remainingTimeMs = workdayDurationMs - todayWorkTimeMs;
                
                if (remainingTimeMs <= 0) {
                    // User has worked enough, allow ending workday
                    return res.json({ 
                        success: true, 
                        message: "Arbeitstag erfolgreich beendet. Du hast deine Arbeitszeit bereits erfüllt." 
                    });
                } else {
                    // User has remaining time
                    const remainingHours = Math.floor(remainingTimeMs / (1000 * 60 * 60));
                    const remainingMinutes = Math.floor((remainingTimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    
                    return res.status(400).json({ 
                        success: false, 
                        message: `Deine letzte Pause-Zeit wurde gespeichert. Du kannst deinen Arbeitstag nicht abschliessen da du noch ${remainingHours}h ${remainingMinutes}min Restzeit hast. Wenn du nicht weiterarbeiten kannst, bitte beim Betreuer melden.` 
                    });
                }
            }
        }
        
    } catch (error) {
        await connection.rollback();
        console.error("Fehler beim Beenden des Arbeitstages:", error);
        if(req.session) delete req.session.activeSegmentStartTime;
        res.status(500).json({ success: false, message: "Interner Serverfehler beim Beenden des Arbeitstages: " + error.message });
    } finally {
        connection.release();
    }
});

app.get("/api/zeiterfassung/status", async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, message: "Nicht eingeloggt" });
    }
    try {
        const benutzerId = req.session.user.id;
        const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone

        // Find any active timer (cross-midnight support) 
        const [activeRows] = await pool.execute(
            "SELECT id, startZeit, bericht FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL",
            [benutzerId]
        );
        
        let autoCutoffDetected = false;
        let cutoffMessage = null;
        
        // Auto-cutoff notifications now handled entirely by frontend localStorage
        // No longer use session storage for autocut notifications
        
        // Check for stale timers from previous day and auto-end them
        if (activeRows.length > 0) {
            const activeRecord = activeRows[0];
            
            if (isTimerFromPreviousDay(activeRecord.startZeit)) {
                // Prevent repeated autocut notifications for same timer
                const timerId = activeRecord.id;
                const sessionKey = `autocut_handled_${timerId}`;
                
                if (!req.session[sessionKey]) {
                    console.log(`[STATUS API] Detected stale timer ${timerId}, triggering auto-cutoff`);
                    const connection = await pool.getConnection();
                    try {
                        await handleStaleTimer(connection, activeRecord.id, benutzerId, activeRecord.startZeit, activeRecord.bericht);
                        autoCutoffDetected = true;
                        cutoffMessage = `Auto-Cutoff: Timer wurde automatisch um 23:59 beendet. Du warst nicht ordnungsgemäß ausgeloggt.`;
                        
                        // Mark this timer as handled to prevent repeated notifications
                        req.session[sessionKey] = Date.now();
                        
                        // Clear session since timer was auto-ended
                        delete req.session.activeSegmentStartTime;
                    } finally {
                        connection.release();
                    }
                } else {
                    console.log(`[STATUS API] Timer ${timerId} already handled, skipping autocut notification`);
                }
            }
        }
        
        // Fetch completed segments for today only (after potential auto-cutoff)
        const [todayRows] = await pool.execute(
            "SELECT startZeit, endZeit FROM Arbeitszeiten WHERE benutzerId = ? AND DATE(startZeit) = ? AND endZeit IS NOT NULL",
            [benutzerId, today]
        );

        let totalDurationMs = 0;
        let activeSegmentStartTime = null;

        // Calculate today's completed work
        todayRows.forEach(row => {
            const start = new Date(row.startZeit);
            const end = new Date(row.endZeit);
            const durationMs = end.getTime() - start.getTime();
            if (durationMs > 0) {
                totalDurationMs += durationMs;
            }
        });

        // Check for active timer (after potential cutoff handling)
        if (!autoCutoffDetected) {
            const [newActiveRows] = await pool.execute(
                "SELECT startZeit FROM Arbeitszeiten WHERE benutzerId = ? AND endZeit IS NULL",
                [benutzerId]
            );
            if (newActiveRows.length > 0) {
                activeSegmentStartTime = newActiveRows[0].startZeit;
            }
        }

        // Update session to match database state (for backward compatibility)
        if (activeSegmentStartTime) {
            req.session.activeSegmentStartTime = new Date(activeSegmentStartTime).toISOString();
        } else {
            delete req.session.activeSegmentStartTime;
        }

        const response = { 
            success: true, 
            totalDurationMs,
            activeSegmentStartTime: activeSegmentStartTime ? new Date(activeSegmentStartTime).toISOString() : null,
            autoCutoffDetected,
            cutoffMessage
        };
        
        res.json(response);

    } catch (error) {
        console.error("Fehler beim Abrufen des Zeitstatus:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler." });
    }
});

// Admin Routes
app.get("/api/praktikanten", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ message: "Zugriff verweigert" });
    try {
        const [praktikanten] = await pool.execute("SELECT id, email, vorname, nachname, rolle, status, total_urlaubstage_annually FROM Praktikanten ORDER BY rolle DESC, status, vorname, nachname");
        
        // Calculate remaining vacation days for each practitioner
        const currentYear = new Date().getFullYear();
        const yearStartDate = `${currentYear}-01-01`;
        const yearEndDate = `${currentYear}-12-31`;
        
        for (let praktikant of praktikanten) {
            const vacationHoursUsed = await getVacationHoursForPeriodHelper(praktikant.id, yearStartDate, yearEndDate, pool);
            const usedUrlaubstageThisYear = vacationHoursUsed / HOURS_PER_URLAUBSTAG_GLOBAL;
            const totalUrlaubstage = praktikant.total_urlaubstage_annually || 0;
            praktikant.remainingUrlaubstage = Math.max(0, totalUrlaubstage - usedUrlaubstageThisYear);
            praktikant.usedUrlaubstageThisYear = usedUrlaubstageThisYear;
        }
        
        res.json(praktikanten);
    } catch (error) { res.status(500).json({ message: "Fehler beim Abrufen der Praktikanten" }); }
});

app.put("/api/praktikanten/:id", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ message: "Zugriff verweigert" });
    try {
        const praktikantId = req.params.id;
        const { email, rolle, passwort, vorname, nachname, adresse, telefonnummer, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen } = req.body;

        // Fetch the user to check their current email and role
        const [userRows] = await pool.execute("SELECT email, rolle FROM Praktikanten WHERE id = ?", [praktikantId]);
        if (userRows.length === 0) {
            return res.status(404).json({ success: false, message: "Benutzer nicht gefunden." });
        }
        const userToEdit = userRows[0];
        const mainAdminEmailFromEnv = process.env.MAIN_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
        const mainAdminEmail = mainAdminEmailFromEnv || "admin@example.com"; // Generic fallback

        // Prevent admin from changing their own email if they are not the main admin, or any admin from changing the main admin's email
        if (email && email !== userToEdit.email) {
            if (parseInt(praktikantId) === req.session.user.id && userToEdit.email !== mainAdminEmail) { // Admin trying to change their own email (and is not main admin)
                return res.status(403).json({ success: false, message: "Administratoren (außer Haupt-Admin) können ihre eigene E-Mail-Adresse nicht ändern." });
            }
            if (userToEdit.email === mainAdminEmail) { // Anyone trying to change the main admin's email
                 return res.status(403).json({ success: false, message: `Die E-Mail-Adresse des Hauptadministrators (${mainAdminEmail}) kann nicht geändert werden.` });
            }
            // Check if the new email already exists for another user
            const [existingEmailRows] = await pool.execute("SELECT id FROM Praktikanten WHERE email = ? AND id != ?", [email, praktikantId]);
            if (existingEmailRows.length > 0) {
                return res.status(409).json({ success: false, message: "Diese E-Mail-Adresse wird bereits von einem anderen Benutzer verwendet." });
            }
        }

        // Prevent changing the main admin's role to Praktikant
        if (userToEdit.email === mainAdminEmail && rolle && rolle === 'Praktikant') { // Ensure 'rolle' is checked if it's provided
            return res.status(403).json({ success: false, message: `Die Rolle des Hauptadministrators (${mainAdminEmail}) kann nicht zu 'Praktikant' geändert werden.` });
        }

        // Prevent changing role from Betreuer to Praktikant if this would leave no admins
        if (userToEdit.rolle === 'Betreuer' && rolle === 'Praktikant') {
            // Count total number of active Betreuer users
            const [adminCount] = await pool.execute(
                "SELECT COUNT(*) as count FROM Praktikanten WHERE rolle = 'Betreuer' AND status = 'Aktiv'", 
                []
            );
            
            const totalActiveAdmins = adminCount[0].count;
            
            // If this would be the last admin, prevent the change
            if (totalActiveAdmins <= 1) {
                return res.status(403).json({ 
                    success: false, 
                    message: "Die Rolle kann nicht geändert werden: Es muss mindestens ein aktiver Administrator (Betreuer) im System vorhanden sein." 
                });
            }
        }

        let query;
        let queryParams = [];
        let updateFields = [];
        
        // If rolle is not provided in req.body, use the existing role
        const finalRolle = rolle || userToEdit.rolle;
        updateFields.push("rolle = ?");
        queryParams.push(finalRolle);

        if (email && email !== userToEdit.email) {
            // Only add email to update if it's different and passed validation
            updateFields.push("email = ?");
            queryParams.push(email);
        }

        if (passwort) {
            updateFields.push("password = ?");
            queryParams.push(await bcrypt.hash(passwort, 10));
        }

        const otherFields = { vorname, nachname, adresse, telefonnummer, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen };
        for (const [key, value] of Object.entries(otherFields)) {
            if (value !== undefined) { // Allow updating to null if explicitly passed as null, or just not present
                updateFields.push(`${key} = ?`);
                queryParams.push(value === '' ? null : value); // Treat empty string as null for optional fields
            }
        }

        if (updateFields.length === 0) {
            return res.json({ success: true, message: "Keine Änderungen zum Aktualisieren angegeben." });
        }

        query = `UPDATE Praktikanten SET ${updateFields.join(", ")} WHERE id = ?`;
        queryParams.push(praktikantId);

        await pool.execute(query, queryParams);
        res.json({ success: true, message: "Praktikant aktualisiert" });
    } catch (error) {
        console.error("Fehler beim Aktualisieren des Praktikanten:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler" });
    }
});

app.put("/api/praktikanten/:id/status", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert" });
    try {
        const { status } = req.body;
        if (!status || !['aktiv', 'inaktiv'].includes(status)) return res.status(400).json({ success: false, message: "Ungültiger Statuswert." });
        const [userRows] = await pool.execute("SELECT rolle FROM Praktikanten WHERE id = ?", [req.params.id]);
        if (userRows.length === 0) return res.status(404).json({ success: false, message: "Benutzer nicht gefunden."});
        if (userRows[0].rolle === 'Betreuer' && status === 'inaktiv' && parseInt(req.params.id) === req.session.user.id) return res.status(400).json({ success: false, message: "Ein Betreuer kann sich nicht selbst auf inaktiv setzen." });
        await pool.execute("UPDATE Praktikanten SET status = ? WHERE id = ?", [status, req.params.id]);
        res.json({ success: true, message: `Praktikant-Status erfolgreich auf '${status}' aktualisiert.` });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.put("/api/admin/praktikanten/:userId/urlaubstage", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const { userId } = req.params;
    const { total_urlaubstage_annually } = req.body;
    if (isNaN(parseInt(userId)) || total_urlaubstage_annually === undefined || isNaN(parseInt(total_urlaubstage_annually)) || parseInt(total_urlaubstage_annually) < 0) {
        return res.status(400).json({ success: false, message: "Ungültige Eingabe." });
    }
    try {
        const [result] = await pool.execute("UPDATE Praktikanten SET total_urlaubstage_annually = ? WHERE id = ?", [parseInt(total_urlaubstage_annually), parseInt(userId)]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Praktikant nicht gefunden." });
        res.json({ success: true, message: `Urlaubstage aktualisiert.` });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.delete("/api/praktikanten/:id", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ message: "Zugriff verweigert" });
    try {
        const [userRows] = await pool.execute("SELECT rolle, status FROM Praktikanten WHERE id = ?", [req.params.id]);
        if (userRows.length === 0) return res.status(404).json({ message: "Benutzer nicht gefunden." });
        if (userRows[0].rolle === "Betreuer") return res.status(403).json({ message: "Betreuer-Konten können nicht gelöscht werden." });
        if (userRows[0].status === 'aktiv') {
            const [berichte] = await pool.execute("SELECT COUNT(*) as count FROM Arbeitszeiten WHERE benutzerId = ?", [req.params.id]);
            if (berichte[0].count > 0) return res.status(400).json({ message: "Aktive Praktikanten mit Berichten können nicht gelöscht werden. Erst Status auf 'inaktiv' setzen." });
        }
        await pool.execute("DELETE FROM Praktikanten WHERE id = ?", [req.params.id]);
        res.json({ success: true, message: "Praktikant gelöscht" });
    } catch (error) { res.status(500).json({ message: "Fehler beim Löschen." }); }
});

const HOURS_PER_URLAUBSTAG_GLOBAL = 8;

// Helper to calculate total work time for today
async function getTodayWorkTimeHelper(benutzerId, poolConnection) {
    const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format in local timezone
    
    console.log(`[WORK TIME] Calculating work time for user ${benutzerId} on ${today}`);
    
    const [todayRows] = await poolConnection.execute(
        "SELECT startZeit, endZeit, bericht FROM Arbeitszeiten WHERE benutzerId = ? AND DATE(startZeit) = ? AND endZeit IS NOT NULL",
        [benutzerId, today]
    );

    console.log(`[WORK TIME] Found ${todayRows.length} completed segments for today`);
    
    let totalDurationMs = 0;
    todayRows.forEach((row, index) => {
        const start = new Date(row.startZeit);
        const end = new Date(row.endZeit);
        const durationMs = end.getTime() - start.getTime();
        const durationHours = durationMs / (1000 * 60 * 60);
        
        console.log(`[WORK TIME] Segment ${index + 1}: ${start.toLocaleString('de-DE')} → ${end.toLocaleString('de-DE')} = ${durationHours.toFixed(2)}h`);
        console.log(`[WORK TIME] Segment message: ${row.bericht}`);
        
        if (durationMs > 0) {
            totalDurationMs += durationMs;
        }
    });

    const totalHours = totalDurationMs / (1000 * 60 * 60);
    console.log(`[WORK TIME] Total work time: ${totalHours.toFixed(2)} hours (${totalDurationMs}ms)`);
    
    return totalDurationMs;
}

async function getVacationHoursForPeriodHelper(benutzerId, periodStartDate, periodEndDate, poolConnection) {
    console.log(`[Helper] Calculating vacation for User: ${benutzerId}, Period: ${periodStartDate} to ${periodEndDate}`);
    const [vacationAbsences] = await poolConnection.execute( `SELECT start_datum, end_datum, beschreibung FROM Abwesenheiten WHERE benutzerId = ? AND abwesenheit_typ = 'Urlaub' AND start_datum <= ? AND end_datum >= ?`, [benutzerId, periodEndDate, periodStartDate]);
    console.log(`[Helper] User: ${benutzerId}, Fetched ${vacationAbsences.length} vacation absences for period.`);
    let vacationHours = 0;
    const [pStartYear, pStartMonth, pStartDay] = periodStartDate.split('-').map(Number);
    const [pEndYear, pEndMonth, pEndDay] = periodEndDate.split('-').map(Number);
    const reportPeriodStartObj = new Date(Date.UTC(pStartYear, pStartMonth - 1, pStartDay, 0, 0, 0, 0));
    const reportPeriodEndObj = new Date(Date.UTC(pEndYear, pEndMonth - 1, pEndDay, 23, 59, 59, 999));
    vacationAbsences.forEach(abw => {
        const absenceStartObj = new Date(abw.start_datum); const absenceEndObj = new Date(abw.end_datum);
        let currentDateIter = new Date(Date.UTC(absenceStartObj.getFullYear(), absenceStartObj.getMonth(), absenceStartObj.getDate()));
        const loopUntilDate = new Date(Date.UTC(absenceEndObj.getFullYear(), absenceEndObj.getMonth(), absenceEndObj.getDate()));
        loopUntilDate.setUTCDate(loopUntilDate.getUTCDate() + 1);
        let daysCountedThisAbsence = 0;
        console.log(`[Helper] User: ${benutzerId}, DB Absence: ${abw.start_datum.toISOString().split('T')[0]} to ${abw.end_datum.toISOString().split('T')[0]}. Iterating UTC from ${currentDateIter.toISOString().split('T')[0]} until ${loopUntilDate.toISOString().split('T')[0]}`);
        while (currentDateIter < loopUntilDate) {
            const checkingDateLog = currentDateIter.toISOString().split('T')[0]; let countedThisIter = false;
            if (currentDateIter >= reportPeriodStartObj && currentDateIter <= reportPeriodEndObj) {
                const dayOfWeek = currentDateIter.getUTCDay();
                if (dayOfWeek !== 0 && dayOfWeek !== 6) { vacationHours += HOURS_PER_URLAUBSTAG_GLOBAL; daysCountedThisAbsence++; countedThisIter = true; }
                console.log(`[Helper] User: ${benutzerId}, Checking UTC: ${checkingDateLog}, DayOfWeek: ${dayOfWeek}, InReportPeriod: Yes, Counted: ${countedThisIter}`);
            } else { console.log(`[Helper] User: ${benutzerId}, Checking UTC: ${checkingDateLog}, InReportPeriod: No`); }
            currentDateIter.setUTCDate(currentDateIter.getUTCDate() + 1);
        }
        console.log(`[Helper] User: ${benutzerId}, Absence (DB: ${abw.start_datum.toISOString().split('T')[0]}-${abw.end_datum.toISOString().split('T')[0]}): FINISHED LOOP. Counted ${daysCountedThisAbsence} weekdays.`);
    });
    console.log(`[Helper] User: ${benutzerId}, Period: ${periodStartDate}-${periodEndDate}, Total calculated vacationHours: ${vacationHours}`);
    return vacationHours;
}

app.get("/api/admin/users/:id/profile", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    try {
        const userId = parseInt(req.params.id);
        if (isNaN(userId)) return res.status(400).json({ success: false, message: "Ungültige Benutzer-ID." });
        const [rows] = await pool.execute("SELECT id, email, rolle, status, vorname, nachname, adresse, telefonnummer, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen, total_urlaubstage_annually FROM Praktikanten WHERE id = ?", [userId]);
        if (rows.length > 0) {
            const profile = rows[0]; const currentYear = new Date().getFullYear();
            const vacationHoursForYear = await getVacationHoursForPeriodHelper(userId, `${currentYear}-01-01`, `${currentYear}-12-31`, pool);
            const usedUrlaubstageThisYear = vacationHoursForYear / HOURS_PER_URLAUBSTAG_GLOBAL;
            const remainingUrlaubstage = (profile.total_urlaubstage_annually || 0) - usedUrlaubstageThisYear;
            res.json({ success: true, profile: { ...profile, usedUrlaubstageThisYear, remainingUrlaubstage } });
        } else res.status(404).json({ success: false, message: "Benutzerprofil nicht gefunden." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.get("/api/admin/users/:userId/absences", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, message: "Ungültige Benutzer-ID." });
    try {
        const [absences] = await pool.execute("SELECT id, DATE_FORMAT(start_datum, '%Y-%m-%d') as start_datum, DATE_FORMAT(end_datum, '%Y-%m-%d') as end_datum, abwesenheit_typ, beschreibung FROM Abwesenheiten WHERE benutzerId = ? ORDER BY start_datum DESC", [userId]);
        res.json({ success: true, absences });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

// Admin endpoint to create new absences for users (frontend expects this path)
app.post("/api/admin/users/:userId/absences", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const userId = parseInt(req.params.userId);
    const { start_datum, end_datum, abwesenheit_typ, beschreibung } = req.body;
    if (isNaN(userId) || !start_datum || !end_datum || !abwesenheit_typ || !/^\d{4}-\d{2}-\d{2}$/.test(start_datum) || !/^\d{4}-\d{2}-\d{2}$/.test(end_datum) || !['Krankheit', 'Urlaub'].includes(abwesenheit_typ))
        return res.status(400).json({ success: false, message: "Ungültige Eingabedaten." });
    try {
        const [result] = await pool.execute("INSERT INTO Abwesenheiten (benutzerId, start_datum, end_datum, abwesenheit_typ, beschreibung) VALUES (?, ?, ?, ?, ?)", [userId, start_datum, end_datum, abwesenheit_typ, beschreibung || null]);
        res.status(201).json({ success: true, message: "Abwesenheit erstellt.", id: result.insertId });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.post("/api/admin/absences/:userId", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ success: false, message: "Ungültige Benutzer-ID." });
    try {
        const { start_datum, end_datum, abwesenheit_typ, beschreibung } = req.body;
        if (!start_datum || !end_datum || !abwesenheit_typ) return res.status(400).json({ success: false, message: "Startdatum, Enddatum und Typ sind erforderlich." });
        const [result] = await pool.execute("INSERT INTO Abwesenheiten (benutzerId, start_datum, end_datum, abwesenheit_typ, beschreibung) VALUES (?, ?, ?, ?, ?)", [userId, start_datum, end_datum, abwesenheit_typ, beschreibung || null]);
        res.status(201).json({ success: true, message: "Abwesenheit erfolgreich erstellt", id: result.insertId });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler" }); }
});

app.put("/api/admin/absences/:absenceId", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const absenceId = parseInt(req.params.absenceId);
    if (isNaN(absenceId)) return res.status(400).json({ success: false, message: "Ungültige Abwesenheits-ID." });
    try {
        const { start_datum, end_datum, abwesenheit_typ, beschreibung } = req.body;
        if (!start_datum || !end_datum || !abwesenheit_typ) return res.status(400).json({ success: false, message: "Startdatum, Enddatum und Typ sind erforderlich." });
        const [result] = await pool.execute("UPDATE Abwesenheiten SET start_datum = ?, end_datum = ?, abwesenheit_typ = ?, beschreibung = ? WHERE id = ?", [start_datum, end_datum, abwesenheit_typ, beschreibung || null, absenceId]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Abwesenheit nicht gefunden." });
        res.json({ success: true, message: "Abwesenheit erfolgreich aktualisiert." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.delete("/api/admin/absences/:absenceId", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const absenceId = parseInt(req.params.absenceId);
    if (isNaN(absenceId)) return res.status(400).json({ success: false, message: "Ungültige Abwesenheits-ID." });
    try {
        const [result] = await pool.execute("DELETE FROM Abwesenheiten WHERE id = ?", [absenceId]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Abwesenheit nicht gefunden." });
        res.json({ success: true, message: "Abwesenheit erfolgreich gelöscht." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.get("/api/admin/berichte", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ message: "Zugriff verweigert" });
    try {
        const [berichte] = await pool.execute(
            "SELECT a.id, a.benutzerId, p.vorname, p.nachname, a.startZeit, a.endZeit, a.bericht, DATE_FORMAT(a.startZeit, '%d.%m.%Y') as datum " +
            "FROM Arbeitszeiten a JOIN Praktikanten p ON a.benutzerId = p.id ORDER BY a.startZeit ASC"
        );

        const consolidated = {};

        berichte.forEach(entry => {
            const entryDate = `${entry.datum}-${entry.benutzerId}`; // Group by day AND user
            const start = new Date(entry.startZeit);
            
            // Handle active timers (NULL endZeit)
            let durationMs, endTimeString;
            if (entry.endZeit === null) {
                // Active timer - calculate current duration
                const now = new Date();
                durationMs = now.getTime() - start.getTime();
                endTimeString = "Läuft noch";
            } else {
                // Completed timer
                const end = new Date(entry.endZeit);
                durationMs = end.getTime() - start.getTime();
                endTimeString = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            }

            if (!consolidated[entryDate]) {
                consolidated[entryDate] = {
                    id: entry.id,
                    benutzerId: entry.benutzerId,
                    vorname: entry.vorname,
                    nachname: entry.nachname,
                    datum: entry.datum,
                    startzeit: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    endzeit: endTimeString,
                    durationMs: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben." 
                        ? `[${start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}-${endTimeString}] ${entry.bericht}` 
                        : "",
                    isAutoCutoff: isAutoCutoffEntry(entry),
                    segments: [{
                        id: entry.id, // Individual Arbeitszeiten record ID
                        start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                        end: endTimeString,
                        duration: durationMs > 0 ? durationMs : 0,
                        bericht: entry.bericht || ""
                    }]
                };
            } else {
                consolidated[entryDate].endzeit = endTimeString;
                consolidated[entryDate].durationMs += (durationMs > 0 ? durationMs : 0);
                // Mark as auto-cutoff if ANY segment was auto-cutoff
                consolidated[entryDate].isAutoCutoff = consolidated[entryDate].isAutoCutoff || isAutoCutoffEntry(entry);
                if (entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben.") {
                    const segmentTimeRange = `[${start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}-${endTimeString}]`;
                    const segmentText = `${segmentTimeRange} ${entry.bericht}`;
                    
                    if (consolidated[entryDate].bericht) {
                        consolidated[entryDate].bericht += `\n\n${segmentText}`;
                    } else {
                        consolidated[entryDate].bericht = segmentText;
                    }
                }
                // Add segment for this additional work period
                consolidated[entryDate].segments.push({
                    id: entry.id, // Individual Arbeitszeiten record ID
                    start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    end: endTimeString,
                    duration: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht || "",
                    isAutoCutoff: isAutoCutoffEntry(entry)
                });
            }
        });

        const result = Object.values(consolidated).map(entry => {
            const totalMinutes = Math.round(entry.durationMs / (1000 * 60));
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            entry.dauer = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            
            // Format segment durations
            entry.segments.forEach(seg => {
                const segTotalMinutes = Math.round(seg.duration / (1000 * 60));
                const segHours = Math.floor(segTotalMinutes / 60);
                const segMinutes = segTotalMinutes % 60;
                seg.dauer = `${String(segHours).padStart(2, '0')}:${String(segMinutes).padStart(2, '0')}`;
                delete seg.duration;
            });
            
            delete entry.durationMs;
            return entry;
        }).sort((a, b) => {
            const [dayA, monthA, yearA] = a.datum.split('.');
            const [dayB, monthB, yearB] = b.datum.split('.');
            return new Date(`${yearB}-${monthB}-${dayB}`) - new Date(`${yearA}-${monthA}-${dayA}`);
        });

        res.json(result);
    } catch (error) {
        console.error("Fehler beim Laden der Admin-Berichte:", error);
        res.status(500).json({ message: "Fehler beim Laden der Berichte" });
    }
});
// Admin endpoint for specific user's monthly reports
app.get("/api/admin/berichte/:praktikantId/monat/:monat", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") {
        return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    }
    
    try {
        const praktikantId = parseInt(req.params.praktikantId);
        const { monat } = req.params;
        
        if (isNaN(praktikantId) || !/^\d{4}-\d{2}$/.test(monat)) {
            return res.status(400).json({ success: false, message: "Ungültige Parameter." });
        }
        
        const [jahr, monatNummer] = monat.split('-');
        const currentYear = parseInt(jahr);
        const currentMonth = parseInt(monatNummer);
        const monthStartDate = `${monat}-01 00:00:00`;
        const lastDayOfMonth = new Date(currentYear, currentMonth, 0).getDate();
        const monthEndDate = `${monat}-${String(lastDayOfMonth).padStart(2, '0')} 23:59:59`;

        // Get work time entries for the month
        const [berichteArbeitszeiten] = await pool.execute(
            "SELECT a.id, DATE_FORMAT(a.startZeit, '%d.%m.%Y') as datum, a.startZeit, a.endZeit, a.bericht FROM Arbeitszeiten a WHERE a.benutzerId = ? AND a.startZeit >= ? AND a.startZeit <= ? ORDER BY a.startZeit ASC",
            [praktikantId, monthStartDate, monthEndDate]
        );

        // Get absence entries for the month
        const [abwesenheitenDesMonats] = await pool.execute(
            "SELECT id, DATE_FORMAT(start_datum, '%Y-%m-%d') as start_datum_iso, DATE_FORMAT(end_datum, '%Y-%m-%d') as end_datum_iso, abwesenheit_typ, beschreibung FROM Abwesenheiten WHERE benutzerId = ? AND end_datum >= ? AND start_datum <= ? ORDER BY start_datum ASC",
            [praktikantId, `${monat}-01`, monthEndDate.substring(0,10)]
        );

        // Get user details
        const [praktikantDetailsRows] = await pool.execute(
            "SELECT email, vorname, nachname, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen, total_urlaubstage_annually FROM Praktikanten WHERE id = ?",
            [praktikantId]
        );

        if (praktikantDetailsRows.length === 0) {
            return res.status(404).json({ success: false, message: "Praktikant nicht gefunden." });
        }

        const praktikantDetails = praktikantDetailsRows[0];
        const total_urlaubstage_annually = praktikantDetails.total_urlaubstage_annually || 0;
        let calculatedTotalMonthlyHours = 0;
        const reportEntries = [];
        let monthlyUrlaubTage = 0;
        let monthlyKrankheitTage = 0;
        
        // Create consolidated entries with segments (similar to user /api/berichte/monat/:monat)
        const consolidated = {};
        berichteArbeitszeiten.forEach(entry => {
            const start = new Date(entry.startZeit);
            const entryDate = entry.datum;

            let durationMs, endTimeString;
            if (entry.endZeit === null) {
                const now = new Date();
                durationMs = now.getTime() - start.getTime();
                endTimeString = "Läuft noch";
            } else {
                const end = new Date(entry.endZeit);
                durationMs = end.getTime() - start.getTime();
                endTimeString = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            }

            const dauer = durationMs > 0 ? durationMs / (1000 * 60 * 60) : 0;
            calculatedTotalMonthlyHours += dauer;

            if (!consolidated[entryDate]) {
                consolidated[entryDate] = {
                    id: `arbeit-${entry.id}`,
                    datum: entryDate,
                    type: 'Arbeit',
                    startzeit: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    endzeit: endTimeString,
                    durationMs: durationMs > 0 ? durationMs : 0,
                    beschreibung: entry.bericht || "",
                    sortDate: new Date(parseInt(entryDate.substring(6, 10)), parseInt(entryDate.substring(3, 5)) - 1, parseInt(entryDate.substring(0, 2))),
                    segments: [{
                        id: entry.id, // Individual Arbeitszeiten record ID
                        start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                        end: endTimeString,
                        duration: durationMs > 0 ? durationMs : 0,
                        bericht: entry.bericht || ""
                    }]
                };
            } else {
                consolidated[entryDate].endzeit = endTimeString;
                consolidated[entryDate].durationMs += (durationMs > 0 ? durationMs : 0);
                if (entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben.") {
                    if (consolidated[entryDate].beschreibung) {
                        consolidated[entryDate].beschreibung += `\n${entry.bericht}`;
                    } else {
                        consolidated[entryDate].beschreibung = entry.bericht;
                    }
                }
                consolidated[entryDate].segments.push({
                    id: entry.id, // Individual Arbeitszeiten record ID
                    start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    end: endTimeString,
                    duration: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht || "",
                    isAutoCutoff: isAutoCutoffEntry(entry)
                });
            }
        });

        // Convert consolidated entries to final format
        Object.values(consolidated).forEach(entry => {
            const totalHours = entry.durationMs / (1000 * 60 * 60);
            const hours = Math.floor(totalHours);
            const minutes = Math.round((totalHours - hours) * 60);
            entry.dauer = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            
            // Format segment durations
            entry.segments.forEach(seg => {
                const segTotalHours = seg.duration / (1000 * 60 * 60);
                const segHours = Math.floor(segTotalHours);
                const segMinutes = Math.round((segTotalHours - segHours) * 60);
                seg.dauer = `${String(segHours).padStart(2, '0')}:${String(segMinutes).padStart(2, '0')}`;
                delete seg.duration;
            });
            
            delete entry.durationMs;
            reportEntries.push(entry);
        });

        // Process absence entries
        const firstDayOfMonthUTC = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
        const actualLastDayNumberInMonth = new Date(currentYear, currentMonth, 0).getUTCDate();
        const lastDayOfMonthUTC = new Date(Date.UTC(currentYear, currentMonth - 1, actualLastDayNumberInMonth, 23, 59, 59, 999));

        abwesenheitenDesMonats.forEach(abw => {
            const absenceStartUTC = new Date(Date.UTC(parseInt(abw.start_datum_iso.substring(0,4)), parseInt(abw.start_datum_iso.substring(5,7)) - 1, parseInt(abw.start_datum_iso.substring(8,10))));
            const absenceEndUTC = new Date(Date.UTC(parseInt(abw.end_datum_iso.substring(0,4)), parseInt(abw.end_datum_iso.substring(5,7)) - 1, parseInt(abw.end_datum_iso.substring(8,10))));
            let currentDayOfAbsence = new Date(absenceStartUTC);
            
            while (currentDayOfAbsence <= absenceEndUTC) {
                if (currentDayOfAbsence >= firstDayOfMonthUTC && currentDayOfAbsence <= lastDayOfMonthUTC) {
                    const dayOfWeek = currentDayOfAbsence.getUTCDay();
                    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
                        const dayFormatted = `${String(currentDayOfAbsence.getUTCDate()).padStart(2, '0')}.${String(currentDayOfAbsence.getUTCMonth() + 1).padStart(2, '0')}.${currentDayOfAbsence.getUTCFullYear()}`;
                        let entryDauer = "Ganztägig";
                        
                        if (abw.abwesenheit_typ === 'Urlaub') {
                            calculatedTotalMonthlyHours += HOURS_PER_URLAUBSTAG_GLOBAL;
                            monthlyUrlaubTage++;
                            entryDauer = "08:00";
                        } else if (abw.abwesenheit_typ === 'Krankheit') {
                            monthlyKrankheitTage++;
                        }
                        
                        reportEntries.push({
                            id: `abwesenheit-${abw.id || 'print'}-${dayFormatted.replace(/\./g, '-')}`,
                            datum: dayFormatted,
                            type: abw.abwesenheit_typ,
                            dauer: entryDauer,
                            beschreibung: abw.beschreibung,
                            startzeit: null,
                            endzeit: null,
                            sortDate: new Date(currentDayOfAbsence)
                        });
                    }
                }
                currentDayOfAbsence.setUTCDate(currentDayOfAbsence.getUTCDate() + 1);
            }
        });

        // Sort entries by date and clean up
        reportEntries.sort((a, b) => a.sortDate - b.sortDate);
        reportEntries.forEach(entry => delete entry.sortDate);

        // Calculate vacation day usage for the year
        const [urlaubstageImJahrRows] = await pool.execute(
            "SELECT start_datum, end_datum FROM Abwesenheiten WHERE benutzerId = ? AND abwesenheit_typ = 'Urlaub' AND start_datum <= ? AND end_datum >= ?",
            [praktikantId, `${currentYear}-12-31`, `${currentYear}-01-01`]
        );

        const urlaubDaysSet = new Set();
        urlaubstageImJahrRows.forEach(urlaub => {
            const startDateObj = new Date(urlaub.start_datum);
            const endDateObj = new Date(urlaub.end_datum);
            let currentUrlaubDay = new Date(Date.UTC(startDateObj.getUTCFullYear(), startDateObj.getUTCMonth(), startDateObj.getUTCDate()));
            const urlaubEndDay = new Date(Date.UTC(endDateObj.getUTCFullYear(), endDateObj.getUTCMonth(), endDateObj.getUTCDate()));
            
            while(currentUrlaubDay <= urlaubEndDay) {
                if (currentUrlaubDay.getUTCFullYear() === currentYear) {
                    const dayOfWeek = currentUrlaubDay.getUTCDay();
                    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                        urlaubDaysSet.add(currentUrlaubDay.toISOString().split('T')[0]);
                    }
                }
                currentUrlaubDay.setUTCDate(currentUrlaubDay.getUTCDate() + 1);
            }
        });

        const usedUrlaubstageThisYear = urlaubDaysSet.size;
        const remainingUrlaubstageYearEnd = total_urlaubstage_annually - usedUrlaubstageThisYear;

        // Calculate vacation days used up to this month end
        const reportMonthEndDateForCalc = new Date(Date.UTC(currentYear, currentMonth - 1, lastDayOfMonth));
        const urlaubDaysSetMonth = new Set();
        
        urlaubstageImJahrRows.forEach(urlaub => {
            const startDateObj = new Date(urlaub.start_datum);
            const endDateObj = new Date(urlaub.end_datum);
            let currentUrlaubDay = new Date(Date.UTC(startDateObj.getUTCFullYear(), startDateObj.getUTCMonth(), startDateObj.getUTCDate()));
            const urlaubEndDay = new Date(Date.UTC(endDateObj.getUTCFullYear(), endDateObj.getUTCMonth(), endDateObj.getUTCDate()));
            
            while(currentUrlaubDay <= urlaubEndDay) {
                if (currentUrlaubDay.getUTCFullYear() === currentYear && currentUrlaubDay <= reportMonthEndDateForCalc) {
                    const dayOfWeek = currentUrlaubDay.getUTCDay();
                    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                        urlaubDaysSetMonth.add(currentUrlaubDay.toISOString().split('T')[0]);
                    }
                }
                currentUrlaubDay.setUTCDate(currentUrlaubDay.getUTCDate() + 1);
            }
        });

        const usedUrlaubstageUpToMonthEnd = urlaubDaysSetMonth.size;
        const remainingUrlaubstageAsOfMonatEnd = total_urlaubstage_annually - usedUrlaubstageUpToMonthEnd;

        res.json({
            success: true,
            reportEntries: reportEntries,
            email: praktikantDetails.email,
            vorname: praktikantDetails.vorname,
            nachname: praktikantDetails.nachname,
            bildungstraeger: praktikantDetails.bildungstraeger,
            praktikumszeit_1_von_bis: praktikantDetails.praktikumszeit_1_von_bis,
            praktikumszeit_2_von_bis: praktikantDetails.praktikumszeit_2_von_bis,
            allgemeine_notizen: praktikantDetails.allgemeine_notizen,
            calculatedTotalMonthlyHours: parseFloat(calculatedTotalMonthlyHours.toFixed(2)),
            monthlyAbsenceCounts: { Urlaub: monthlyUrlaubTage, Krankheit: monthlyKrankheitTage },
            internDetails: {
                total_urlaubstage_annually: total_urlaubstage_annually,
                usedUrlaubstageThisYear: usedUrlaubstageThisYear,
                remainingUrlaubstageYearEnd: remainingUrlaubstageYearEnd,
                usedUrlaubstageUpToMonatEnd: usedUrlaubstageUpToMonthEnd,
                remainingUrlaubstageAsOfMonatEnd: remainingUrlaubstageAsOfMonatEnd
            }
        });
    } catch (error) {
        console.error("Fehler beim Abrufen der Monatsberichte für Admin:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler: " + error.message });
    }
});

// Admin endpoint to create new work/absence entries
app.post("/api/admin/berichte", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") {
        return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    }
    try {
        const { benutzerId, datum, startzeit, endzeit, bericht, typ, beschreibung } = req.body;

        if (!benutzerId || !datum || !typ || isNaN(parseInt(benutzerId)) || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
            return res.status(400).json({ success: false, message: "Ungültige Basis-Eingabedaten (BenutzerID, Datum, Typ)." });
        }

        if (typ === 'Arbeit') {
            if (!startzeit || !endzeit || !bericht || !/^\d{2}:\d{2}$/.test(startzeit) || !/^\d{2}:\d{2}$/.test(endzeit)) {
                return res.status(400).json({ success: false, message: "Ungültige Eingabedaten für Typ 'Arbeit'." });
            }
            const startZeitFull = new Date(`${datum}T${startzeit}:00`);
            const endZeitFull = new Date(`${datum}T${endzeit}:00`);

            if (isNaN(startZeitFull.getTime()) || isNaN(endZeitFull.getTime())) {
                return res.status(400).json({ success: false, message: "Ungültige Datum/Zeit Kombination für 'Arbeit'." });
            }

            let durationInMilliseconds = endZeitFull.getTime() - startZeitFull.getTime();
            if (durationInMilliseconds < 0) {
                const [sH, sM] = startzeit.split(':').map(Number);
                const [eH, eM] = endzeit.split(':').map(Number);
                if (eH < sH || (eH === sH && eM < sM)) {
                    endZeitFull.setDate(endZeitFull.getDate() + 1);
                    durationInMilliseconds = endZeitFull.getTime() - startZeitFull.getTime();
                }
            }

            if (durationInMilliseconds < 0) {
                return res.status(400).json({ success: false, message: "Endzeit kann nicht vor Startzeit liegen (Fehler in Dauerberechnung)." });
            }
            await pool.execute(
                "INSERT INTO Arbeitszeiten (benutzerId, startZeit, endZeit, bericht) VALUES (?, ?, ?, ?)",
                [parseInt(benutzerId), startZeitFull, endZeitFull, bericht.trim()]
            );
            res.status(201).json({ success: true, message: "Arbeitseintrag erstellt." });

        } else if (typ === 'Krankheit' || typ === 'Urlaub') {
            const start_datum_abwesenheit = datum;
            const end_datum_abwesenheit = datum; // For single day entry from this modal
            const abwesenheit_typ = typ;
            const beschreibung_abwesenheit = beschreibung || null;

            await pool.execute(
                "INSERT INTO Abwesenheiten (benutzerId, start_datum, end_datum, abwesenheit_typ, beschreibung) VALUES (?, ?, ?, ?, ?)",
                [parseInt(benutzerId), start_datum_abwesenheit, end_datum_abwesenheit, abwesenheit_typ, beschreibung_abwesenheit]
            );
            res.status(201).json({ success: true, message: `${typ}-Eintrag erstellt.` });

        } else {
            return res.status(400).json({ success: false, message: "Unbekannter Eintragstyp." });
        }
    } catch (error) {
        console.error("Fehler in POST /api/admin/berichte:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler: " + error.message });
    }
});

// Admin endpoint to get details of a specific work entry for editing
app.get("/api/admin/berichte/details/:berichtId", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const berichtId = parseInt(req.params.berichtId);
    if (isNaN(berichtId)) return res.status(400).json({ success: false, message: "Ungültige Berichts-ID." });
    try {
        const [rows] = await pool.execute("SELECT a.id, a.bericht, a.startZeit, a.endZeit FROM Arbeitszeiten a WHERE a.id = ?", [berichtId]);
        if (rows.length === 0) return res.status(404).json({ success: false, message: "Bericht nicht gefunden." });
        
        const entry = rows[0];
        const start = new Date(entry.startZeit);
        
        // Handle active timers (NULL endZeit)
        let durationMs, formattedDauer, endTimeString;
        if (entry.endZeit === null) {
            // Active timer - calculate current duration
            const now = new Date();
            durationMs = now.getTime() - start.getTime();
            endTimeString = "Läuft noch";
        } else {
            // Completed timer
            const end = new Date(entry.endZeit);
            durationMs = end.getTime() - start.getTime();
            endTimeString = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        }
        
        const totalMinutes = Math.round(durationMs / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        formattedDauer = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        const data = {
            id: entry.id,
            bericht: entry.bericht,
            startzeit: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            endzeit: endTimeString,
            dauer: formattedDauer
        };

        res.json({ success: true, data: data });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

// Admin endpoint to update existing work entries
app.put("/api/admin/berichte/:id", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    try {
        const { bericht: newBerichtText, startzeit, endzeit } = req.body;
        if (!newBerichtText || newBerichtText.trim() === "" || !startzeit || !/^\d{2}:\d{2}$/.test(startzeit) || !endzeit || !/^\d{2}:\d{2}$/.test(endzeit))
            return res.status(400).json({ success: false, message: "Ungültige Eingabedaten." });
        const [berichtRows] = await pool.execute("SELECT startZeit FROM Arbeitszeiten WHERE id = ?", [req.params.id]);
        if (berichtRows.length === 0) return res.status(404).json({ success: false, message: "Bericht nicht gefunden." });
        
        const originalDateObject = new Date(berichtRows[0].startZeit); // This will be a Date object in server's local time (UTC+2)
        const year = originalDateObject.getFullYear();
        const month = (originalDateObject.getMonth() + 1).toString().padStart(2, '0'); // getMonth is 0-indexed
        const day = originalDateObject.getDate().toString().padStart(2, '0');
        const localDateString = `${year}-${month}-${day}`; // YYYY-MM-DD string of the original local date
        console.log(`[Admin Edit Time Debug] Original DB startZeit: ${berichtRows[0].startZeit}`);
        console.log(`[Admin Edit Time Debug] originalDateObject (from DB, should be local via pool TZ): ${originalDateObject.toString()}, UTC: ${originalDateObject.toISOString()}`);
        console.log(`[Admin Edit Time Debug] Extracted localDateString for date part: ${localDateString}`);
        console.log(`[Admin Edit Time Debug] Input startzeit (HH:MM): ${startzeit}, Input endzeit (HH:MM): ${endzeit}`);

        // Construct new Date objects by specifying the intended local timezone offset (+02:00) in the string.
        // This ensures the JS Date object correctly represents the wall-clock time in Europe/Vienna.
        const newStartSQLDateTime = new Date(`${localDateString}T${startzeit}:00+02:00`);
        let newEndSQLDateTime = new Date(`${localDateString}T${endzeit}:00+02:00`);
        console.log(`[Admin Edit Time Debug] newStartSQLDateTime (created with +02:00 offset): ${newStartSQLDateTime.toString()}, UTC: ${newStartSQLDateTime.toISOString()}`);
        console.log(`[Admin Edit Time Debug] newEndSQLDateTime (created with +02:00 offset): ${newEndSQLDateTime.toString()}, UTC: ${newEndSQLDateTime.toISOString()}`);

        let durationInMilliseconds = newEndSQLDateTime.getTime() - newStartSQLDateTime.getTime();

        // Handle potential overnight shift if end time is earlier than start time on the same calendar day input
        if (durationInMilliseconds < 0) {
            const [sH, sM] = startzeit.split(':').map(Number);
            const [eH, eM] = endzeit.split(':').map(Number);
            if (eH < sH || (eH === sH && eM < sM)) { // If HH:MM of end is before HH:MM of start
                newEndSQLDateTime.setDate(newEndSQLDateTime.getDate() + 1); // Advance end_datetime to the next day
                durationInMilliseconds = newEndSQLDateTime.getTime() - newStartSQLDateTime.getTime();
            } else {
                // If still negative, it's an invalid range not crossing midnight correctly
                return res.status(400).json({ success: false, message: "Endzeit kann nicht vor Startzeit liegen." });
            }
        }
        
        await pool.execute("UPDATE Arbeitszeiten SET bericht = ?, startZeit = ?, endZeit = ? WHERE id = ?", [newBerichtText.trim(), newStartSQLDateTime, newEndSQLDateTime, req.params.id]);
        res.json({ success: true, message: "Bericht aktualisiert." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

// Admin endpoint to delete work entries
app.delete("/api/admin/berichte/:berichtId", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert." });
    const berichtId = parseInt(req.params.berichtId);
    if (isNaN(berichtId)) return res.status(400).json({ success: false, message: "Ungültige Berichts-ID." });
    try {
        const [result] = await pool.execute("DELETE FROM Arbeitszeiten WHERE id = ?", [berichtId]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: "Bericht nicht gefunden." });
        res.json({ success: true, message: "Bericht gelöscht." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.get("/api/berichte", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Nicht eingeloggt" });
    try {
        // Fetch raw data, ordered by time to ensure correct consolidation.
        const [berichte] = await pool.execute(
            "SELECT id, startZeit, endZeit, bericht, DATE_FORMAT(startZeit, '%d.%m.%Y') as datum " +
            "FROM Arbeitszeiten WHERE benutzerId = ? ORDER BY startZeit ASC",
            [req.session.user.id]
        );

        const consolidated = {};

        berichte.forEach(entry => {
            const entryDate = entry.datum;
            const start = new Date(entry.startZeit);
            
            // Handle active timers (NULL endZeit)
            let durationMs, endTimeString;
            if (entry.endZeit === null) {
                // Active timer - calculate current duration
                const now = new Date();
                durationMs = now.getTime() - start.getTime();
                endTimeString = "Läuft noch";
            } else {
                // Completed timer
                const end = new Date(entry.endZeit);
                durationMs = end.getTime() - start.getTime();
                endTimeString = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            }

            if (!consolidated[entryDate]) {
                consolidated[entryDate] = {
                    id: entry.id,
                    datum: entryDate,
                    startzeit: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    endzeit: endTimeString,
                    durationMs: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben." 
                        ? `[${start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}-${endTimeString}] ${entry.bericht}` 
                        : "",
                    isAutoCutoff: isAutoCutoffEntry(entry),
                    segments: [{
                        id: entry.id, // Individual Arbeitszeiten record ID
                        start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                        end: endTimeString,
                        duration: durationMs > 0 ? durationMs : 0,
                        bericht: entry.bericht || ""
                    }]
                };
            } else {
                consolidated[entryDate].endzeit = endTimeString;
                consolidated[entryDate].durationMs += (durationMs > 0 ? durationMs : 0);
                // Mark as auto-cutoff if ANY segment was auto-cutoff
                consolidated[entryDate].isAutoCutoff = consolidated[entryDate].isAutoCutoff || isAutoCutoffEntry(entry);
                if (entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben.") {
                    const segmentTimeRange = `[${start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}-${endTimeString}]`;
                    const segmentText = `${segmentTimeRange} ${entry.bericht}`;
                    
                    if (consolidated[entryDate].bericht) {
                        consolidated[entryDate].bericht += `\n\n${segmentText}`;
                    } else {
                        consolidated[entryDate].bericht = segmentText;
                    }
                }
                consolidated[entryDate].segments.push({
                    id: entry.id, // Individual Arbeitszeiten record ID
                    start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    end: endTimeString,
                    duration: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht || "",
                    isAutoCutoff: isAutoCutoffEntry(entry)
                });
            }
        });

        const result = Object.values(consolidated).map(entry => {
            const totalHours = entry.durationMs / (1000 * 60 * 60);
            const hours = Math.floor(totalHours);
            const minutes = Math.round((totalHours - hours) * 60);
            entry.dauer = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            entry.segments.forEach(seg => {
                const segTotalHours = seg.duration / (1000 * 60 * 60);
                const segHours = Math.floor(segTotalHours);
                const segMinutes = Math.round((segTotalHours - segHours) * 60);
                seg.dauer = `${String(segHours).padStart(2, '0')}:${String(segMinutes).padStart(2, '0')}`;
                delete seg.duration;
            });
            delete entry.durationMs;
            return entry;
        }).sort((a, b) => {
            const [dayA, monthA, yearA] = a.datum.split('.');
            const [dayB, monthB, yearB] = b.datum.split('.');
            return new Date(`${yearB}-${monthB}-${dayB}`) - new Date(`${yearA}-${monthA}-${dayA}`);
        });

        res.json(result);
    } catch (error) {
        console.error("Fehler beim Abrufen der Berichte:", error);
        res.status(500).json({ success: false, message: "Fehler beim Abrufen der Berichte" });
    }
});

app.get("/api/berichte/monat/:monat", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ message: "Nicht eingeloggt" });
    try {
        const { monat } = req.params; const benutzerId = req.session.user.id;
        if (!/^\d{4}-\d{2}$/.test(monat)) return res.status(400).json({ message: "Ungültiges Monatsformat." });
        const [jahr, monatNummer] = monat.split('-'); const currentYear = parseInt(jahr); const currentMonth = parseInt(monatNummer);
        const monthStartDate = `${monat}-01 00:00:00`; const lastDayOfMonth = new Date(currentYear, currentMonth, 0).getDate(); const monthEndDate = `${monat}-${String(lastDayOfMonth).padStart(2, '0')} 23:59:59`;
        const [berichteArbeitszeiten] = await pool.execute("SELECT a.id, DATE_FORMAT(a.startZeit, '%d.%m.%Y') as datum, a.startZeit, a.endZeit, a.bericht FROM Arbeitszeiten a WHERE a.benutzerId = ? AND a.startZeit >= ? AND a.startZeit <= ? ORDER BY a.startZeit ASC", [benutzerId, monthStartDate, monthEndDate]);
        const [abwesenheitenDesMonats] = await pool.execute("SELECT id, DATE_FORMAT(start_datum, '%Y-%m-%d') as start_datum_iso, DATE_FORMAT(end_datum, '%Y-%m-%d') as end_datum_iso, abwesenheit_typ, beschreibung FROM Abwesenheiten WHERE benutzerId = ? AND end_datum >= ? AND start_datum <= ?", [benutzerId, `${monat}-01`, monthEndDate.substring(0,10)]);
        const [praktikantDetailsRows] = await pool.execute("SELECT email, vorname, nachname, bildungstraeger, praktikumszeit_1_von_bis, praktikumszeit_2_von_bis, allgemeine_notizen, total_urlaubstage_annually FROM Praktikanten WHERE id = ?", [benutzerId]);
        const praktikantDetails = praktikantDetailsRows[0] || {}; const total_urlaubstage_annually = praktikantDetails.total_urlaubstage_annually || 0;
        let calculatedTotalMonthlyHours = 0; const reportEntries = []; let monthlyUrlaubTage = 0; let monthlyKrankheitTage = 0;
        
        // Create consolidated entries with segments (similar to /api/berichte)
        const consolidated = {};
        berichteArbeitszeiten.forEach(entry => {
            const start = new Date(entry.startZeit);
            const entryDate = entry.datum;

            let durationMs, endTimeString;
            if (entry.endZeit === null) {
                const now = new Date();
                durationMs = now.getTime() - start.getTime();
                endTimeString = "Läuft noch";
            } else {
                const end = new Date(entry.endZeit);
                durationMs = end.getTime() - start.getTime();
                endTimeString = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            }

            const dauer = durationMs > 0 ? durationMs / (1000 * 60 * 60) : 0;
            calculatedTotalMonthlyHours += dauer;

            if (!consolidated[entryDate]) {
                consolidated[entryDate] = {
                    id: `arbeit-${entry.id}`,
                    datum: entryDate,
                    type: 'Arbeit',
                    startzeit: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    endzeit: endTimeString,
                    durationMs: durationMs > 0 ? durationMs : 0,
                    beschreibung: entry.bericht || "",
                    sortDate: new Date(parseInt(entryDate.substring(6, 10)), parseInt(entryDate.substring(3, 5)) - 1, parseInt(entryDate.substring(0, 2))),
                    segments: [{
                        id: entry.id, // Individual Arbeitszeiten record ID
                        start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                        end: endTimeString,
                        duration: durationMs > 0 ? durationMs : 0,
                        bericht: entry.bericht || ""
                    }]
                };
            } else {
                consolidated[entryDate].endzeit = endTimeString;
                consolidated[entryDate].durationMs += (durationMs > 0 ? durationMs : 0);
                if (entry.bericht && entry.bericht.trim() && entry.bericht.trim() !== "Kein Bericht angegeben.") {
                    if (consolidated[entryDate].beschreibung) {
                        consolidated[entryDate].beschreibung += `\n${entry.bericht}`;
                    } else {
                        consolidated[entryDate].beschreibung = entry.bericht;
                    }
                }
                consolidated[entryDate].segments.push({
                    id: entry.id, // Individual Arbeitszeiten record ID
                    start: start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                    end: endTimeString,
                    duration: durationMs > 0 ? durationMs : 0,
                    bericht: entry.bericht || "",
                    isAutoCutoff: isAutoCutoffEntry(entry)
                });
            }
        });

        // Convert consolidated entries to final format
        Object.values(consolidated).forEach(entry => {
            const totalHours = entry.durationMs / (1000 * 60 * 60);
            const hours = Math.floor(totalHours);
            const minutes = Math.round((totalHours - hours) * 60);
            entry.dauer = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
            
            // Format segment durations
            entry.segments.forEach(seg => {
                const segTotalHours = seg.duration / (1000 * 60 * 60);
                const segHours = Math.floor(segTotalHours);
                const segMinutes = Math.round((segTotalHours - segHours) * 60);
                seg.dauer = `${String(segHours).padStart(2, '0')}:${String(segMinutes).padStart(2, '0')}`;
                delete seg.duration;
            });
            
            delete entry.durationMs;
            reportEntries.push(entry);
        });
        const firstDayOfMonthUTC = new Date(Date.UTC(currentYear, currentMonth - 1, 1)); const actualLastDayNumberInMonth = new Date(currentYear, currentMonth, 0).getUTCDate(); const lastDayOfMonthUTC = new Date(Date.UTC(currentYear, currentMonth - 1, actualLastDayNumberInMonth, 23, 59, 59, 999));
        abwesenheitenDesMonats.forEach(abw => {
            const absenceStartUTC = new Date(Date.UTC(parseInt(abw.start_datum_iso.substring(0,4)), parseInt(abw.start_datum_iso.substring(5,7)) - 1, parseInt(abw.start_datum_iso.substring(8,10))));
            const absenceEndUTC = new Date(Date.UTC(parseInt(abw.end_datum_iso.substring(0,4)), parseInt(abw.end_datum_iso.substring(5,7)) - 1, parseInt(abw.end_datum_iso.substring(8,10))));
            let currentDayOfAbsence = new Date(absenceStartUTC);
            while (currentDayOfAbsence <= absenceEndUTC) {
                if (currentDayOfAbsence >= firstDayOfMonthUTC && currentDayOfAbsence <= lastDayOfMonthUTC) {
                    const dayOfWeek = currentDayOfAbsence.getUTCDay();
                    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                        const dayFormatted = `${String(currentDayOfAbsence.getUTCDate()).padStart(2, '0')}.${String(currentDayOfAbsence.getUTCMonth() + 1).padStart(2, '0')}.${currentDayOfAbsence.getUTCFullYear()}`;
                        let entryDauer = "Ganztägig";
                        if (abw.abwesenheit_typ === 'Urlaub') { calculatedTotalMonthlyHours += HOURS_PER_URLAUBSTAG_GLOBAL; monthlyUrlaubTage++; entryDauer = "08:00"; }
                        else if (abw.abwesenheit_typ === 'Krankheit') { monthlyKrankheitTage++; }
                        reportEntries.push({ id: `abwesenheit-${abw.id || 'new'}-${dayFormatted.replace(/\./g, '-')}`, datum: dayFormatted, type: abw.abwesenheit_typ, dauer: entryDauer, beschreibung: abw.beschreibung, startzeit: null, endzeit: null, sortDate: new Date(currentDayOfAbsence) });
                    }
                }
                currentDayOfAbsence.setUTCDate(currentDayOfAbsence.getUTCDate() + 1);
            }
        });
        reportEntries.sort((a, b) => a.sortDate - b.sortDate); reportEntries.forEach(entry => delete entry.sortDate);
        const [urlaubstageImJahrRows] = await pool.execute("SELECT start_datum, end_datum FROM Abwesenheiten WHERE benutzerId = ? AND abwesenheit_typ = 'Urlaub' AND start_datum <= ? AND end_datum >= ?", [benutzerId, `${currentYear}-12-31`, `${currentYear}-01-01`]);
        const urlaubDaysSet = new Set();
        urlaubstageImJahrRows.forEach(urlaub => {
            const startDateObj = new Date(urlaub.start_datum); const endDateObj = new Date(urlaub.end_datum);
            let currentUrlaubDay = new Date(Date.UTC(startDateObj.getUTCFullYear(), startDateObj.getUTCMonth(), startDateObj.getUTCDate()));
            const urlaubEndDay = new Date(Date.UTC(endDateObj.getUTCFullYear(), endDateObj.getUTCMonth(), endDateObj.getUTCDate()));
            while(currentUrlaubDay <= urlaubEndDay) { if (currentUrlaubDay.getUTCFullYear() === currentYear) { const dayOfWeek = currentUrlaubDay.getUTCDay(); if (dayOfWeek !== 0 && dayOfWeek !== 6) urlaubDaysSet.add(currentUrlaubDay.toISOString().split('T')[0]); } currentUrlaubDay.setUTCDate(currentUrlaubDay.getUTCDate() + 1); }
        });
        const usedUrlaubstageThisYear = urlaubDaysSet.size;
        const remainingUrlaubstage = total_urlaubstage_annually - usedUrlaubstageThisYear;
        res.json({ reportEntries, ...praktikantDetails, calculatedTotalMonthlyHours: parseFloat(calculatedTotalMonthlyHours.toFixed(2)), monthlyAbsenceCounts: { Urlaub: monthlyUrlaubTage, Krankheit: monthlyKrankheitTage }, internDetails: { total_urlaubstage_annually, usedUrlaubstageThisYear, remainingUrlaubstage } });
    } catch (error) { 
        console.error("Error in /api/berichte/monat/:monat:", error);
        res.status(500).json({ success: false, message: "Fehler beim Abrufen der Monatsberichte: " + error.message }); 
    }
});

app.get("/api/admin/dashboard/summary", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ message: "Zugriff verweigert" });
    try {
        const [totalUsersRows] = await pool.execute("SELECT COUNT(*) as totalUsers FROM Praktikanten");
        const [activeUsersRows] = await pool.execute("SELECT COUNT(DISTINCT benutzerId) as activeUsers FROM Arbeitszeiten WHERE startZeit >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)");
        const currentMonthDate = new Date(); const currentMonthYear = currentMonthDate.getFullYear(); const currentMonthNumber = currentMonthDate.getMonth() + 1;
        const currentMonthStartDate = `${currentMonthYear}-${String(currentMonthNumber).padStart(2, '0')}-01`; const currentMonthLastDay = new Date(currentMonthYear, currentMonthNumber, 0).getDate(); const currentMonthEndDate = `${currentMonthYear}-${String(currentMonthNumber).padStart(2, '0')}-${String(currentMonthLastDay).padStart(2, '0')}`;
        const [thisMonthWorkHoursRows] = await pool.execute("SELECT p.id, p.vorname, p.nachname, a.startZeit, a.endZeit FROM Praktikanten p LEFT JOIN Arbeitszeiten a ON p.id = a.benutzerId AND YEAR(a.startZeit) = ? AND MONTH(a.startZeit) = ? WHERE p.rolle = 'Praktikant' AND p.status = 'aktiv' ORDER BY p.vorname, p.nachname", [currentMonthYear, currentMonthNumber]);
        const thisMonthHours = {};
        thisMonthWorkHoursRows.forEach(row => {
            if (!thisMonthHours[row.id]) {
                thisMonthHours[row.id] = { id: row.id, vorname: row.vorname, nachname: row.nachname, totalWorkHours: 0 };
            }
            if (row.startZeit && row.endZeit) {
                thisMonthHours[row.id].totalWorkHours += (new Date(row.endZeit).getTime() - new Date(row.startZeit).getTime());
            } else if (row.startZeit && row.endZeit === null) {
                // Active timer - calculate current duration
                const now = new Date();
                thisMonthHours[row.id].totalWorkHours += (now.getTime() - new Date(row.startZeit).getTime());
            }
        });

        const hoursPerInternThisMonth = [];
        for (const id in thisMonthHours) {
            const row = thisMonthHours[id];
            const vacationHours = await getVacationHoursForPeriodHelper(row.id, currentMonthStartDate, currentMonthEndDate, pool);
            const totalHours = (row.totalWorkHours / (1000 * 60 * 60)) + vacationHours;
            hoursPerInternThisMonth.push({ ...row, totalHours: totalHours.toFixed(2) });
        }

        const lastMonthDate = new Date(); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1); const lastMonthYear = lastMonthDate.getFullYear(); const lastMonthNumber = lastMonthDate.getMonth() + 1;
        const lastMonthStartDate = `${lastMonthYear}-${String(lastMonthNumber).padStart(2, '0')}-01`; const lastMonthLastDay = new Date(lastMonthYear, lastMonthNumber, 0).getDate(); const lastMonthEndDate = `${lastMonthYear}-${String(lastMonthNumber).padStart(2, '0')}-${String(lastMonthLastDay).padStart(2, '0')}`;
        const [lastMonthWorkHoursRows] = await pool.execute("SELECT p.id, p.vorname, p.nachname, a.startZeit, a.endZeit FROM Praktikanten p LEFT JOIN Arbeitszeiten a ON p.id = a.benutzerId AND YEAR(a.startZeit) = ? AND MONTH(a.startZeit) = ? WHERE p.rolle = 'Praktikant' AND p.status = 'aktiv' ORDER BY p.vorname, p.nachname", [lastMonthYear, lastMonthNumber]);
        
        const lastMonthHours = {};
        lastMonthWorkHoursRows.forEach(row => {
            if (!lastMonthHours[row.id]) {
                lastMonthHours[row.id] = { id: row.id, vorname: row.vorname, nachname: row.nachname, totalWorkHours: 0 };
            }
            if (row.startZeit && row.endZeit) {
                lastMonthHours[row.id].totalWorkHours += (new Date(row.endZeit).getTime() - new Date(row.startZeit).getTime());
            } else if (row.startZeit && row.endZeit === null) {
                // Active timer - calculate current duration
                const now = new Date();
                lastMonthHours[row.id].totalWorkHours += (now.getTime() - new Date(row.startZeit).getTime());
            }
        });

        const hoursPerInternLastMonth = [];
        for (const id in lastMonthHours) {
            const row = lastMonthHours[id];
            const vacationHours = await getVacationHoursForPeriodHelper(row.id, lastMonthStartDate, lastMonthEndDate, pool);
            const totalHours = (row.totalWorkHours / (1000 * 60 * 60)) + vacationHours;
            hoursPerInternLastMonth.push({ ...row, totalHours: totalHours.toFixed(2) });
        }
        res.json({ success: true, data: { totalRegisteredUsers: totalUsersRows[0].totalUsers, usersWithRecentActivity: activeUsersRows[0].activeUsers, hoursPerInternThisMonth, hoursPerInternLastMonth } });
    } catch (error) { res.status(500).json({ success: false, message: "Fehler: " + error.message }); }
});

app.put("/api/berichte/:berichtId", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt." });
    try {
        const { bericht: newBerichtText } = req.body; const benutzerId = req.session.user.id;
        if (!newBerichtText || newBerichtText.trim() === "") return res.status(400).json({ success: false, message: "Berichtstext darf nicht leer sein." });
        if (isNaN(parseInt(req.params.berichtId))) return res.status(400).json({ success: false, message: "Ungültige Berichts-ID." });
        const [berichtRows] = await pool.execute("SELECT benutzerId, endZeit, bericht FROM Arbeitszeiten WHERE id = ?", [req.params.berichtId]);
        if (berichtRows.length === 0) return res.status(404).json({ success: false, message: "Bericht nicht gefunden." });
        if (berichtRows[0].benutzerId !== benutzerId) return res.status(403).json({ success: false, message: "Zugriff verweigert." });
        
        // Check if this is an auto cut-off entry that users should not be able to edit
        const entry = berichtRows[0];
        if (isAutoCutoffEntry(entry)) {
            return res.status(403).json({ success: false, message: "Auto cut-off Einträge können nicht bearbeitet werden. Diese Einträge sind systemgeneriert und dienen der Nachvollziehbarkeit." });
        }
        
        await pool.execute("UPDATE Arbeitszeiten SET bericht = ? WHERE id = ? AND benutzerId = ?", [newBerichtText.trim(), req.params.berichtId, benutzerId]);
        res.json({ success: true, message: "Bericht erfolgreich aktualisiert." });
    } catch (error) { res.status(500).json({ success: false, message: "Interner Serverfehler." }); }
});

app.put("/api/berichte/tag/:datum", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Nicht eingeloggt." });
    try {
        const { bericht: newBerichtText } = req.body;
        const { datum } = req.params;
        const benutzerId = req.session.user.id;

        if (!newBerichtText || newBerichtText.trim() === "" || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) {
            return res.status(400).json({ success: false, message: "Datum und Berichtstext sind erforderlich." });
        }

        // Find all entries for the user on that day
        const [entries] = await pool.execute(
            "SELECT id FROM Arbeitszeiten WHERE benutzerId = ? AND DATE(startZeit) = ?",
            [benutzerId, datum]
        );

        if (entries.length === 0) {
            return res.status(404).json({ success: false, message: "Keine Berichte für dieses Datum gefunden." });
        }

        // Update the bericht for all entries of that day
        const entryIds = entries.map(e => e.id);
        if (entryIds.length > 0) {
            const placeholders = entryIds.map(() => '?').join(',');
            await pool.query(
                `UPDATE Arbeitszeiten SET bericht = ? WHERE id IN (${placeholders})`,
                [newBerichtText.trim(), ...entryIds]
            );
        }

        res.json({ success: true, message: "Tagesbericht erfolgreich aktualisiert." });
    } catch (error) {
        console.error("Fehler beim Aktualisieren des Tagesberichts:", error);
        res.status(500).json({ success: false, message: "Interner Serverfehler." });
    }
});

app.get("/api/admin/dashboard/hours-summary", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert" });
    try {
        const { month, praktikantId } = req.query;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: "Ungültiges Monatsformat." });
        const [yearStr, monthStr] = month.split('-'); const year = parseInt(yearStr); const monthNumber = parseInt(monthStr);
        const monthStartDate = `${year}-${monthStr}-01`; const lastDayOfMonth = new Date(year, monthNumber, 0).getDate(); const monthEndDate = `${year}-${monthStr}-${String(lastDayOfMonth).padStart(2, '0')}`;
        let praktikantenToQuery = [];
        if (praktikantId) {
            const parsedPraktikantId = parseInt(praktikantId);
            if (isNaN(parsedPraktikantId)) return res.status(400).json({ success: false, message: "Ungültige Praktikant-ID." });
            const [internRows] = await pool.execute("SELECT id, vorname, nachname FROM Praktikanten WHERE id = ? AND rolle = 'Praktikant' AND status = 'aktiv'", [parsedPraktikantId]);
            if (internRows.length > 0) praktikantenToQuery = internRows;
        } else {
            const [allInternsRows] = await pool.execute("SELECT id, vorname, nachname FROM Praktikanten WHERE rolle = 'Praktikant' AND status = 'aktiv' ORDER BY vorname, nachname");
            praktikantenToQuery = allInternsRows;
        }
        const results = [];
        for (const intern of praktikantenToQuery) {
            const [workHoursRows] = await pool.execute("SELECT startZeit, endZeit FROM Arbeitszeiten WHERE benutzerId = ? AND YEAR(startZeit) = ? AND MONTH(startZeit) = ?", [intern.id, year, monthNumber]);
            let loggedWorkMs = 0;
            workHoursRows.forEach(row => {
                if (row.endZeit !== null) {
                    // Completed timer
                    loggedWorkMs += new Date(row.endZeit).getTime() - new Date(row.startZeit).getTime();
                } else {
                    // Active timer - calculate current duration
                    const now = new Date();
                    loggedWorkMs += now.getTime() - new Date(row.startZeit).getTime();
                }
            });
            const loggedWorkHours = loggedWorkMs / (1000 * 60 * 60);
            const vacationHoursInMonth = await getVacationHoursForPeriodHelper(intern.id, monthStartDate, monthEndDate, pool);
            results.push({ id: intern.id, vorname: intern.vorname, nachname: intern.nachname, totalHours: (loggedWorkHours + vacationHoursInMonth).toFixed(2) });
        }
        results.sort((a, b) => parseFloat(b.totalHours) - parseFloat(a.totalHours));
        res.json({ success: true, data: results });
    } catch (error) { res.status(500).json({ success: false, message: "Fehler: " + error.message }); }
});

app.get("/api/admin/dashboard/intern-hours", async (req, res) => {
    if (!req.session.user || req.session.user.rolle !== "Betreuer") return res.status(403).json({ success: false, message: "Zugriff verweigert" });
    try {
        const { month } = req.query;
        if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ success: false, message: "Ungültiges Monatsformat." });
        const [yearStr, monthStr] = month.split('-'); const year = parseInt(yearStr); const monthNumber = parseInt(monthStr);
        const monthStartDate = `${year}-${monthStr}-01`; const lastDayOfMonth = new Date(year, monthNumber, 0).getDate(); const monthEndDate = `${year}-${monthStr}-${String(lastDayOfMonth).padStart(2, '0')}`;
        const [internRows] = await pool.execute("SELECT id, vorname, nachname FROM Praktikanten WHERE rolle = 'Praktikant' AND status = 'aktiv' ORDER BY vorname, nachname ASC");
        const results = [];
        for (const intern of internRows) {
            const [workHoursRows] = await pool.execute("SELECT startZeit, endZeit FROM Arbeitszeiten WHERE benutzerId = ? AND YEAR(startZeit) = ? AND MONTH(startZeit) = ?", [intern.id, year, monthNumber]);
            let totalWorkMs = 0;
            workHoursRows.forEach(row => {
                if (row.endZeit !== null) {
                    // Completed timer
                    totalWorkMs += new Date(row.endZeit).getTime() - new Date(row.startZeit).getTime();
                } else {
                    // Active timer - calculate current duration
                    const now = new Date();
                    totalWorkMs += now.getTime() - new Date(row.startZeit).getTime();
                }
            });
            const totalWorkHours = totalWorkMs / (1000 * 60 * 60);
            const totalVacationHours = await getVacationHoursForPeriodHelper(intern.id, monthStartDate, monthEndDate, pool);
            results.push({ id: intern.id, vorname: intern.vorname, nachname: intern.nachname, totalHours: (totalWorkHours + totalVacationHours).toFixed(2) });
        }
        res.json({ success: true, data: results });
    } catch (error) { res.status(500).json({ success: false, message: "Fehler: " + error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
    console.log(`Frontend läuft auf http://localhost:${PORT}/`);
});
