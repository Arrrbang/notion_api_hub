// api/index.js
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const EXTRA_TEXT_PROP = process.env.EXTRA_TEXT_PROP || "추가내용";

const app = express();
app.use(cors());
app.use(express.json());

// ───────────────────────────────────────────────────────────
// ENV
// ───────────────────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 600);

// ───────────────────────────────────────────────────────────
// Utils: 안전한 JSON 로더(지연 로드)
// ───────────────────────────────────────────────────────────
function safeLoadJson(relPathFromRoot) {
  try {
    const full = path.join(process.cwd(), relPathFromRoot);
    const raw = fs.readFileSync(full, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return { __error: e.message, __path: relPathFromRoot };
  }
}

function getAllowed() {
  const j = safeLoadJson("config/allowed-types.json");
  if (j.__error) throw new Error(`allowed-types.json load failed (${j.__path}): ${j.__error}`);
  return j;
}

function getDbMap() {
  const j = safeLoadJson("config/db-map.json");
  if (j.__error) throw new Error(`db-map.json load failed (${j.__path}): ${j.__error}`);
  return j;
}

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

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

function setCache(res) {
  res.setHeader("Cache-Control", `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
}

// ───────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────

// Health (루트와 health 둘 다 응답)
app.get(["/", "/api/health"], (req, res) => {
  setCache(res);
  res.json({ ok: true, name: "NOTION API HUB", time: new Date().toISOString() });
});

// 디버그: 현재 로딩된 설정/환경 점검
app.get("/api/debug/config", (req, res) => {
  try {
    const allowed = getAllowed();
    const dbmap = getDbMap();
    const sampleId = dbmap["TEST국가"] || null;
    res.json({
      ok: true,
      env: { NOTION_TOKEN_PRESENT: Boolean(NOTION_TOKEN) },
      allowedTypes: allowed,
      dbMapKeys: Object.keys(dbmap),
      sampleDbId: sampleId
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 노션: 컬럼(속성) 목록 조회
// GET /api/notion/list-columns?country=TEST국가
app.get("/api/notion/list-columns", async (req, res) => {
  try {
    const country = req.query.country;
    if (!country) return res.status(400).json({ ok: false, error: "country query is required" });

    const dbmap = getDbMap();
    const dbid = dbmap[country];
    if (!dbid) return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });

    const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, {
      headers: notionHeaders()
    });

    const columns = Object.keys(meta.data.properties || {});
    setCache(res);
    res.json({ ok: true, country, columns });
  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok: false, error: "list-columns failed", details });
  }
});

// 비용 조회 (Select 필터 지원)
// GET /api/costs/:country?type=20FT&pick=A지역
app.get("/api/costs/:country", async (req, res) => {
app.get("/api/costs/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const allowed = getAllowed();

    const typeParam = (req.query.type || "").trim();
    const type = typeParam || allowed[0];
    if (!allowed.includes(type)) {
      return res
        .status(400)
        .json({ ok: false, error: `Invalid type. Use one of: ${allowed.join(", ")}` });
    }

    // A지역 / B지역 등 선택 속성으로 필터
    const pick = (req.query.pick || req.query.select || "").trim();

    const dbmap = getDbMap();
    const dbid = dbmap[country];
    if (!dbid) {
      return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });
    }

    // Notion query body 구성
    const body = { page_size: 100 };
    if (pick) {
      body.filter = {
        property: "선택",          // ← 노션 Select 속성명이 "선택"이어야 함
        select: { equals: pick }
      };
    }

    const q = await axios.post(
      `https://api.notion.com/v1/databases/${dbid}/query`,
      body,
      { headers: notionHeaders() }
    );

    const results = q.data.results || [];

    const rows = [];
    const values = {};               // (pick 있을 때) { 항목: 숫자 }
    const extras = {};               // (pick 있을 때) { 항목: "추가내용" }

    const valuesBySelect = {};       // (pick 없을 때) { 지역: { 항목: 숫자 } }
    const extrasBySelect = {};       // (pick 없을 때) { 지역: { 항목: "추가내용" } }

    // select 값 읽기 유틸
    const getSelect = (props) => {
      const s = props?.["선택"];
      return (s && s.type === "select" && s.select && s.select.name) ? s.select.name : null;
    };

    for (const page of results) {
      const props = page.properties || {};
      const itemName = extractTitle(props); // "이름" title
      if (!itemName) continue;

      const selectName = getSelect(props);  // A지역 / B지역 …
      const extraText = valueFromColumn(props, EXTRA_TEXT_PROP); // "추가내용"

      // 전체 스냅샷 행
      const rowObj = { item: itemName, select: selectName, extra: extraText };
      for (const key of allowed) {
        rowObj[key] = pickNumber(valueFromColumn(props, key));
      }
      rows.push(rowObj);

      // 타입별 값
      const val = pickNumber(valueFromColumn(props, type));

      if (pick) {
        // 평면 구조
        values[itemName] = val;
        extras[itemName] = extraText ?? null;
      } else {
        // 지역별 그룹 구조
        if (!valuesBySelect[selectName]) valuesBySelect[selectName] = {};
        if (!extrasBySelect[selectName]) extrasBySelect[selectName] = {};
        valuesBySelect[selectName][itemName] = val;
        extrasBySelect[selectName][itemName] = extraText ?? null;
      }
    }

    setCache(res);
    res.json({
      ok: true,
      country,
      type,
      ...(pick
        ? { pick, values, extras }                         // ← A지역만 요청했을 때
        : { valuesBySelect, extrasBySelect }               // ← 전체(지역별 그룹)
      ),
      rows,
      servedAt: new Date().toISOString()
    });
  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok: false, error: "costs failed", details });
  }
});

// GET /api/notion/list-selects?country=TEST국가
app.get("/api/notion/list-selects", async (req, res) => {
  try {
    const country = req.query.country;
    if (!country) return res.status(400).json({ ok: false, error: "country query is required" });

    const dbmap = getDbMap();
    const dbid = dbmap[country];
    if (!dbid) return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });

    const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, {
      headers: notionHeaders()
    });

    const prop = meta.data.properties?.["지역"];
    const options = (prop?.select?.options || []).map(o => o.name);
    res.json({ ok: true, country, property: "지역", options });
  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok: false, error: "list-selects failed", details });
  }
});

// ───────────────────────────────────────────────────────────
// Export (Vercel @vercel/node용)
// ───────────────────────────────────────────────────────────
module.exports = app;
