// api/destination.js
// 도착지 비용 계산용 공통 라우트 (국가/지역 드롭다운)

// 외부 모듈
const fs    = require("fs");
const path  = require("path");
const axios = require("axios");

// Notion 토큰 + 속성명
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const REGION_PROP  = process.env.REGION_PROP || "지역";   // 노션에서 "지역" multi_select 속성명

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
 * - "임시": ["..."], "미국": ["...","..."] 형식 지원 :contentReference[oaicite:3]{index=3}
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

// ────────────────────────────────
// 메인: 라우트 등록 함수
// ────────────────────────────────

function registerDestinationRoutes(app) {
  /**
   * GET /api/debug/config
   *
   * - 국가 드롭다운용
   * - 프론트에서는 j.countries 또는 j.dbStructure를 사용함 :contentReference[oaicite:4]{index=4}
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
   * - 프론트: /api/regions/${country} 응답의 j.regions 사용 :contentReference[oaicite:5]{index=5}
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
      // 선택된 국가에 DB가 없으면 빈 리스트 반환
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

      // 각 DB별로 query 호출해서 "지역" multi_select 값 수집
      for (const dbId of dbIds) {
        const body = {
          page_size: 100, // 필요하면 나중에 pagination 추가 가능
        };

        const resp = await axios.post(
          `https://api.notion.com/v1/databases/${dbId}/query`,
          body,
          { headers: notionHeaders() }
        );

        const results = resp.data?.results || [];
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

  // 지역 → 업체 (중복 제거, 실제 데이터 기준 / REGION: multi_select)
  app.get("/api/companies/by-region", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      if (!country || !region) {
        return res.status(400).json({ ok:false, error:"country and region are required" });
      }
  
      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok:true, country, region, companies: [], options: [] });
      }
  
      const body = {
        page_size: 100,
        // 🔹 REGION 이 multi_select 이므로 multi_select.contains 사용
        filter: {
          property: REGION_PROP,
          multi_select: { contains: region }
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };
  
      const results = await queryAllDatabases(dbids, body);
  
      const companies = uniq(
        results.map(p => getSelectName(p.properties, COMPANY_PROP)).filter(Boolean)
      ).sort((a, b) => a.localeCompare(b, "ko"));
  
      setCache(res);
      // unified-partners.js 에서 j.companies 또는 j.options 둘 다 볼 수 있게 options도 같이 반환
      res.json({
        ok: true,
        country,
        region,
        companies,
        options: companies,
        dbCount: dbids.length
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "companies-by-region failed",
        details: e.message || String(e)
      });
    }
  });
  
  // 지역 → POE (중복 제거, REGION: multi_select)
  app.get("/api/poe/by-region", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      if (!country || !region) {
        return res.status(400).json({ ok:false, error:"country and region are required" });
      }
  
      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok:true, country, region, poes: [], options: [] });
      }
  
      const body = {
        page_size: 100,
        filter: {
          property: REGION_PROP,
          multi_select: { contains: region }
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };
  
      const results = await queryAllDatabases(dbids, body);
  
      const poes = uniq(
        results.map(p => getSelectName(p.properties, POE_PROP)).filter(Boolean)
      ).sort((a, b) => a.localeCompare(b, "ko"));
  
      setCache(res);
      res.json({
        ok: true,
        country,
        region,
        poes,
        options: poes,
        dbCount: dbids.length
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "poe-by-region failed",
        details: e.message || String(e)
      });
    }
  });
  
  // 업체+지역 → POE (중복 제거, REGION: multi_select)
  app.get("/api/poe/by-company", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      const company = (req.query.company || "").trim();
      if (!country || !region || !company) {
        return res.status(400).json({
          ok:false,
          error:"country, region, company are required"
        });
      }
  
      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok:true, country, region, company, poes: [], options: [] });
      }
  
      const body = {
        page_size: 100,
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
  
      const results = await queryAllDatabases(dbids, body);
  
      const poes = uniq(
        results.map(p => getSelectName(p.properties, POE_PROP)).filter(Boolean)
      ).sort((a, b) => a.localeCompare(b, "ko"));
  
      setCache(res);
      res.json({
        ok: true,
        country,
        region,
        company,
        poes,
        options: poes,
        dbCount: dbids.length
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "poe-by-company failed",
        details: e.message || String(e)
      });
    }
  });
  
  // 화물타입 목록: 업체(필수) [+ 선택 지역] → multi_select "화물타입" 기준 distinct
  app.get("/api/cargo-types/by-partner", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim(); // 선택
      const company = (req.query.company || "").trim();
      if (!country || !company) {
        return res.status(400).json({ ok:false, error:"country and company are required" });
      }
  
      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok:true, country, types: [], options: [] });
      }
  
      const andFilters = [
        { property: COMPANY_PROP, select: { equals: company } }
      ];
      if (region) {
        andFilters.push({
          property: REGION_PROP,
          multi_select: { contains: region }
        });
      }
  
      const body = {
        page_size: 100,
        filter: (andFilters.length === 1 ? andFilters[0] : { and: andFilters }),
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };
  
      const results = await queryAllDatabases(dbids, body);
  
      const types = uniq(
        results.flatMap(p => getMultiSelectNames(p.properties, DIPLO_PROP))
      ).sort((a, b) => a.localeCompare(b, "ko"));
  
      setCache(res);
      res.json({
        ok: true,
        country,
        region: region || null,
        company,
        types,
        options: types,
        dbCount: dbids.length
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "cargo-types-by-partner failed",
        details: e.message || String(e)
      });
    }
  });

}

module.exports = registerDestinationRoutes;
