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
}

module.exports = registerDestinationRoutes;
