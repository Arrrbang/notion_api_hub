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
const ORDER_PROP        = process.env.ORDER_PROP        || "순서"; // 숫자(Number) 속성 이름
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP      || "MIN CBM";
const PER_CBM_PROP      = process.env.PER_CBM_PROP      || "PER CBM";
const MIN_COST_PROP     = process.env.MIN_COST_PROP     || "MIN COST";


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

// HTML 이스케이프
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

// 🧩 노션의 rich_text → HTML 변환
function notionRichToHtml(richTexts = []) {
  return richTexts.map(rt => {
    let t = escapeHtml(rt.text?.content || "").replace(/\n/g, "<br>"); // ← 줄바꿈 보존
    const ann = rt.annotations || {};

    // 스타일 변환
    if (ann.bold) t = `<b>${t}</b>`;
    if (ann.italic) t = `<i>${t}</i>`;
    if (ann.underline) t = `<u>${t}</u>`;
    if (ann.strikethrough) t = `<s>${t}</s>`;
    if (ann.code) t = `<code>${t}</code>`;

    // 색상 적용
    if (ann.color && ann.color !== "default") {
      const colorMap = {
        red: "#dc2626", orange: "#ea580c", yellow: "#ca8a04",
        green: "#16a34a", blue: "#2563eb", purple: "#7c3aed",
        pink: "#db2777", gray: "#6b7280"
      };
      const htmlColor = colorMap[ann.color] || ann.color;
      t = `<span style="color:${htmlColor}">${t}</span>`;
    }

    // 링크 처리
    if (rt.text?.link?.url) {
      const url = rt.text.link.url;
      t = `<a href="${url}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    }

    return t;
  }).join("");
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

function getNumberProp(props, key) {
  const col = props?.[key];
  if (!col) return null;
  if (col.type === "number") return pickNumber(col.number);
  if (col.type === "formula") return pickNumber(col.formula?.[col.formula?.type] ?? null);
  if (col.type === "rich_text") {
    const s = (col.rich_text || []).map(t => t.plain_text || "").join("").trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// MIN CBM / PER CBM / MIN COST 삼형제가 있는지
function hasCbmTriplet(props) {
  const minCbm  = getNumberProp(props, MIN_CBM_PROP);
  const perCbm  = getNumberProp(props, PER_CBM_PROP);
  const minCost = getNumberProp(props, MIN_COST_PROP);
  return (minCbm != null && perCbm != null && minCost != null);
}

// 실제 요금 계산: MIN COST + max(0, CBM - MIN CBM) * PER CBM
function computeConsoleCost(props, cbmInput) {
  const minCbm  = getNumberProp(props, MIN_CBM_PROP);
  const perCbm  = getNumberProp(props, PER_CBM_PROP);
  const minCost = getNumberProp(props, MIN_COST_PROP);
  if (minCbm == null || perCbm == null || minCost == null) return null;

  const effCbm = Number.isFinite(cbmInput) ? cbmInput : minCbm; // CBM 미지정 시 최소값으로
  const diff   = Math.max(0, effCbm - minCbm);
  return pickNumber(minCost + diff * perCbm);
}


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

    // 최상위 국가 키
    const countries = Object.keys(dbmap);

    // 첫 번째 국가의 업체 목록 미리 보기 (없을 수도 있음)
    const firstCountry = countries[0];
    const companies = firstCountry ? Object.keys(dbmap[firstCountry]) : [];

    // 샘플 ID (첫 국가의 첫 업체)
    const sampleId =
      firstCountry && companies.length > 0
        ? dbmap[firstCountry][companies[0]]
        : null;

    res.json({
      ok: true,
      env: { NOTION_TOKEN_PRESENT: Boolean(NOTION_TOKEN) },
      allowedTypes: allowed,
      dbStructure: dbmap,              // 전체 구조 미리 보기
      countries,                       // ["미국", "중국", ...]
      companiesByFirstCountry: companies, // 예: ["A업체", "B업체"]
      sample: {
        country: firstCountry || null,
        company: companies[0] || null,
        dbId: sampleId
      },
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
    const company = (req.query.company || "").trim(); // 회사명 A업체, B업체 ...
    const dbid = dbmap[country]?.[company];
    
    if (!dbid) {
      return res.status(404).json({
        ok: false,
        error: `Unknown country/company combination: ${country}/${company}`
      });
    }


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
    const region = (req.query.region || req.query.pick || req.query.select || "").trim();
    const rolesStr = (req.query.roles || req.query.role || req.query.diplomat || "").trim();
    const roles = rolesStr ? rolesStr.split(",").map(s=>s.trim()).filter(Boolean) : [];

    // ✅ CBM 쿼리값 (정수)
    const cbmQ = Number(req.query.cbm);
    const cbm = Number.isFinite(cbmQ) ? cbmQ : null;

    // type 검증: CONSOLE 은 허용(계산용), 그 외는 allowed에 있어야 함
    const type = typeParam || allowed[0];
    if (type !== "CONSOLE" && !allowed.includes(type)) {
      return res.status(400).json({
        ok: false,
        error: `Invalid type. Use one of: CONSOLE, ${allowed.join(", ")}`
      });
    }

    // --- DB 조회
    const dbmap = getDbMap();
    const company = (req.query.company || "").trim();
    const dbid = dbmap[country]?.[company];
    if (!dbid) {
      return res.status(404).json({
        ok: false,
        error: `Unknown country/company combination: ${country}/${company}`
      });
    }

    // --- Notion 필터 구성
    const andFilters = [];
    if (region) {
      andFilters.push({
        or: [
          { property: REGION_PROP, select: { equals: region } },
          { property: REGION_PROP, select: { is_empty: true } }
        ]
      });
    }
    if (roles.length === 1) {
      andFilters.push({ property: DIPLO_PROP, multi_select: { contains: roles[0] } });
    } else if (roles.length > 1) {
      andFilters.push({ or: roles.map(r => ({ property: DIPLO_PROP, multi_select: { contains: r } })) });
    }

    const body = { page_size: 100 };
    if (andFilters.length === 1) body.filter = andFilters[0];
    else if (andFilters.length > 1) body.filter = { and: andFilters };
    body.sorts = [{ property: ORDER_PROP, direction: "ascending" }];

    const q = await axios.post(
      `https://api.notion.com/v1/databases/${dbid}/query`,
      body,
      { headers: notionHeaders() }
    );
    const results = q.data.results || [];

    // --- 응답 구조
    const rows = [];
    const values = {};
    const extras = {};
    const valuesByRegion = {};
    const extrasByRegion = {};

    for (const page of results) {
      const props = page.properties || {};
      const itemName = extractTitle(props);
      if (!itemName) continue;

      const regionName = getSelectName(props, REGION_PROP);
      const extraVal = notionRichToHtml(props[EXTRA_TEXT_PROP]?.rich_text || []);

      // 1️⃣ 기본값: 선택된 type(20FT/40HC)
      let numVal = (type === "CONSOLE")
        ? null
        : pickNumber(valueFromColumn(props, type));

      // 2️⃣ CONSOLE 모드이거나, 20FT·40HC 값이 없고 삼형제가 존재하면 CBM 계산
      if (type === "CONSOLE" || ((type === "20FT" || type === "40HC") && numVal == null && hasCbmTriplet(props))) {
        numVal = computeConsoleCost(props, cbm);
      }

      // --- rows 구성
      const rowObj = { item: itemName, region: regionName, extra: extraVal };
      for (const key of allowed) rowObj[key] = pickNumber(valueFromColumn(props, key));
      rowObj["MIN CBM"]  = getNumberProp(props, MIN_CBM_PROP);
      rowObj["PER CBM"]  = getNumberProp(props, PER_CBM_PROP);
      rowObj["MIN COST"] = getNumberProp(props, MIN_COST_PROP);
      rowObj[type] = numVal;
      rows.push(rowObj);

      // --- region 그룹 반영
      if (region) {
        if (!regionName || regionName === region) {
          values[itemName] = numVal;
          extras[itemName] = extraVal ?? null;
        }
      } else {
        const key = regionName || "기타";
        if (!valuesByRegion[key]) valuesByRegion[key] = {};
        if (!extrasByRegion[key]) extrasByRegion[key] = {};
        valuesByRegion[key][itemName] = numVal;
        extrasByRegion[key][itemName] = extraVal ?? null;
      }
    }

    setCache(res);
    res.json({
      ok: true,
      country,
      type,
      filters: { region: region || null, roles: roles.length ? roles : null, cbm },
      ...(region ? { values, extras } : { valuesByRegion, extrasByRegion }),
      rows,
      servedAt: new Date().toISOString()
    });

  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok: false, error: "costs failed", details });
  }
});

// 지역 목록 모으기: 국가 → 모든 업체 DB의 '지역' select 옵션을 합집합으로
app.get("/api/regions/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const dbmap = getDbMap();
    const companies = Object.keys(dbmap[country] || {});
    if (!companies.length) {
      return res.json({ ok: true, country, regions: [] });
    }

    // 각 DB 메타에서 지역 select 옵션 읽기 (빠름)
    const tasks = companies.map(async (company) => {
      const dbid = dbmap[country][company];
      try {
        const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, {
          headers: notionHeaders()
        });
        const prop = meta.data.properties?.[REGION_PROP];
        const opts = (prop?.type === "select" ? (prop.select?.options || []) : []);
        return opts.map(o => o.name).filter(Boolean);
      } catch {
        return [];
      }
    });

    const arrays = await Promise.all(tasks);
    const regions = [...new Set(arrays.flat())]; // 중복 제거

    setCache(res);
    res.json({ ok: true, country, regions });
  } catch (e) {
    res.status(500).json({ ok: false, error: "regions failed", details: e.message || String(e) });
  }
});

// 지역 → 업체 필터링: 해당 지역을 '지원하는' 업체 리스트
// mode=options (기본): DB 옵션에 지역이 있으면 포함
// mode=data: 실제로 지역=값 인 페이지가 1행 이상 존재하면 포함
app.get("/api/companies/by-region", async (req, res) => {
  try {
    const country = (req.query.country || "").trim();
    const region  = (req.query.region  || "").trim();
    const mode    = (req.query.mode    || "options").trim(); // options | data

    if (!country || !region) {
      return res.status(400).json({ ok: false, error: "country and region are required" });
    }

    const dbmap = getDbMap();
    const companies = Object.keys(dbmap[country] || {});
    if (!companies.length) {
      return res.json({ ok: true, country, region, mode, companies: [] });
    }

    if (mode === "options") {
      // 빠른 경로: DB 메타의 지역 옵션에 region이 존재?
      const tasks = companies.map(async (company) => {
        const dbid = dbmap[country][company];
        try {
          const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, {
            headers: notionHeaders()
          });
          const prop = meta.data.properties?.[REGION_PROP];
          const names = (prop?.type === "select" ? (prop.select?.options || []).map(o=>o.name) : []);
          return names.includes(region) ? company : null;
        } catch {
          return null;
        }
      });

      const results = (await Promise.all(tasks)).filter(Boolean);
      setCache(res);
      return res.json({ ok: true, country, region, mode, companies: results });
    }

    // 정확한 경로: 실제 데이터에 지역=region 또는 (원하면 공란 포함) 존재?
    // 공란도 ‘포함’하고 싶다면 아래 filter를 or:[ equals, is_empty ] 로 바꿔주세요.
    const tasks = companies.map(async (company) => {
      const dbid = dbmap[country][company];
      try {
        const body = {
          page_size: 1,
          filter: { property: REGION_PROP, select: { equals: region } }
        };
        const q = await axios.post(`https://api.notion.com/v1/databases/${dbid}/query`, body, {
          headers: notionHeaders()
        });
        return (q.data.results || []).length ? company : null;
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(tasks)).filter(Boolean);
    setCache(res);
    res.json({ ok: true, country, region, mode: "data", companies: results });

  } catch (e) {
    res.status(500).json({ ok: false, error: "companies-by-region failed", details: e.message || String(e) });
  }
});


// ───────────────────────────────────────────────────────────
// Export (Vercel @vercel/node용)
// ───────────────────────────────────────────────────────────
module.exports = app;
