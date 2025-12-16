// api/destination.js
// 도착지 비용 계산용 공통 라우트 (국가/지역/파트너/POE/화물타입 드롭다운)

// 외부 모듈
const fs    = require("fs");
const path  = require("path");
const axios = require("axios");

// Notion 토큰 + 속성명
const NOTION_TOKEN  = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const REGION_PROP   = process.env.REGION_PROP   || "지역";      // multi_select
const COMPANY_PROP  = process.env.COMPANY_PROP  || "업체";      // select
const POE_PROP      = process.env.POE_PROP      || "POE";       // multi_select
const DIPLO_PROP    = process.env.DIPLO_PROP    || "화물타입";  // multi_select
const ORDER_PROP    = process.env.ORDER_PROP    || "순서";      // number / 정렬용
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);

// ────────────────────────────────
// Notion 공통 헤더
// ────────────────────────────────
function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  }
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

// ────────────────────────────────
// db-map.json 로더 + 헬퍼
// ────────────────────────────────

let DB_MAP_CACHE = null;

function loadDbMap() {
  if (DB_MAP_CACHE) return DB_MAP_CACHE;
  const full = path.join(process.cwd(), "config", "db-map.json");
  const raw  = fs.readFileSync(full, "utf8");
  DB_MAP_CACHE = JSON.parse(raw);
  return DB_MAP_CACHE;
}

/**
 * 국가 이름으로 DB ID 배열 가져오기
 * - "임시": ["..."], "미국": ["...","..."] 형식 지원
 */
function getCountryDbIds(country) {
  const dbmap = loadDbMap();
  const v = dbmap?.[country];
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  if (typeof v === "string") return [v];
  return [];
}

// 문자열 목록 정렬 (한글 우선)
function sortKoAZ(arr) {
  return (arr || [])
    .slice()
    .filter(Boolean)
    .sort((a, b) =>
      String(a).localeCompare(String(b), "ko", { sensitivity: "base" })
    );
}

// 중복 제거
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

// select 이름 추출
function getSelectName(props, key) {
  const col = props?.[key];
  if (!col || col.type !== "select") return null;
  return col.select?.name || null;
}

// multi_select 이름 배열 추출
function getMultiSelectNames(props, key) {
  const col = props?.[key];
  if (!col || col.type !== "multi_select") return [];
  return (col.multi_select || []).map(o => o.name).filter(Boolean);
}

//“전체 페이지를 끝까지 반복해서 읽는 query” 헬퍼 추가
async function queryAllPages(dbId, body) {
  let all = [];
  let hasMore = true;
  let cursor = undefined;

  while (hasMore) {
    const payload = { ...body };
    if (cursor) payload.start_cursor = cursor;

    const resp = await axios.post(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      payload,
      { headers: notionHeaders() }
    );

    const data = resp.data;
    all.push(...(data.results || []));
    hasMore = data.has_more;
    cursor = data.next_cursor;
  }
  return all;
}

// 여러 DB를 같은 body로 query 해서 results 합치기
async function queryAllDatabases(dbIds, body) {
  const all = [];
  for (const id of dbIds) {
    const pages = await queryAllPages(id, body);
    all.push(...pages);
  }
  return all;
}

// 캐시 헤더 (옵션)
function setCache(res) {
  res.setHeader(
    "Cache-Control",
    `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`
  );
}

// ────────────────────────────────
// 메인: 라우트 등록 함수 (수정본)
// ────────────────────────────────

function registerDestinationRoutes(app) {
app.get("/api/debug/config", (req, res) => {
    try {
      const dbmap = loadDbMap();
      const countries = Object.keys(dbmap || {});
      res.json({ ok: true, countries, dbStructure: dbmap });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/regions/:country", async (req, res) => {
    const country = (req.params.country || "").trim();
    if (!country) return res.status(400).json({ ok: false, error: "country required" });

    const dbIds = getCountryDbIds(country);
    if (!dbIds.length) return res.json({ ok: true, country, regions: [] });

    try {
      const body = { page_size: 100 }; 
      const results = await queryAllDatabases(dbIds, body);
      const regionSet = new Set();

      for (const page of results) {
        const props = page.properties || {};
        const col   = props[REGION_PROP];
        if (col?.type === "multi_select") {
          col.multi_select.forEach(opt => opt.name && regionSet.add(opt.name));
        }
      }
      const regions = sortKoAZ(Array.from(regionSet));
      res.json({ ok: true, country, regions, dbCount: dbIds.length });
    } catch (e) {
      console.error("Regions Error:", e.response?.data || e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 1) 지역 → 업체
  app.get("/api/companies/by-region", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      if (!country || !region) return res.status(400).json({ ok: false, error: "Params missing" });
  
      const dbids = getCountryDbIds(country);
      if (!dbids.length) return res.json({ ok:true, companies:[], options:[] });
  
      let pages = [];
      let debugError = null; // 에러 이유 담기

      // [1] 고속 모드
      try {
        const body = {
          filter: {
            property: REGION_PROP, 
            multi_select: { contains: region }
          }
        };
        pages = await queryAllDatabases(dbids, body);
      } catch (filterError) {
        // 에러 내용을 변수에 저장해서 프론트로 보냄
        debugError = filterError.response?.data || filterError.message;
        console.warn(`[FastMode Failed]`, debugError);

        // [2] 안전 모드
        const body = {}; 
        const allPages = await queryAllDatabases(dbids, body);
        pages = allPages.filter(page => {
          const props = page.properties || {};
          const regionCol = props[REGION_PROP];
          if (!regionCol || regionCol.type !== "multi_select") return false;
          return (regionCol.multi_select || []).some(opt => opt && opt.name === region);
        });
      }
  
      const companySet = new Set();
      for (const page of pages) {
        const props = page.properties || {};
        const companyName = getSelectName(props, COMPANY_PROP);
        if (companyName) companySet.add(companyName);
      }
  
      const companies = Array.from(companySet).sort((a, b) =>
        a.localeCompare(b, "ko", { sensitivity: "base" })
      );
  
      setCache(res);
      // 🔥 응답에 debug_error 포함
      return res.json({ 
        ok: true, 
        country, 
        region, 
        companies, 
        options: companies, 
        dbCount: dbids.length,
        isSlowMode: !!debugError, 
        debug_error: debugError 
      });
  
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 2) 업체 + 지역 → POE
  app.get("/api/poe/by-company", async (req, res) => {
    try {
      const { country, region, company } = req.query;
      if (!country || !region || !company) return res.status(400).json({ ok:false, error:"Params missing" });
  
      const dbids = getCountryDbIds(country);
      if (!dbids.length) return res.json({ ok:true, poes:[], options:[] });
  
      let pages = [];
      let debugError = null;
  
      try {
        const body = {
          filter: {
            and: [
              { property: REGION_PROP, multi_select: { contains: region } },
              { property: COMPANY_PROP, select: { equals: company } }
            ]
          }
        };
        pages = await queryAllDatabases(dbids, body);
      } catch (filterError) {
        debugError = filterError.response?.data || filterError.message;
        console.warn(`[FastMode Failed POE]`, debugError);
        
        const body = {}; 
        const allPages = await queryAllDatabases(dbids, body);
        pages = allPages.filter(page => {
          const props = page.properties || {};
          const rCol = props[REGION_PROP];
          const hasRegion = rCol?.multi_select?.some(o => o.name === region);
          const cName = getSelectName(props, COMPANY_PROP);
          const hasCompany = (cName === company);
          return hasRegion && hasCompany;
        });
      }
  
      const poeSet = new Set();
      for (const page of pages) {
        const names = getMultiSelectNames(page.properties, POE_PROP);
        names.forEach(n => poeSet.add(n));
      }
  
      const poes = Array.from(poeSet).sort((a,b)=> a.localeCompare(b,"ko"));
      setCache(res);
      res.json({ ok:true, poes, options:poes, isSlowMode: !!debugError, debug_error: debugError });
  
    } catch (e) {
      res.status(500).json({ ok:false, error: e.message });
    }
  });

  // 3) 지역 + 업체 + POE → 화물타입
  app.get("/api/cargo-types/by-partner", async (req, res) => {
    try {
      const { country, region, company, poe } = req.query;
      if (!country || !region || !company || !poe) return res.status(400).json({ ok:false, error:"Params missing" });
  
      const dbids = getCountryDbIds(country);
      if (!dbids.length) return res.json({ ok:true, types:[], options:[] });
  
      let pages = [];
      let debugError = null;
  
      try {
        const body = {
          filter: {
            and: [
              { property: REGION_PROP, multi_select: { contains: region } },
              { property: COMPANY_PROP, select: { equals: company } },
              { property: POE_PROP, multi_select: { contains: poe } }
            ]
          }
        };
        pages = await queryAllDatabases(dbids, body);
      } catch (filterError) {
        debugError = filterError.response?.data || filterError.message;
        console.warn(`[FastMode Failed Type]`, debugError);
        
        const body = {};
        const allPages = await queryAllDatabases(dbids, body);
        pages = allPages.filter(page => {
          const props = page.properties || {};
          const rCol = props[REGION_PROP];
          const hasRegion = rCol?.multi_select?.some(o => o.name === region);
          const cName = getSelectName(props, COMPANY_PROP);
          const hasCompany = (cName === company);
          const pCol = props[POE_PROP];
          const hasPoe = pCol?.multi_select?.some(o => o.name === poe);
          return hasRegion && hasCompany && hasPoe;
        });
      }
  
      const typeSet = new Set();
      for (const page of pages) {
        const names = getMultiSelectNames(page.properties, DIPLO_PROP);
        names.forEach(n => typeSet.add(n));
      }
  
      const types = Array.from(typeSet).sort((a,b)=> a.localeCompare(b,"ko"));
      setCache(res);
      res.json({ ok:true, types, options:types, isSlowMode: !!debugError, debug_error: debugError });
  
    } catch (e) {
      res.status(500).json({ ok:false, error: e.message });
    }
  });
}

module.exports = registerDestinationRoutes;
