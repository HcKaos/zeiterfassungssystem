const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
require("dotenv").config(); // Load environment variables

const dbName = process.env.DB_NAME; // Use DB_NAME from env

async function setupProductionDatabase() {
    let connection;
    try {
        // Connect to the MySQL server (without specifying a database initially)
        connection = await mysql.createConnection({
            host: process.env.DB_HOST || "localhost",
            user: process.env.DB_USER || "root",
            password: process.env.DB_PASSWORD || ""
        });

        console.log("Connected to MySQL server.");

        // Create the database if it doesn't exist
        await connection.query(`CREATE DATABASE IF NOT EXISTS ${dbName}`);
        console.log(`Database "${dbName}" ensured/created.`);

        // Use the database
        await connection.query(`USE ${dbName}`);
        console.log(`Using database: ${dbName}`);

        // Create Praktikanten table
        const createPraktikanten = `
            CREATE TABLE IF NOT EXISTS Praktikanten (
                id INT AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                vorname VARCHAR(50),
                nachname VARCHAR(50),
                rolle ENUM("Praktikant", "Betreuer") NOT NULL,
                status ENUM('aktiv', 'inaktiv') NOT NULL DEFAULT 'aktiv',
                betreuerId INT,
                adresse TEXT,
                telefonnummer VARCHAR(255),
                bildungstraeger TEXT,
                praktikumszeit_1_von_bis TEXT,
                praktikumszeit_2_von_bis TEXT,
                allgemeine_notizen TEXT,
                total_urlaubstage_annually INT DEFAULT 10,
                FOREIGN KEY (betreuerId) REFERENCES Praktikanten(id) ON DELETE SET NULL
            )
        `;
        await connection.query(createPraktikanten);
        console.log(`Table "Praktikanten" ensured/created.`);

        // SQL to add new columns to the Praktikanten table (run after creation)
        const alterPraktikantenTable = [
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE NOT NULL FIRST",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS vorname VARCHAR(50) AFTER email",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS nachname VARCHAR(50) AFTER vorname",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS adresse TEXT AFTER status",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS telefonnummer VARCHAR(255) AFTER adresse",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS bildungstraeger TEXT AFTER telefonnummer",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS praktikumszeit_1_von_bis TEXT AFTER bildungstraeger",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS praktikumszeit_2_von_bis TEXT AFTER praktikumszeit_1_von_bis",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS allgemeine_notizen TEXT AFTER praktikumszeit_2_von_bis",
            "ALTER TABLE Praktikanten ADD COLUMN IF NOT EXISTS total_urlaubstage_annually INT DEFAULT 10 AFTER allgemeine_notizen"
        ];

        // Execute ALTER TABLE statements sequentially
        for (const sql of alterPraktikantenTable) {
            try {
                await connection.query(sql);
                console.log(`SQL successfully executed: ${sql.substring(0, 50)}...`);
            } catch (err) {
                 // Ignore "Duplicate column name" errors if IF NOT EXISTS is not fully supported or table structure is complex
                if (err.code !== 'ER_DUP_FIELDNAME') {
                     console.warn(`Warning executing "${sql}": ${err.message}. This might be okay if the column already exists.`);
                } else {
                    console.log(`Column already exists, skipping ALTER: ${sql.substring(0, 50)}...`);
                }
            }
        }
        console.log("All ALTER TABLE statements for Praktikanten attempted.");


        // Create Arbeitszeiten table
        const createArbeitszeiten = `
            CREATE TABLE IF NOT EXISTS Arbeitszeiten (
                id INT AUTO_INCREMENT PRIMARY KEY,
                benutzerId INT NOT NULL,
                startZeit DATETIME NOT NULL,
                endZeit DATETIME,
                bericht TEXT,
                FOREIGN KEY (benutzerId) REFERENCES Praktikanten(id) ON DELETE CASCADE
            )
        `;
        await connection.query(createArbeitszeiten);
        console.log(`Table "Arbeitszeiten" ensured/created.`);

        // Create Abwesenheiten table
        const createAbwesenheiten = `
            CREATE TABLE IF NOT EXISTS Abwesenheiten (
                id INT PRIMARY KEY AUTO_INCREMENT,
                benutzerId INT NOT NULL,
                start_datum DATE NOT NULL,
                end_datum DATE NOT NULL,
                abwesenheit_typ ENUM('Krankheit', 'Urlaub') NOT NULL,
                beschreibung TEXT,
                FOREIGN KEY (benutzerId) REFERENCES Praktikanten(id) ON DELETE CASCADE
            )
        `;
        await connection.query(createAbwesenheiten);
        console.log(`Table "Abwesenheiten" ensured/created.`);

        // Check if admin user already exists
        const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
        const [existingUsers] = await connection.execute("SELECT id FROM Praktikanten WHERE email = ?", [adminEmail]);

        if (existingUsers.length === 0) {
            console.log(`Admin user with email "${adminEmail}" not found. Creating admin user...`);

            // Hash the admin password
            const adminPasswordPlain = process.env.ADMIN_PASSWORD || "changeMe123"; // Default password - CHANGE THIS!
            const adminPasswordHash = await bcrypt.hash(adminPasswordPlain, 10);
            console.log(`Generated hash for admin password: ${adminPasswordHash}`); // Log hash for reference

            // Insert the admin user
            const adminVorname = process.env.ADMIN_FIRSTNAME || "Admin";
            const adminNachname = process.env.ADMIN_LASTNAME || "User";
            const adminRolle = "Betreuer";
            const adminStatus = "aktiv";
            const adminUrlaubstage = 10; // Default from testdaten3.js

            await connection.execute(
                `INSERT INTO Praktikanten (email, password, vorname, nachname, rolle, status, total_urlaubstage_annually) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [adminEmail, adminPasswordHash, adminVorname, adminNachname, adminRolle, adminStatus, adminUrlaubstage]
            );

            console.log(`Admin user "${adminEmail}" created successfully.`);
            console.log(`Login Email: ${adminEmail}`);
            console.log(`Standard Password: ${adminPasswordPlain}`); // Note: This is the plain text password used for hashing
        } else {
            console.log(`Admin user with email "${adminEmail}" already exists. Skipping creation.`);
        }

        console.log("Database setup and admin user creation script finished.");

    } catch (error) {
        console.error("Error during database setup:", error);
        throw error; // Re-throw to indicate failure
    } finally {
        if (connection) {
            await connection.end();
            console.log("Database connection closed.");
        }
    }
}

setupProductionDatabase()
    .then(() => {
        console.log("Script execution successful.");
        process.exit(0);
    })
    .catch(err => {
        console.error("Script execution failed:", err);
        process.exit(1);
    });