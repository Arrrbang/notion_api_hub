// api/index.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// ----- 기본 설정
const app = express();
app.use(cors());
app.use(express.json());

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN; // 둘 중 하나 사용
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 600);

// ---- 설정 파일 로더
function loadJson(rel) {
  const full = path.join(process.cwd(), rel);
  return JSON.parse(fs.readFileSync(full, "utf8"));
}
const ALLOWED = loadJson("config/allowed-types.json"); // ["20FT","40HC","MIN CBM","PER CBM","FIXED"]
const DBMAP = loadJson("config/db-map.json");          // { "TEST국가": "데이터베이스ID" }

// ---- 공통 헤더
function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// ---- 유틸
function pickNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}
function extractTitle(properties) {
  const entry = Object.entries(properties).find(([, val]) => val?.type === "title");
  if (!entry) return null;
  const v = entry[1];
  const text = (v.title || []).map(t => t.plain_text || "").join("").trim();
  return text || null;
}
function valueFromColumn(properties, columnName) {
  const col = properties[columnName];
  if (!col) return null;
  switch (col.type) {
    case "number":
      return pickNumber(col.number);
    case "rich_text":
      return pickNumber((col.rich_text || []).map(t => t.plain_text || "").join("").trim());
    case "formula":
      return pickNumber(col.formula?.[col.formula?.type] ?? null);
    default:
      return null;
  }
}

// ---- Caching 헤더
function setCache(res) {
  res.setHeader("Cache-Control", `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
}

// ===================== Routes =====================

// health
app.get(["/", "/api/health"], (req, res) => {
  setCache(res);
  res.json({ ok: true, name: "NOTION API HUB", time: new Date().toISOString() });
});

// list-columns: ?country=TEST국가
app.get("/api/notion/list-columns", async (req, res) => {
  try {
    const country = req.query.country;
    const dbid = DBMAP[country];
    if (!dbid) return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });

    const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, {
      headers: notionHeaders()
    });

    const columns = Object.keys(meta.data.properties || {});
    setCache(res);
    res.json({ ok: true, country, columns });
  } catch (e) {
    const details = e.response?.data || e.message;
    res.status(500).json({ ok: false, error: "list-columns failed", details });
  }
});

// costs: /api/costs/:country?type=20FT
app.get("/api/costs/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const typeParam = (req.query.type || "").trim();
    const type = typeParam || ALLOWED[0];

    if (!ALLOWED.includes(type)) {
      return res.status(400).json({ ok: false, error: `Invalid type. Use one of: ${ALLOWED.join(", ")}` });
    }

    const dbid = DBMAP[country];
    if (!dbid) return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });

    // DB query
    const q = await axios.post(
      `https://api.notion.com/v1/databases/${dbid}/query`,
      { page_size: 100 },
      { headers: notionHeaders() }
    );

    const results = q.data.results || [];
    const values = {};
    const rows = [];

    for (const page of results) {
      const props = page.properties || {};
      const itemName = extractTitle(props);
      if (!itemName) continue;

      const rowObj = { item: itemName };
      for (const key of ALLOWED) rowObj[key] = pickNumber(valueFromColumn(props, key));
      rows.push(rowObj);

      values[itemName] = pickNumber(valueFromColumn(props, type));
    }

    setCache(res);
    res.json({
      ok: true,
      country,
      type,
      values,   // { "CDS": 값, "SHC": 값, "DRC": 값, ... }
      rows,     // 전체 스냅샷
      servedAt: new Date().toISOString()
    });
  } catch (e) {
    const details = e.response?.data || e.message;
    res.status(500).json({ ok: false, error: "costs failed", details });
  }
});

// ---- Vercel 서버리스 핸들러로 export
module.exports = app;
