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
// 메인: 라우트 등록 함수
// ────────────────────────────────

function registerDestinationRoutes(app) {
  /**
   * GET /api/debug/config
   *
   * - 국가 드롭다운용
   * - 프론트에서는 j.countries 또는 j.dbStructure 사용
   */
  app.get("/api/debug/config", (req, res) => {
    try {
      const dbmap = loadDbMap();
      const countries = Object.keys(dbmap || {});
      res.json({
        ok: true,
        countries,      // ["임시","미국", ...]
        dbStructure: dbmap,
      });
    } catch (e) {
      console.error("GET /api/debug/config error:", e);
      res.status(500).json({
        ok: false,
        error: "debug-config failed",
        details: e.message || String(e),
      });
    }
  });

  /**
   * GET /api/regions/:country
   *
   * - 1번 드롭다운에서 선택된 국가의 모든 DB에서
   *   "지역" multi_select 속성 값들을 모아서 중복 제거 후 반환.
   */
  app.get("/api/regions/:country", async (req, res) => {
    const country = (req.params.country || "").trim();
    if (!country) {
      return res.status(400).json({
        ok: false,
        error: "country is required",
      });
    }
  
    const dbIds = getCountryDbIds(country);
    if (!dbIds.length) {
      return res.json({ ok: true, country, regions: [] });
    }
  
    if (!NOTION_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "NOTION_API_KEY (또는 NOTION_TOKEN)이 설정되어 있지 않습니다.",
      });
    }
  
    try {
      const regionSet = new Set();
  
      // 🔥 pagination 지원 헬퍼 사용
      const body = {
        page_size: 100, // 있어도 되고, 없어도 됨 (어차피 전체 페이지 돌 거라)
      };
  
      const results = await queryAllDatabases(dbIds, body);
  
      for (const page of results) {
        const props = page.properties || {};
        const col   = props[REGION_PROP];
        if (!col || col.type !== "multi_select") continue;
  
        const items = col.multi_select || [];
        for (const opt of items) {
          if (!opt?.name) continue;
          regionSet.add(opt.name);
        }
      }
  
      const regions = sortKoAZ(Array.from(regionSet));
      res.json({ ok: true, country, regions, dbCount: dbIds.length });
    } catch (e) {
      console.error("GET /api/regions error:", e.response?.data || e);
      res.status(500).json({
        ok: false,
        error: "regions failed",
        details: e.response?.data || e.message || String(e),
      });
    }
  });


// 1) 지역 → 업체 (최적화 버전: Notion Native Filter 적용)
  app.get("/api/companies/by-region", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
  
      if (!country || !region) {
        return res.status(400).json({
          ok: false,
          error: "country and region are required",
        });
      }
  
      const dbids = getCountryDbIds(country);
      if (!dbids.length) {
        return res.json({
          ok: true,
          country,
          region,
          companies: [],
          options: [],
        });
      }
  
      // ✅ 핵심 수정: Notion API 필터 사용 (서버 부하 감소 & 속도 향상)
      const body = {
        filter: {
          property: REGION_PROP, // 환경변수 또는 "지역"
          multi_select: {
            contains: region // 해당 지역을 포함하는 행만 가져옴
          }
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }],
      };
  
      // 필터링된 소량의 데이터만 가져옴
      const pages = await queryAllDatabases(dbids, body);
  
      const companySet = new Set();
  
      for (const page of pages) {
        const props = page.properties || {};
        
        // 이미 노션에서 지역 필터링을 했으므로, 바로 업체명만 추출하면 됨
        const companyName = getSelectName(props, COMPANY_PROP);
        if (companyName) {
          companySet.add(companyName);
        }
      }
  
      const companies = Array.from(companySet).sort((a, b) =>
        a.localeCompare(b, "ko", { sensitivity: "base" })
      );
  
      setCache(res);
      return res.json({
        ok: true,
        country,
        region,
        companies,
        options: companies,
        dbCount: dbids.length,
      });
    } catch (e) {
      console.error("GET /api/companies/by-region error:", e.response?.data || e);
      return res.status(500).json({
        ok: false,
        error: "companies-by-region failed",
        details: e.response?.data || e.message || String(e),
      });
    }
  });

// 3) 업체 + 지역 → POE (최적화 버전: AND 필터 적용)
  app.get("/api/poe/by-company", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      const company = (req.query.company || "").trim();
  
      if (!country || !region || !company) {
        return res.status(400).json({
          ok: false,
          error: "country, region, company are required"
        });
      }
  
      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok: true, country, region, company, poes: [], options: [] });
      }
  
      // ✅ 핵심 수정: 지역 AND 업체 필터 동시 적용
      const body = {
        filter: {
          and: [
            {
              property: REGION_PROP,
              multi_select: { contains: region }
            },
            {
              property: COMPANY_PROP,
              select: { equals: company }
            }
          ]
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };
  
      const pages = await queryAllDatabases(dbids, body);
      const poeSet = new Set();
  
      for (const page of pages) {
        const props = page.properties || {};
        // 필터링된 데이터에서 POE 값만 추출
        const poeNames = getMultiSelectNames(props, POE_PROP);
        poeNames.forEach(name => poeSet.add(name));
      }
  
      const poes = Array.from(poeSet).sort((a, b) =>
        a.localeCompare(b, "ko", { sensitivity: "base" })
      );
  
      setCache(res);
      return res.json({
        ok: true,
        country,
        region,
        company,
        poes,
        options: poes,
        dbCount: dbids.length
      });
    } catch (e) {
      console.error("GET /api/poe/by-company error:", e.response?.data || e);
      return res.status(500).json({
        ok: false,
        error: "poe-by-company failed",
        details: e.response?.data || e.message || String(e)
      });
    }
  });


// 4) 지역 + 업체 + POE → 화물타입 (최적화 버전: 3중 AND 필터)
  app.get("/api/cargo-types/by-partner", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      const company = (req.query.company || "").trim();
      const poe     = (req.query.poe     || "").trim();
  
      if (!country || !region || !company || !poe) {
        return res.status(400).json({
          ok: false,
          error: "country, region, company, poe are all required",
        });
      }
  
      const dbids = getCountryDbIds(country);
      if (!dbids.length) {
        return res.json({
          ok: true,
          country,
          region,
          company,
          poe,
          types: [],
          options: [],
        });
      }
  
      // ✅ 핵심 수정: 3가지 조건(Region, Company, POE) 모두 필터링
      const body = {
        filter: {
          and: [
            { property: REGION_PROP, multi_select: { contains: region } },
            { property: COMPANY_PROP, select: { equals: company } },
            { property: POE_PROP, multi_select: { contains: poe } }
          ]
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }],
      };
  
      const pages = await queryAllDatabases(dbids, body);
      const typeSet = new Set();
  
      for (const page of pages) {
        const props = page.properties || {};
        // 조건에 맞는 데이터의 화물타입만 추출
        const typeNames = getMultiSelectNames(props, DIPLO_PROP);
        typeNames.forEach((name) => typeSet.add(name));
      }
  
      const types = Array.from(typeSet).sort((a, b) =>
        a.localeCompare(b, "ko", { sensitivity: "base" })
      );
  
      setCache(res);
      return res.json({
        ok: true,
        country,
        region,
        company,
        poe,
        types,
        options: types,
        dbCount: dbids.length,
      });
    } catch (e) {
      console.error(
        "GET /api/cargo-types/by-partner error:",
        e.response?.data || e
      );
      return res.status(500).json({
        ok: false,
        error: "cargo-types-by-partner failed",
        details: e.response?.data || e.message || String(e),
      });
    }
  });
}

module.exports = registerDestinationRoutes;
