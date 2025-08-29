// db.js
const Database = require('better-sqlite3');
const db = new Database('bot.db');

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    first_seen_at TEXT DEFAULT (datetime('now')),
    blocked INTEGER DEFAULT 0
  );
`);

module.exports = {
  addUser(userId) {
    db.prepare(`INSERT OR IGNORE INTO users (user_id) VALUES (?)`).run(userId);
  },
  listActiveUsers() {
    return db.prepare(`SELECT user_id FROM users WHERE blocked = 0`).all();
  },
  markBlocked(userId) {
    db.prepare(`UPDATE users SET blocked = 1 WHERE user_id = ?`).run(userId);
  }
};
