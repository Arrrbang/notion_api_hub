// core/notion-config.js (예시 파일명)
// 노션 토큰/속성명/DB맵 관련 공통 유틸

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

/* ─────────────────────────────────────────────────────────
   ENV / 상수
────────────────────────────────────────────────────────── */

// Notion 토큰
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 캐시 TTL (나중에 라우트에서 쓸 거면 그대로 두고, 쓰지 않을 거면 제거해도 됨)
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);

// 👉 제목: "항목명"
const TITLE_PROP        = process.env.TITLE_PROP        || "항목명";

// 기존 속성들 (프론트/노션 구조 유지용)
const REGION_PROP       = process.env.REGION_PROP       || "지역";      // multi_select
const COMPANY_PROP      = process.env.COMPANY_PROP      || "업체";      // select
const POE_PROP          = process.env.POE_PROP          || "POE";       // multi_select
const DIPLO_PROP        = process.env.DIPLO_PROP        || "화물타입";   // multi_select
const EXTRA_TEXT_PROP   = process.env.EXTRA_TEXT_PROP   || "추가내용";   // rich_text
const ORDER_PROP        = process.env.ORDER_PROP        || "순서";       // number
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP      || "MIN CBM";
const PER_CBM_PROP      = process.env.PER_CBM_PROP      || "PER CBM";
const MIN_COST_PROP     = process.env.MIN_COST_PROP     || "MIN COST";

// 새 속성
const BASIC_EXTRA_PROP  = process.env.BASIC_EXTRA_PROP  || "기본/추가"; // select
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || "표시타입";  // select

/* ─────────────────────────────────────────────────────────
   파일 로드 / db-map 유틸
────────────────────────────────────────────────────────── */

// 프로젝트 루트 기준 상대경로 JSON 로드
function safeLoadJson(relPathFromRoot) {
  try {
    const full = path.join(process.cwd(), relPathFromRoot);
    return JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (e) {
    return { __error: e.message, __path: relPathFromRoot };
  }
}

// 원본 db-map 전체 객체 가져오기
// - 환경변수 DB_MAP_JSON 있으면 그걸 우선 사용
// - 없으면 config/db-map.json 파일 로드
function getDbMapRaw() {
  if (process.env.DB_MAP_JSON) {
    try { 
      return JSON.parse(process.env.DB_MAP_JSON);
    } catch {} // 파싱 실패시 파일에서 다시 시도
  }
  const j = safeLoadJson("config/db-map.json");
  if (j.__error) {
    throw new Error(`db-map.json load failed (${j.__path}): ${j.__error}`);
  }
  return j;
}

// ✅ 국가 이름 → DB id 배열 (문자열/배열/레거시 객체 모두 지원)
function getCountryDbIds(country) {
  const dbmap = getDbMapRaw();
  const v = dbmap?.[country];
  if (!v) return [];

  // "미국": "xxxxxxxx" 형태
  if (typeof v === "string") return [v].filter(Boolean);

  // "미국": ["xx", "yy"] 형태
  if (Array.isArray(v))      return v.filter(Boolean);

  // 레거시 객체 형태: { __db, _db, dbId, dbIds, __dbs }
  if (typeof v === "object") {
    const picks = [];
    if (typeof v.__db  === "string") picks.push(v.__db);
    if (typeof v._db   === "string") picks.push(v._db);
    if (typeof v.dbId  === "string") picks.push(v.dbId);
    if (Array.isArray(v.dbIds))  picks.push(...v.dbIds);
    if (Array.isArray(v.__dbs))  picks.push(...v.__dbs);
    return picks.filter(Boolean);
  }
  return [];
}

/* ─────────────────────────────────────────────────────────
   Notion 공통 유틸
────────────────────────────────────────────────────────── */

// Notion API 호출용 공통 헤더
function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  }
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// (옵션) 캐시 헤더 세팅 – 나중에 라우트에서 사용
function setCache(res) {
  res.setHeader(
    "Cache-Control",
    `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`
  );
}

module.exports = {
  axios,

  // env 상태
  NOTION_TOKEN_PRESENT: Boolean(NOTION_TOKEN),
  NOTION_TOKEN,

  // 속성명 상수
  TITLE_PROP,
  REGION_PROP,
  COMPANY_PROP,
  POE_PROP,
  DIPLO_PROP,
  EXTRA_TEXT_PROP,
  ORDER_PROP,
  MIN_CBM_PROP,
  PER_CBM_PROP,
  MIN_COST_PROP,
  BASIC_EXTRA_PROP,
  DISPLAY_TYPE_PROP,

  // 유틸
  getDbMapRaw,
  getCountryDbIds,
  notionHeaders,
  setCache
};
