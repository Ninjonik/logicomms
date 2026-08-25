import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.mjs";

const schemaPath = path.resolve(import.meta.dirname, "..", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.exec(schema);

const statements = {
  createSession: db.prepare(
    "INSERT INTO sessions (id, code, participant_count) VALUES (@id, @code, @participant_count)"
  ),
  decrementParticipantCount: db.prepare(
    "UPDATE sessions SET participant_count = MAX(participant_count - 1, 0) WHERE code = ?"
  ),
  deleteSessionByCode: db.prepare("DELETE FROM sessions WHERE code = ?"),
  deleteSessionById: db.prepare("DELETE FROM sessions WHERE id = ?"),
  getSessionByCode: db.prepare("SELECT * FROM sessions WHERE code = ?"),
  getSessionById: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  getUsedCodes: db.prepare("SELECT code FROM sessions"),
  incrementParticipantCount: db.prepare(
    "UPDATE sessions SET participant_count = participant_count + 1 WHERE code = ?"
  ),
  setParticipantCount: db.prepare(
    "UPDATE sessions SET participant_count = ? WHERE code = ?"
  ),
};

export function listUsedCodes() {
  return new Set(statements.getUsedCodes.all().map((row) => row.code));
}

export function createSession(session) {
  statements.createSession.run(session);
  return session;
}

export function getSessionByCode(code) {
  return statements.getSessionByCode.get(code);
}

export function getSessionById(id) {
  return statements.getSessionById.get(id);
}

export function setParticipantCount(code, count) {
  statements.setParticipantCount.run(count, code);
}

export function incrementParticipantCount(code) {
  statements.incrementParticipantCount.run(code);
}

export function decrementParticipantCount(code) {
  statements.decrementParticipantCount.run(code);
}

export function deleteSessionByCode(code) {
  statements.deleteSessionByCode.run(code);
}

export function deleteSessionById(id) {
  statements.deleteSessionById.run(id);
}
