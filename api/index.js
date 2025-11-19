// api/index.js
// CommonJS + Express + @vercel/node

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

/* ─────────────────────────────────────────────────────────
   ENV / 상수
────────────────────────────────────────────────────────── */
const NOTION_TOKEN      = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);
/*노션 속성 읽기 주기 변경. 0으로 현재 실시간. 업데이트 완료 후 600으로 변경요망*/

// 노션 속성명(필요시 Vercel 환경변수로 변경 가능)
const TITLE_PROP        = process.env.TITLE_PROP        || "이름";     // title
const REGION_PROP       = process.env.REGION_PROP       || "지역";     // select
const COMPANY_PROP      = process.env.COMPANY_PROP      || "업체";     // select (신규: 나라 단일 DB에서 업체 구분)
const POE_PROP          = process.env.POE_PROP          || "POE";      // select
const DIPLO_PROP        = process.env.DIPLO_PROP        || "화물타입";  // multi_select
const EXTRA_TEXT_PROP   = process.env.EXTRA_TEXT_PROP   || "추가내용";  // rich_text/text
const ORDER_PROP        = process.env.ORDER_PROP        || "순서";      // number
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP      || "MIN CBM";
const PER_CBM_PROP      = process.env.PER_CBM_PROP      || "PER CBM";
const MIN_COST_PROP     = process.env.MIN_COST_PROP     || "MIN COST";

/* ─────────────────────────────────────────────────────────
   Utils: 파일 로드/헤더/캐시
────────────────────────────────────────────────────────── */
function safeLoadJson(relPathFromRoot) {
  try {
    const full = path.join(process.cwd(), relPathFromRoot);
    return JSON.parse(fs.readFileSync(full, "utf8"));
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

function getDbMapRaw() {
  if (process.env.DB_MAP_JSON) {
    try { return JSON.parse(process.env.DB_MAP_JSON); } catch {}
  }
  const j = safeLoadJson("config/db-map.json");
  if (j.__error) throw new Error(`db-map.json load failed (${j.__path}): ${j.__error}`);
  return j;
}

/**
 * ✅ 나라별 단일 DB id를 반환.
 * - 권장 포맷: { "대한민국": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "미국": "yyyy..." }
 * - 하위 호환:
 *   - { "대한민국": { "__db": "xxx", "A업체": "...", ... } } 형태면 "__db" 또는 "_db" 또는 "dbId" 키를 사용
 *   - { "대한민국": { "A업체": "..." } }만 있는 경우 → 단일 DB가 없으므로 null (이 경우 포맷 업데이트 권장)
 */
// ✅ 국가에 매핑된 DB id 배열을 반환 (문자열/배열/레거시 객체 모두 지원)
function getCountryDbIds(country) {
  const dbmap = getDbMapRaw();
  const v = dbmap?.[country];
  if (!v) return [];

  // 문자열 → 단일 배열
  if (typeof v === "string") return [v].filter(Boolean);

  // 배열 → 그대로
  if (Array.isArray(v)) return v.filter(Boolean);

  // 레거시 객체 → __db / _db / dbId / dbIds / __dbs 등
  if (typeof v === "object") {
    const picks = [];
    if (typeof v.__db === "string") picks.push(v.__db);
    if (typeof v._db  === "string") picks.push(v._db);
    if (typeof v.dbId === "string") picks.push(v.dbId);
    if (Array.isArray(v.dbIds)) picks.push(...v.dbIds);
    if (Array.isArray(v.__dbs)) picks.push(...v.__dbs);
    return picks.filter(Boolean);
  }
  return [];
}

// ⛳ 기존 단일 버전은 하위호환을 위해 남겨둠
function getCountryDbId(country) {
  const arr = getCountryDbIds(country);
  return arr[0] || null;
}

// ✅ 메타의 숫자 포맷 병합 (우측 우선)
function mergeNumberFormats(base = {}, add = {}) {
  return { ...base, ...add };
}

// ✅ 배열 유니크(문자열)
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// ✅ 여러 DB 메타를 병렬로 읽어 numberFormats 병합
async function fetchMergedNumberFormats(dbids) {
  let formats = {};
  for (const dbid of dbids) {
    const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, { headers: notionHeaders() });
    formats = mergeNumberFormats(formats, extractNumberFormats(meta));
  }
  return formats;
}

// ✅ 여러 DB를 같은 쿼리(body)로 병렬 조회 → results 합치기
async function queryAllDatabases(dbids, body) {
  const calls = dbids.map(dbid =>
    axios.post(`https://api.notion.com/v1/databases/${dbid}/query`, body, { headers: notionHeaders() })
      .then(r => r.data?.results || [])
      .catch(() => [])
  );
  const chunks = await Promise.all(calls);
  return chunks.flat();
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

// HTML 이스케이프
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// rich_text → HTML 간단 변환
function notionRichToHtml(richTexts = []) {
  return richTexts.map(rt => {
    let t = escapeHtml(rt.text?.content || "").replace(/\n/g, "<br>");
    const ann = rt.annotations || {};
    if (ann.bold) t = `<b>${t}</b>`;
    if (ann.italic) t = `<i>${t}</i>`;
    if (ann.underline) t = `<u>${t}</u>`;
    if (ann.strikethrough) t = `<s>${t}</s>`;
    if (ann.code) t = `<code>${t}</code>`;
    if (ann.color && ann.color !== "default") t = `<span style="color:${ann.color}">${t}</span>`;
    if (rt.text?.link?.url) t = `<a href="${rt.text.link.url}" target="_blank" rel="noopener noreferrer">${t}</a>`;
    return t;
  }).join("");
}

// 값 파서
const pickNumber = (v)=> (v==null?null:(typeof v==="number"?v:(Number.isFinite(+v)?+v:v)));
function extractTitle(properties) {
  const p = properties?.[TITLE_PROP];
  if (!p || p.type !== "title") return null;
  const text = (p.title || []).map(t => t.plain_text || "").join("").trim();
  return text || null;
}
function valueFromColumn(properties, columnName) {
  const col = properties[columnName];
  if (!col) return null;
  switch (col.type) {
    case "number":   return pickNumber(col.number);
    case "rich_text":return (col.rich_text||[]).map(t=>t.plain_text||"").join("").trim() || null;
    case "formula":  return pickNumber(col.formula?.[col.formula?.type] ?? null);
    default:         return null;
  }
}
const getSelectName = (props, key) => (props?.[key]?.type==="select" ? (props[key].select?.name || null) : null);
const getMultiSelectNames = (props, key) => {
  const p = props?.[key];
  if (!p || p.type!=="multi_select") return [];
  return (p.multi_select||[]).map(o=>o.name).filter(Boolean);
};
function getNumberProp(props, key) {
  const col = props?.[key];
  if (!col) return null;
  if (col.type==="number")  return pickNumber(col.number);
  if (col.type==="formula") return pickNumber(col.formula?.[col.formula?.type] ?? null);
  if (col.type==="rich_text") {
    const s = (col.rich_text||[]).map(t=>t.plain_text||"").join("").trim();
    const n = Number(s); return Number.isFinite(n) ? n : null;
  }
  return null;
}
function hasCbmTriplet(props) {
  const minCbm  = getNumberProp(props, MIN_CBM_PROP);
  const perCbm  = getNumberProp(props, PER_CBM_PROP);
  const minCost = getNumberProp(props, MIN_COST_PROP);
  return (minCbm != null && perCbm != null && minCost != null);
}
function computeConsoleCost(props, cbmInput) {
  const minCbm  = getNumberProp(props, MIN_CBM_PROP);
  const perCbm  = getNumberProp(props, PER_CBM_PROP);
  const minCost = getNumberProp(props, MIN_COST_PROP);
  if (minCbm == null || perCbm == null || minCost == null) return null;
  const effCbm = Number.isFinite(cbmInput) ? cbmInput : minCbm;
  const diff   = Math.max(0, effCbm - minCbm);
  return pickNumber(minCost + diff * perCbm);
}

// DB 메타에서 숫자 컬럼 포맷(dollar, won…) 추출
function extractNumberFormats(meta) {
  const props = meta?.data?.properties || {};
  const formats = {};
  for (const [key, def] of Object.entries(props)) {
    if (def?.type === "number" && def.number?.format) {
      formats[key] = def.number.format;
    }
  }
  return formats;
}

/* ─────────────────────────────────────────────────────────
   Routes
────────────────────────────────────────────────────────── */

// Health
app.get(["/", "/api/health"], (req, res) => {
  setCache(res);
  res.json({ ok: true, name: "NOTION API HUB", time: new Date().toISOString() });
});

// 디버그: 설정/환경 확인
app.get("/api/debug/config", async (req, res) => {
  try {
    const allowed = getAllowed();
    const raw = getDbMapRaw();
    const countries = Object.keys(raw);

    // 첫 번째 국가
    const firstCountry = countries[0] || null;
    let companiesPreview = [];
    let numberFormats = {};
    if (firstCountry) {
      const dbid = getCountryDbId(firstCountry);
      if (dbid) {
        const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, { headers: notionHeaders() });
        const prop = meta.data.properties?.[COMPANY_PROP];
        companiesPreview = (prop?.type === "select" ? (prop.select?.options||[]).map(o=>o.name) : []);
        numberFormats = extractNumberFormats(meta);
      }
    }

    res.json({
      ok: true,
      env: { NOTION_TOKEN_PRESENT: Boolean(NOTION_TOKEN) },
      allowedTypes: allowed,
      dbStructure: raw, // 국가 → (권장) 단일 DB id (하위호환: 객체)
      countries,
      companiesPreview,
      props: { TITLE_PROP, REGION_PROP, COMPANY_PROP, POE_PROP, DIPLO_PROP, EXTRA_TEXT_PROP, ORDER_PROP },
      numberFormatsPreview: numberFormats
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 컬럼(속성) 목록 — 이제 country만 필요(단일 DB)
// 🔄 교체: 단일 → 다중
app.get("/api/notion/list-columns", async (req, res) => {
  try {
    const country = (req.query.country||"").trim();
    if (!country) return res.status(400).json({ ok:false, error:"country is required" });

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.status(404).json({ ok:false, error:`Unknown country: ${country}` });

    // 첫 번째 DB에서 컬럼 스키마를 대표로 가져오고, 포맷은 모두 병합
    const meta0 = await axios.get(`https://api.notion.com/v1/databases/${dbids[0]}`, { headers: notionHeaders() });
    const columns = Object.keys(meta0.data.properties || {});
    let numberFormats = extractNumberFormats(meta0);

    for (let i=1;i<dbids.length;i++){
      const metai = await axios.get(`https://api.notion.com/v1/databases/${dbids[i]}`, { headers: notionHeaders() });
      numberFormats = mergeNumberFormats(numberFormats, extractNumberFormats(metai));
    }

    setCache(res);
    res.json({ ok:true, country, columns, numberFormats, dbCount: dbids.length });
  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok:false, error:"list-columns failed", details });
  }
});


// 비용 조회 (단일 DB). company는 선택적 필터로 반영
// GET /api/costs/:country?type=20FT&region=A지역&company=AMS&roles=DIPLOMAT,NON-DIPLOMAT&cbm=12
// 🔄 교체: 단일 → 다중
app.get("/api/costs/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const allowed = getAllowed();

    const typeParam = (req.query.type || "").trim();
    const region    = (req.query.region || req.query.pick || req.query.select || "").trim();
    const company   = (req.query.company || "").trim();
    const rolesStr  = (req.query.roles || req.query.role || req.query.diplomat || "").trim();
    const roles     = rolesStr ? rolesStr.split(",").map(s=>s.trim()).filter(Boolean) : [];
    const cbmQ      = Number(req.query.cbm);
    const cbm       = Number.isFinite(cbmQ) ? cbmQ : null;

    const type = typeParam || allowed[0];
    if (type !== "CONSOLE" && !allowed.includes(type)) {
      return res.status(400).json({ ok:false, error:`Invalid type. Use one of: CONSOLE, ${allowed.join(", ")}` });
    }

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.status(404).json({ ok:false, error:`Unknown country: ${country}` });

    // 숫자 포맷 병합
    const numberFormats = await fetchMergedNumberFormats(dbids);

   // 필터 구성
   const andFilters = [];

   // 🔧 수정: 선택한 지역 OR 지역 비어있는 행 둘 다 포함
   if (region) {
     andFilters.push({
       or: [
         { property: REGION_PROP, select: { equals: region } },
         { property: REGION_PROP, select: { is_empty: true } }
       ]
     });
   }

   if (company) {
        andFilters.push({
          or: [
            { property: COMPANY_PROP, select: { equals: company } },               // 단일 선택일 때
            { property: COMPANY_PROP, multi_select: { contains: company } }        // 다중 선택일 때
          ]
        });
      }
   if (roles.length === 1) {
     andFilters.push({ property: DIPLO_PROP, multi_select: { contains: roles[0] } });
   } else if (roles.length > 1) {
     andFilters.push({ or: roles.map(r => ({ property: DIPLO_PROP, multi_select: { contains: r } })) });
   }
   const body = { page_size: 100, sorts: [{ property: ORDER_PROP, direction: "ascending" }] };
   if (andFilters.length === 1) body.filter = andFilters[0];
   else if (andFilters.length > 1) body.filter = { and: andFilters };


    // 여러 DB에서 결과 수집
    const results = await queryAllDatabases(dbids, body);

    // 응답 구성(중복 항목 머지)
    const rows = [];
    const seen = new Set(); // item+region 키 중복 방지

    const values = {};
    const extras = {};
    const valuesByRegion = {};
    const extrasByRegion = {};

    for (const page of results) {
      const props = page.properties || {};
      const itemName  = extractTitle(props);
      if (!itemName) continue;

      const regionName = getSelectName(props, REGION_PROP);
      const extraVal   = notionRichToHtml(props[EXTRA_TEXT_PROP]?.rich_text || []);

      let numVal = (type === "CONSOLE") ? null : pickNumber(valueFromColumn(props, type));
      if (type === "CONSOLE" || ((type === "20FT" || type === "40HC") && numVal == null && hasCbmTriplet(props))) {
        numVal = computeConsoleCost(props, cbm);
      }

      const rowObj = { item: itemName, region: regionName, extra: extraVal };
      for (const key of allowed) rowObj[key] = pickNumber(valueFromColumn(props, key));
      rowObj["MIN CBM"]  = getNumberProp(props, MIN_CBM_PROP);
      rowObj["PER CBM"]  = getNumberProp(props, PER_CBM_PROP);
      rowObj["MIN COST"] = getNumberProp(props, MIN_COST_PROP);
      rowObj[type]       = numVal;
      rowObj[ORDER_PROP] = getNumberProp(props, ORDER_PROP);

      // 중복 방지 키
      const dedupKey = `${itemName}__${regionName || "기타"}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        rows.push(rowObj);
      }

      if (region) {
        if (!regionName || regionName === region) {
          // 마지막 값이 덮어쓰는 우측 우선 정책
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
      dbCount: dbids.length,
      filters: { region: region || null, company: company || null, roles: roles.length ? roles : null, cbm },
      numberFormats,
      ...(region ? { values, extras } : { valuesByRegion, extrasByRegion }),
      rows,
      servedAt: new Date().toISOString()
    });

  } catch (e) {
    const details = e.response?.data || e.message || e.toString();
    res.status(500).json({ ok:false, error:"costs failed", details });
  }
});


// 지역 목록: 나라 단일 DB 메타의 REGION select 옵션
// 🔄 교체: 여러 DB의 REGION 옵션 합치기
app.get("/api/regions/:country", async (req, res) => {
  try {
    const country = req.params.country;
    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.json({ ok:true, country, regions: [] });

    let regions = [];
    for (const dbid of dbids) {
      const meta = await axios.get(`https://api.notion.com/v1/databases/${dbid}`, { headers: notionHeaders() });
      const prop = meta.data.properties?.[REGION_PROP];
      const part = (prop?.type === "select" ? (prop.select?.options || []).map(o=>o.name).filter(Boolean) : []);
      regions = regions.concat(part);
    }
    regions = uniq(regions).sort((a,b)=> a.localeCompare(b,'ko'));

    setCache(res);
    res.json({ ok:true, country, regions, dbCount: dbids.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:"regions failed", details:e.message || String(e) });
  }
});


// 지역 → 업체 (중복 제거, 실제 데이터 기준)
// 🔄 교체: 여러 DB query 후 업체 합치기
app.get("/api/companies/by-region", async (req, res) => {
  try {
    const country = (req.query.country || "").trim();
    const region  = (req.query.region  || "").trim();
    if (!country || !region) return res.status(400).json({ ok:false, error:"country and region are required" });

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.json({ ok:true, country, region, companies: [] });

    const body = {
      page_size: 100,
      filter: { property: REGION_PROP, select: { equals: region } },
      sorts:  [{ property: ORDER_PROP, direction: "ascending" }]
    };
    const results = await queryAllDatabases(dbids, body);

    const companies = uniq(
      results.map(p => getSelectName(p.properties, COMPANY_PROP)).filter(Boolean)
    ).sort((a,b)=> a.localeCompare(b,'ko'));

    setCache(res);
    res.json({ ok:true, country, region, companies, dbCount: dbids.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:"companies-by-region failed", details:e.message || String(e) });
  }
});


// 지역 → POE (중복 제거, 실제 데이터 기준)
// 🔄 교체: 여러 DB query 후 POE 합치기
app.get("/api/poe/by-region", async (req, res) => {
  try {
    const country = (req.query.country || "").trim();
    const region  = (req.query.region  || "").trim();
    if (!country || !region) return res.status(400).json({ ok:false, error:"country and region are required" });

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.json({ ok:true, country, region, poes: [] });

    const body = {
      page_size: 100,
      filter: { property: REGION_PROP, select: { equals: region } },
      sorts:  [{ property: ORDER_PROP, direction: "ascending" }]
    };
    const results = await queryAllDatabases(dbids, body);

    const poes = uniq(
      results.map(p => getSelectName(p.properties, POE_PROP)).filter(Boolean)
    ).sort((a,b)=> a.localeCompare(b,'ko'));

    setCache(res);
    res.json({ ok:true, country, region, poes, dbCount: dbids.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:"poe-by-region failed", details:e.message || String(e) });
  }
});


// 업체+지역 → POE (중복 제거, 실제 데이터 기준)
// 🔄 교체: 여러 DB query 후 POE 합치기
app.get("/api/poe/by-company", async (req, res) => {
  try {
    const country = (req.query.country || "").trim();
    const region  = (req.query.region  || "").trim();
    const company = (req.query.company || "").trim();
    if (!country || !region || !company) return res.status(400).json({ ok:false, error:"country, region, company are required" });

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.json({ ok:true, country, region, company, poes: [] });

    const body = {
      page_size: 100,
      filter: { and: [
        { property: REGION_PROP,  select: { equals: region } },
        { property: COMPANY_PROP, select: { equals: company } }
      ]},
      sorts: [{ property: ORDER_PROP, direction: "ascending" }]
    };
    const results = await queryAllDatabases(dbids, body);

    const poes = uniq(
      results.map(p => getSelectName(p.properties, POE_PROP)).filter(Boolean)
    ).sort((a,b)=> a.localeCompare(b,'ko'));

    setCache(res);
    res.json({ ok:true, country, region, company, poes, dbCount: dbids.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:"poe-by-company failed", details:e.message || String(e) });
  }
});


// 화물타입 목록: 나라 단일 DB 메타의 DIPLO_PROP(= "화물타입") multi_select 옵션
// 업체(필수) [+ 국가/지역] → 화물타입 distinct (multi_select "화물타입")
// 🔄 교체: 여러 DB query 후 화물타입 합치기
app.get("/api/cargo-types/by-partner", async (req, res) => {
  try {
    const country = (req.query.country || "").trim();
    const region  = (req.query.region  || "").trim(); // 선택
    const company = (req.query.company || "").trim();
    if (!country || !company) return res.status(400).json({ ok:false, error:"country and company are required" });

    const dbids = getCountryDbIds(country);
    if (dbids.length === 0) return res.json({ ok:true, country, types: [] });

    const andFilters = [{ property: COMPANY_PROP, select: { equals: company } }];
    if (region) andFilters.push({ property: REGION_PROP, select: { equals: region } });

    const body = {
      page_size: 100,
      filter: (andFilters.length === 1 ? andFilters[0] : { and: andFilters }),
      sorts: [{ property: ORDER_PROP, direction: "ascending" }]
    };

    const results = await queryAllDatabases(dbids, body);
    const types = uniq(
      results.flatMap(p => getMultiSelectNames(p.properties, DIPLO_PROP))
    ).sort((a,b)=> a.localeCompare(b,'ko'));

    setCache(res);
    res.json({ ok:true, country, region: region || null, company, types, dbCount: dbids.length });
  } catch (e) {
    res.status(500).json({ ok:false, error:"cargo-types-by-partner failed", details:e.message || String(e) });
  }
});



const registerOutboundSosRoutes = require("./outboundsos");
const registerInboundSosRoutes  = require("./inboundsos");

registerOutboundSosRoutes(app);
registerInboundSosRoutes(app);
/* ─────────────────────────────────────────────────────────
   Export (Vercel @vercel/node)
────────────────────────────────────────────────────────── */
module.exports = app;


