export function withCORS(res) {
  const allowList = (process.env.CORS_ALLOW_ORIGINS || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const originHeader = allowList.includes("*") ? "*" : allowList[0] || "*";
  res.setHeader("Access-Control-Allow-Origin", originHeader);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function preflight(req, res) {
  if (req.method === "OPTIONS") {
    withCORS(res);
    res.status(200).end();
    return true;
  }
  return false;
}
