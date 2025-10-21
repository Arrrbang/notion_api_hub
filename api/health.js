import { withCORS, preflight } from "../lib/cors.js";

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  withCORS(res);
  const cacheTtl = Number(process.env.CACHE_TTL_SECONDS || 600);

  res.setHeader("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=86400`);
  res.status(200).json({
    ok: true,
    name: "NOTION API HUB",
    time: new Date().toISOString()
  });
}
