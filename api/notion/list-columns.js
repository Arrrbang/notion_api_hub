import dbMap from "../../config/db-map.json" assert { type: "json" };
import { withCORS, preflight } from "../../lib/cors.js";
import { notion } from "../../lib/notion.js";

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  const { country } = req.query;
  const dbid = dbMap[country];
  if (!dbid) {
    res.status(404).json({ ok: false, error: `Unknown country: ${country}` });
    return;
  }

  try {
    const meta = await notion.databases.retrieve({ database_id: dbid });
    const columns = Object.keys(meta.properties || {});
    withCORS(res);
    res.status(200).json({ ok: true, country, columns });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
