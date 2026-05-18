// /api/standings — aggregated standings for a season.
// Combines DB-stored picks (live, 2026+) with imported historical seasons.json
// so the frontend can keep using one API for everything.

import fs from "node:fs";
import path from "node:path";
import { sql } from "../lib/db.js";

let _historyCache = null;
function loadHistory() {
  if (_historyCache) return _historyCache;
  try {
    const p = path.join(process.cwd(), "data", "seasons.json");
    _historyCache = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    _historyCache = { seasons: {}, members: {}, rules: [] };
  }
  return _historyCache;
}

export default async function handler(req, res) {
  const season = Number(req.query.season);
  if (!season) return res.status(400).json({ error: "season-required" });

  // Historical seasons live in the static JSON
  const hist = loadHistory();
  if (hist.seasons[String(season)]) {
    return res.status(200).json({ source: "history", ...hist.seasons[String(season)], members: hist.members });
  }

  // Live season — query DB
  try {
    const picks = await sql()`
      SELECT p.season, p.week, p.bet_type, p.pick_text, p.result, m.name AS member_name
      FROM picks p JOIN members m ON m.id = p.member_id
      WHERE p.season = ${season}
      ORDER BY p.week, m.name, p.bet_type`;
    return res.status(200).json({ source: "db", season, picks });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
