// api/index.js
// CommonJS + Express + @vercel/node (vercel.json routes/builds 기준)

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ───────────────────────────────────────────────────────────
// ENV / 상수
// ───────────────────────────────────────────────────────────
const NOTION_TOKEN      = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 600);

// 노션 속성명(필요시 Vercel 환경변수로 변경 가능)
const TITLE_PROP        = process.env.TITLE_PROP        || "이름";     // title
const REGION_PROP       = process.env.REGION_PROP       || "지역";     // select
const DIPLO_PROP        = process.env.DIPLO_PROP        || "외교유무"; // multi_select
const EXTRA_TEXT_PROP   = process.env.EXTRA_TEXT_PROP   || "추가내용"; // rich_text/text

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
  if (process.env.ALLOWED_TYPES_JSON) {
    try { return JSON.parse(process.env.ALLOWED_TYPES_JSON); } catch {}
  }
  const j = safeLoadJson("config/allowed-types.json");
  if (j.__error) throw new Error(`allowed-types.json load failed (${j.__path}): ${j.__error}`);
  return j;
}

function getDbMap() {
  if (process.env.DB_MAP_JSON) {
    try { return JSON.parse(process.env.DB_MAP_JSON); } catch {}
  }
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

function setCache(res) {
  res.setHeader("Cache-Control", `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`);
}

// 값 파싱 유틸
function pickNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function extractTitle(properties) {
  // TITLE_PROP(title)에서 텍스트 합치기
  const p = properties?.[TITLE_PROP];
  if (!p || p.type !== "title") return null;
  const text = (p.title || []).map(t => t.plain_text || "").join("").trim();
  return text || null;
}

function valueFromColumn(properties, columnName) {
  const col = properties[columnName];
  if (!col) return null;
  switch (col.type) {
    case "number":
      return pickNumber(col.number);
    case "rich_text":
      return (col.rich_text || []).map(t => t.plain_text || "").join("").trim() || null;
    case "formula":
      return pickNumber(col.formula?.[col.formula?.type] ?? null);
    default:
      return null;
  }
}

// select / multi_select / extra text 파서
const getSelectName = (props, key) => {
  const p = props?.[key];
  return (p && p.type === "select" && p.select?.name) ? p.select.name : null;
};

const getMultiSelectNames = (props, key) => {
  const p = props?.[key];
  if (!p || p.type !== "multi_select") return [];
  return (p.multi_select || []).map(o => o.name).filter(Boolean);
};

const getExtraText = (props, key) => {
  const p = props?.[key];
  if (!p) return null;
  if (p.type === "rich_text") {
    const s = (p.rich_text || []).map(t => t.plain_text || "").join("").trim();
    return s || null;
  }
  if (p.type === "formula") return p.formula?.string ?? null;
  return null;
};

// ───────────────────────────────────────────────────────────
// Routes
// ───────────────────────────────────────────────────────────

// Health
app.get(["/", "/api/health"], (req, res) => {
  setCache(res);
  res.json({ ok: true, name: "NOTION API HUB", time: new Date().toISOString() });
});

// 디버그: 설정/환경 확인
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
      sampleDbId: sampleId,
      props: { TITLE_PROP, REGION_PROP, DIPLO_PROP, EXTRA_TEXT_PROP }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 컬럼(속성) 목록
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

// 비용 조회 (지역 + 외교유무 + 추가내용 항상 포함)
// GET /api/costs/:country?type=20FT&region=A지역&roles=DIPLOMAT,NON-DIPLOMAT
// 호환: pick / select 쿼리는 region 에일리어스
app.get("/api/costs/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const allowed = getAllowed();

    const typeParam = (req.query.type || "").trim();
    const type = typeParam || allowed[0];
    if (!allowed.includes(type)) {
      return res.status(400).json({ ok: false, error: `Invalid type. Use one of: ${allowed.join(", ")}` });
    }

    const region = (req.query.region || req.query.pick || req.query.select || "").trim();

    // roles: "DIPLOMAT,NON-DIPLOMAT" → 배열
    const rolesStr = (req.query.roles || req.query.role || req.query.diplomat || "").trim();
    const roles = rolesStr
      ? rolesStr.split(",").map(s => s.trim()).filter(Boolean)
      : []; // 없으면 외교유무 조건 없이 전체

    const dbmap = getDbMap();
    const dbid = dbmap[country];
    if (!dbid) return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });

    // ---- Notion filter 구성
    const andFilters = [];
    if (region) {
      andFilters.push({ property: REGION_PROP, select: { equals: region } });
    }
    if (roles.length === 1) {
      andFilters.push({ property: DIPLO_PROP, multi_select: { contains: roles[0] } });
    } else if (roles.length > 1) {
      andFilters.push({
        or: roles.map(r => ({ property: DIPLO_PROP, multi_select: { contains: r } }))
      });
    }

    const body = { page_size: 100 };
    if (andFilters.length === 1) body.filter = andFilters[0];
    else if (andFilters.length > 1) body.filter = { and: andFilters };

    // ---- 쿼리 실행
    const q = await axios.post(
      `https://api.notion.com/v1/databases/${dbid}/query`,
      body,
      { headers: notionHeaders() }
    );

    const results = q.data.results || [];

    // 응답 구조
    const rows = [];
    const values         = {};  // region 지정 시: { 항목: 값 }
    const extras         = {};  // region 지정 시: { 항목: "추가내용" }
    const valuesByRegion = {};  // region 미지정 시: { 지역: { 항목: 값 } }
    const extrasByRegion = {};  // region 미지정 시: { 지역: { 항목: "추가내용" } }

    for (const page of results) {
      const props    = page.properties || {};
      const itemName = extractTitle(props);                   // "이름" (title)
      if (!itemName) continue;

      const regionVal = getSelectName(props, REGION_PROP);    // A지역/B지역 …
      const extraVal  = getExtraText(props, EXTRA_TEXT_PROP); // 추가내용
      const numVal    = pickNumber(valueFromColumn(props, type));

      // 전체 스냅샷(프런트/디버깅용)
      const rowObj = { item: itemName, region: regionVal, extra: extraVal };
      for (const key of allowed) rowObj[key] = pickNumber(valueFromColumn(props, key));
      // 외교유무 값도 참고용으로 넣고 싶다면 다음 줄 주석 해제:
      // rowObj.roles = getMultiSelectNames(props, DIPLO_PROP);
      rows.push(rowObj);

      if (region) {
        // 단일 지역 필터 시 평면 구조
        values[itemName] = numVal;
        extras[itemName] = extraVal ?? null;
      } else {
        // 지역 미지정 시 지역별 그룹 구조
        if (!valuesByRegion[regionVal]) valuesByRegion[regionVal] = {};
        if (!extrasByRegion[regionVal]) extrasByRegion[regionVal] = {};
        valuesByRegion[regionVal][itemName] = numVal;
        extrasByRegion[regionVal][itemName] = extraVal ?? null;
      }
    }

    setCache(res);
    res.json({
      ok: true,
      country,
      type,
      filters: {
        region: region || null,
        roles: roles.length ? roles : null
      },
      ...(region
        ? { values, extras }                   // 예: { "CDS": 1, "THC": 6, "DRC": 11 }, { "CDS":"메모", ... }
        : { valuesByRegion, extrasByRegion }   // 예: { "A지역": {...}, "B지역": {...} } 및 동일 구조 extras
      ),
      rows,
      servedAt: new Date().toISOString()
    });
  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok: false, error: "costs failed", details });
  }
});

// ───────────────────────────────────────────────────────────
// Export (Vercel @vercel/node용)
// ───────────────────────────────────────────────────────────
module.exports = app;
