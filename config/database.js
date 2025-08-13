const mysql = require("mysql2/promise");
require("dotenv").config();

// Datenbank Konfiguration
const dbConfig = {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "Zeiterfassung"
};

// Erstelle einen Pool für Datenbankverbindungen
const pool = mysql.createPool(dbConfig);

// Teste die Datenbankverbindung
async function testConnection() {
    try {
        const connection = await pool.getConnection();
        console.log("Datenbankverbindung erfolgreich hergestellt");
        connection.release();
        return true;
    } catch (error) {
        console.error("Fehler bei der Datenbankverbindung:", error);
        return false;
    }
}

module.exports = {
    pool,
    testConnection
}; 