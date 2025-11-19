// api/destination.js
// 도착지 비용(DESTINATION) 관련 공용 유틸 + 라우트 모듈

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

/* ─────────────────────────────────────────────────────────
   ENV / 상수 (필요시 Vercel 환경변수로 오버라이드 가능)
────────────────────────────────────────────────────────── */

// Notion 토큰 / 캐시
const NOTION_TOKEN      = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);

// 👉 제목: "항목명" 으로 변경 (없으면 환경변수 TITLE_PROP로 지정 가능)
const TITLE_PROP        = process.env.TITLE_PROP        || "항목명";

// 기존 속성
const REGION_PROP       = process.env.REGION_PROP       || "지역";      // multi_select (혹은 select)
const COMPANY_PROP      = process.env.COMPANY_PROP      || "업체";      // select
const POE_PROP          = process.env.POE_PROP          || "POE";       // multi_select
const DIPLO_PROP        = process.env.DIPLO_PROP        || "화물타입";   // multi_select
const EXTRA_TEXT_PROP   = process.env.EXTRA_TEXT_PROP   || "추가내용";   // rich_text
const ORDER_PROP        = process.env.ORDER_PROP        || "순서";       // number
const MIN_CBM_PROP      = process.env.MIN_CBM_PROP      || "MIN CBM";
const PER_CBM_PROP      = process.env.PER_CBM_PROP      || "PER CBM";
const MIN_COST_PROP     = process.env.MIN_COST_PROP     || "MIN COST";

// 🔹 새 속성
// 1) 단일 선택: "기본/추가"
const BASIC_EXTRA_PROP  = process.env.BASIC_EXTRA_PROP  || "기본/추가"; // select (기본 | 추가)
// 2) 단일 선택: "표시타입"
const DISPLAY_TYPE_PROP = process.env.DISPLAY_TYPE_PROP || "표시타입";  // select (테이블 | 기타내용)

/* ─────────────────────────────────────────────────────────
   파일 로드 / allowed-types / db-map 유틸
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
  if (j.__error) {
    throw new Error(`allowed-types.json load failed (${j.__path}): ${j.__error}`);
  }
  return j;
}

function getDbMapRaw() {
  if (process.env.DB_MAP_JSON) {
    try { return JSON.parse(process.env.DB_MAP_JSON); } catch {}
  }
  const j = safeLoadJson("config/db-map.json");
  if (j.__error) {
    throw new Error(`db-map.json load failed (${j.__path}): ${j.__error}`);
  }
  return j;
}

// ✅ 국가 → DB id 배열 (문자열 / 배열 / 레거시 객체 모두 지원)
function getCountryDbIds(country) {
  const dbmap = getDbMapRaw();
  const v = dbmap?.[country];
  if (!v) return [];

  if (typeof v === "string") return [v].filter(Boolean);
  if (Array.isArray(v))      return v.filter(Boolean);

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

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

function mergeNumberFormats(base = {}, add = {}) {
  return { ...base, ...add };
}

function setCache(res) {
  res.setHeader(
    "Cache-Control",
    `s-maxage=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`
  );
}

// 여러 DB 메타의 numberFormat 병합
async function fetchMergedNumberFormats(dbids) {
  let formats = {};
  for (const dbid of dbids) {
    const meta = await axios.get(
      `https://api.notion.com/v1/databases/${dbid}`,
      { headers: notionHeaders() }
    );
    formats = mergeNumberFormats(formats, extractNumberFormats(meta));
  }
  return formats;
}

// 여러 DB를 같은 body로 query해서 results 합치기
async function queryAllDatabases(dbids, body) {
  const calls = dbids.map(dbid =>
    axios
      .post(
        `https://api.notion.com/v1/databases/${dbid}/query`,
        body,
        { headers: notionHeaders() }
      )
      .then(r => r.data?.results || [])
      .catch(() => [])
  );
  const chunks = await Promise.all(calls);
  return chunks.flat();
}

/* ─────────────────────────────────────────────────────────
   Notion 값 파싱 헬퍼
────────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

function notionRichToHtml(richTexts = []) {
  return richTexts
    .map(rt => {
      let t = escapeHtml(rt.text?.content || "").replace(/\n/g, "<br>");
      const ann = rt.annotations || {};
      if (ann.bold)          t = `<b>${t}</b>`;
      if (ann.italic)        t = `<i>${t}</i>`;
      if (ann.underline)     t = `<u>${t}</u>`;
      if (ann.strikethrough) t = `<s>${t}</s>`;
      if (ann.code)          t = `<code>${t}</code>`;
      if (ann.color && ann.color !== "default") {
        t = `<span style="color:${ann.color}">${t}</span>`;
      }
      if (rt.text?.link?.url) {
        t = `<a href="${rt.text.link.url}" target="_blank" rel="noopener noreferrer">${t}</a>`;
      }
      return t;
    })
    .join("");
}

const pickNumber = (v) =>
  v == null
    ? null
    : typeof v === "number"
    ? v
    : (Number.isFinite(+v) ? +v : v);

function extractTitle(properties) {
  const p = properties?.[TITLE_PROP];
  if (!p || p.type !== "title") return null;
  const text = (p.title || [])
    .map(t => t.plain_text || "")
    .join("")
    .trim();
  return text || null;
}

function valueFromColumn(properties, columnName) {
  const col = properties[columnName];
  if (!col) return null;
  switch (col.type) {
    case "number":    return pickNumber(col.number);
    case "rich_text": return (col.rich_text || [])
      .map(t => t.plain_text || "")
      .join("")
      .trim() || null;
    case "formula":   return pickNumber(col.formula?.[col.formula?.type] ?? null);
    default:          return null;
  }
}

const getSelectName = (props, key) =>
  (props?.[key]?.type === "select" ? (props[key].select?.name || null) : null);

const getMultiSelectNames = (props, key) => {
  const p = props?.[key];
  if (!p) return [];
  if (p.type === "multi_select") {
    return (p.multi_select || []).map(o => o.name).filter(Boolean);
  }
  if (p.type === "select") {
    return [p.select?.name].filter(Boolean);
  }
  return [];
};

function getSelectOrMultiNames(props, key) {
  const p = props?.[key];
  if (!p) return [];
  if (p.type === "select") {
    return [p.select?.name].filter(Boolean);
  }
  if (p.type === "multi_select") {
    return (p.multi_select || []).map(o => o.name).filter(Boolean);
  }
  return [];
}

function getRegionNames(props) {
  return getSelectOrMultiNames(props, REGION_PROP);
}

function getNumberProp(props, key) {
  const col = props?.[key];
  if (!col) return null;
  if (col.type === "number")  return pickNumber(col.number);
  if (col.type === "formula") return pickNumber(col.formula?.[col.formula?.type] ?? null);
  if (col.type === "rich_text") {
    const s = (col.rich_text || [])
      .map(t => t.plain_text || "")
      .join("")
      .trim();
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
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

// DB 메타에서 숫자 컬럼 포맷(dollar, won 등) 추출
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
   실제 라우트 등록 함수
────────────────────────────────────────────────────────── */

function registerDestinationRoutes(app) {
  /* ===========================
     Health / Debug
  ============================*/

  // Health
  app.get(["/", "/api/health"], (req, res) => {
    setCache(res);
    res.json({
      ok: true,
      name: "NOTION API HUB - DESTINATION",
      time: new Date().toISOString()
    });
  });

  // 설정/환경 확인
  app.get("/api/debug/config", async (req, res) => {
    try {
      const allowed  = getAllowed();
      const raw      = getDbMapRaw();
      const countries = Object.keys(raw);

      const firstCountry = countries[0] || null;
      let companiesPreview = [];
      let numberFormats = {};

      if (firstCountry) {
        const dbids = getCountryDbIds(firstCountry);
        if (dbids.length > 0) {
          const meta = await axios.get(
            `https://api.notion.com/v1/databases/${dbids[0]}`,
            { headers: notionHeaders() }
          );
          const prop = meta.data.properties?.[COMPANY_PROP];
          companiesPreview = (
            prop?.type === "select"
              ? (prop.select?.options || []).map(o => o.name)
              : []
          );
          numberFormats = extractNumberFormats(meta);
        }
      }

      setCache(res);
      res.json({
        ok: true,
        env: { NOTION_TOKEN_PRESENT: Boolean(NOTION_TOKEN) },
        allowedTypes: allowed,
        dbStructure: raw,
        countries,
        companiesPreview,
        props: {
          TITLE_PROP,
          REGION_PROP,
          COMPANY_PROP,
          POE_PROP,
          DIPLO_PROP,
          EXTRA_TEXT_PROP,
          ORDER_PROP,
          BASIC_EXTRA_PROP,
          DISPLAY_TYPE_PROP
        },
        numberFormatsPreview: numberFormats
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ===========================
     컬럼(속성) 목록
  ============================*/

  app.get("/api/notion/list-columns", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      if (!country) {
        return res.status(400).json({ ok: false, error: "country is required" });
      }

      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.status(404).json({ ok: false, error: `Unknown country: ${country}` });
      }

      // 대표 스키마: 첫 번째 DB
      const meta0   = await axios.get(
        `https://api.notion.com/v1/databases/${dbids[0]}`,
        { headers: notionHeaders() }
      );
      const columns = Object.keys(meta0.data.properties || {});
      let numberFormats = extractNumberFormats(meta0);

      // 나머지 DB들 포맷 병합
      for (let i = 1; i < dbids.length; i++) {
        const metai = await axios.get(
          `https://api.notion.com/v1/databases/${dbids[i]}`,
          { headers: notionHeaders() }
        );
        numberFormats = mergeNumberFormats(
          numberFormats,
          extractNumberFormats(metai)
        );
      }

      setCache(res);
      res.json({
        ok: true,
        country,
        columns,
        numberFormats,
        dbCount: dbids.length
      });
    } catch (e) {
      const details = e.response?.data || e.message || e.toString();
      res.status(500).json({ ok: false, error: "list-columns failed", details });
    }
  });

  /* ===========================
     비용 조회 /api/costs/:country
     - 새 속성:
       BASIC_EXTRA_PROP("기본/추가")
       DISPLAY_TYPE_PROP("표시타입": "테이블" | "기타내용")
     - 결과를 기본표 / 추가표 / 기타내용표로 그룹핑
  ============================*/

  app.get("/api/costs/:country", async (req, res) => {
    try {
      const country = req.params.country;
      const allowed = getAllowed();

      const typeParam = (req.query.type || "").trim();
      const region    = (req.query.region || req.query.pick || req.query.select || "").trim();
      const company   = (req.query.company || "").trim();
      const rolesStr  = (req.query.roles || req.query.role || req.query.diplomat || "").trim();
      const poe       = (req.query.poe || "").trim();
      const roles     = rolesStr
        ? rolesStr.split(",").map(s => s.trim()).filter(Boolean)
        : [];
      const cbmQ      = Number(req.query.cbm);
      const cbm       = Number.isFinite(cbmQ) ? cbmQ : null;

      const type = typeParam || allowed[0];
      if (type !== "CONSOLE" && !allowed.includes(type)) {
        return res
          .status(400)
          .json({ ok: false, error: `Invalid type. Use one of: CONSOLE, ${allowed.join(", ")}` });
      }

      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res
          .status(404)
          .json({ ok: false, error: `Unknown country: ${country}` });
      }

      const numberFormats = await fetchMergedNumberFormats(dbids);

      // REGION 필터만 Notion 쿼리에 반영 (지역 공란도 허용)
      const andFilters = [];
      if (region) {
        andFilters.push({
          or: [
            { property: REGION_PROP, select: { equals: region } },
            { property: REGION_PROP, multi_select: { contains: region } },
            { property: REGION_PROP, select: { is_empty: true } },
            { property: REGION_PROP, multi_select: { is_empty: true } }
          ]
        });
      }

      const body = {
        page_size: 100,
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };
      if (andFilters.length === 1) body.filter = andFilters[0];
      else if (andFilters.length > 1) body.filter = { and: andFilters };

      const results = await queryAllDatabases(dbids, body);

      const rows = [];
      const seen = new Set();  // item + region 중복 방지

      const values = {};
      const extras = {};
      const valuesByRegion = {};
      const extrasByRegion = {};

      for (const page of results) {
        const props = page.properties || {};
        const itemName = extractTitle(props);
        if (!itemName) continue;

        // 지역
        const regionNames   = getRegionNames(props); // ["A"], ["A","B"], []
        const primaryRegion = regionNames[0] || null;

        // 업체
        const companyNames = getSelectOrMultiNames(props, COMPANY_PROP);

        // POE
        const poeNames = getSelectOrMultiNames(props, POE_PROP); // ["ATLANTA",...]

        // 화물타입
        const cargoTypes = getMultiSelectNames(props, DIPLO_PROP);

        // 새 속성: 기본/추가, 표시타입
        const basicExtra   = getSelectName(props, BASIC_EXTRA_PROP)  || "기본";
        const displayType  = getSelectName(props, DISPLAY_TYPE_PROP) || "테이블";

        // 추가내용
        const extraVal = notionRichToHtml(
          props[EXTRA_TEXT_PROP]?.rich_text || []
        );

        /* ── 필터링 규칙 ───────────────────────── */

        // 1) 업체 필터 : 선택된 company가 있는 경우, 해당 업체를 포함하는 행만
        if (company && !companyNames.includes(company)) {
          continue;
        }

        // 2) 지역 필터
        if (region) {
          // regionNames가 비어있으면(공통행) 무조건 허용
          if (regionNames.length > 0 && !regionNames.includes(region)) {
            continue;
          }
        }

        // 3) POE 필터
        if (poe && !poeNames.includes(poe)) {
          continue;
        }

        // 4) 화물타입 필터
        if (roles.length > 0 && !roles.some(r => cargoTypes.includes(r))) {
          continue;
        }

        // 5) 값 계산 로직 (CONSOLE/20FT/40HC)
        let numVal = (type === "CONSOLE") ? null : pickNumber(valueFromColumn(props, type));
        if (
          type === "CONSOLE" ||
          ((type === "20FT" || type === "40HC") && numVal == null && hasCbmTriplet(props))
        ) {
          numVal = computeConsoleCost(props, cbm);
        }

        // 한 줄 결과 객체
        const rowObj = {
          item:   itemName,
          region: primaryRegion,
          poe:    poeNames.join(", "),
          extra:  extraVal,
          basicExtra,
          displayType,
          companyNames,
          cargoTypes
        };

        // allowed 타입별 값 + CBM 관련 값
        for (const key of allowed) {
          rowObj[key] = pickNumber(valueFromColumn(props, key));
        }
        rowObj["MIN CBM"]  = getNumberProp(props, MIN_CBM_PROP);
        rowObj["PER CBM"]  = getNumberProp(props, PER_CBM_PROP);
        rowObj["MIN COST"] = getNumberProp(props, MIN_COST_PROP);
        rowObj[type]       = numVal;
        rowObj[ORDER_PROP] = getNumberProp(props, ORDER_PROP);

        // 중복 방지: 같은 item + 같은 region 는 1번만
        const dedupKey = `${itemName}__${primaryRegion || "기타"}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          rows.push(rowObj);
        }

        // values/extras 구조 (기존 요약용 – displayType과 상관없이 유지)
        if (region) {
          if (!primaryRegion || primaryRegion === region) {
            values[itemName] = numVal;
            extras[itemName] = extraVal ?? null;
          }
        } else {
          const key = primaryRegion || "기타";
          if (!valuesByRegion[key]) valuesByRegion[key] = {};
          if (!extrasByRegion[key]) extrasByRegion[key] = {};
          valuesByRegion[key][itemName] = numVal;
          extrasByRegion[key][itemName] = extraVal ?? null;
        }
      }

      // 순서 정렬
      rows.sort((a, b) => {
        const ao = a[ORDER_PROP] ?? 0;
        const bo = b[ORDER_PROP] ?? 0;
        return ao - bo;
      });

      // 🔹 그룹핑
      const baseTableRows = rows.filter(
        r => r.displayType === "테이블" && r.basicExtra === "기본"
      );
      const extraTableRows = rows.filter(
        r => r.displayType === "테이블" && r.basicExtra === "추가"
      );
      const miscContentRows = rows
        .filter(r => r.displayType && r.displayType !== "테이블")
        .map(r => ({
          item:       r.item,
          extra:      r.extra,
          region:     r.region,
          poe:        r.poe,
          basicExtra: r.basicExtra,
          displayType:r.displayType,
          order:      r[ORDER_PROP]
        }));

      // 디버그 플래그
      const debugFlag = (req.query.debug || "").toString().toLowerCase();
      const debugOn   = ["1", "true", "yes", "y"].includes(debugFlag);

      setCache(res);

      const payload = {
        ok: true,
        country,
        type,
        dbCount: dbids.length,
        filters: {
          region:  region || null,
          company: company || null,
          poe:     poe || null,
          roles:   roles.length ? roles : null,
          cbm
        },
        numberFormats,
        // 기존 요약 구조
        ...(region
          ? { values, extras }
          : { valuesByRegion, extrasByRegion }),
        // 전체 raw rows (프론트에서 필요하면 그대로 사용)
        rows,
        // 새 그룹 구조
        grouped: {
          baseTable: baseTableRows,
          extraTable: extraTableRows,
          miscContent: miscContentRows
        },
        servedAt: new Date().toISOString()
      };

      if (debugOn) {
        payload.debug = {
          totalRows: rows.length,
          baseTableCount: baseTableRows.length,
          extraTableCount: extraTableRows.length,
          miscContentCount: miscContentRows.length
        };
      }

      res.json(payload);
    } catch (e) {
      const details = e.response?.data || e.message || e.toString();
      res.status(500).json({ ok: false, error: "costs failed", details });
    }
  });

  /* ===========================
     지역 / 업체 / POE / 화물타입
  ============================*/

  // 지역 목록
  app.get("/api/regions/:country", async (req, res) => {
    try {
      const country = req.params.country;
      const dbids   = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok: true, country, regions: [] });
      }

      let regions = [];
      for (const dbid of dbids) {
        const meta = await axios.get(
          `https://api.notion.com/v1/databases/${dbid}`,
          { headers: notionHeaders() }
        );
        const prop = meta.data.properties?.[REGION_PROP];
        let part = [];

        if (prop?.type === "select") {
          part = (prop.select?.options || [])
            .map(o => o.name)
            .filter(Boolean);
        } else if (prop?.type === "multi_select") {
          part = (prop.multi_select?.options || [])
            .map(o => o.name)
            .filter(Boolean);
        }
        regions = regions.concat(part);
      }
      regions = uniq(regions).sort((a, b) => a.localeCompare(b, "ko"));

      setCache(res);
      res.json({ ok: true, country, regions, dbCount: dbids.length });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "regions failed",
        details: e.message || String(e)
      });
    }
  });

   // 지역 → 업체
   app.get("/api/companies/by-region", async (req, res) => {
     try {
       const country = (req.query.country || "").trim();
       const region  = (req.query.region  || "").trim();
       if (!country || !region) {
         return res
           .status(400)
           .json({ ok: false, error: "country and region are required" });
       }
   
       const dbids = getCountryDbIds(country);
       if (dbids.length === 0) {
         return res.json({ ok: true, country, region, companies: [] });
       }
   
       // 🔹 지역 필터를 Notion 쿼리에 걸지 않고 전체를 가져온 뒤,
       //    JS에서 지역 필터링 (공통행 포함)으로 처리
       const body = {
         page_size: 100,
         sorts: [{ property: ORDER_PROP, direction: "ascending" }]
       };
   
       const results = await queryAllDatabases(dbids, body);
   
       // 🔹 지역 필터링
       //   - 지역이 비어 있는 행(공통행)은 항상 포함
       //   - 그 외에는 region을 포함하는 행만 포함
       const filtered = results.filter(page => {
         const props        = page.properties || {};
         const regionNames  = getRegionNames(props); // ["A"], ["A","B"], []
         if (regionNames.length === 0) return true;      // 공통행
         return regionNames.includes(region);            // 선택 지역이 포함된 행
       });
   
       const companies = uniq(
         filtered.flatMap(p => getSelectOrMultiNames(p.properties, COMPANY_PROP))
       ).sort((a, b) => a.localeCompare(b, "ko"));
   
       setCache(res);
       res.json({
         ok: true,
         country,
         region,
         companies,
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


  // 지역 → POE
  app.get("/api/poe/by-region", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim();
      if (!country || !region) {
        return res
          .status(400)
          .json({ ok: false, error: "country and region are required" });
      }

      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({ ok: true, country, region, poes: [] });
      }

      const body = {
        page_size: 100,
        filter: {
          or: [
            { property: REGION_PROP, select: { equals: region } },
            { property: REGION_PROP, multi_select: { contains: region } }
          ]
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };

      const results = await queryAllDatabases(dbids, body);

      const poes = uniq(
        results.flatMap(p => getSelectOrMultiNames(p.properties, POE_PROP))
      ).sort((a, b) => a.localeCompare(b, "ko"));

      setCache(res);
      res.json({
        ok: true,
        country,
        region,
        poes,
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

  // 업체+지역 → POE
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
        return res.json({
          ok: true,
          country,
          region,
          company,
          poes: [],
          dbCount: 0
        });
      }

      const body = {
        page_size: 100,
        filter: {
          and: [
            {
              or: [
                { property: REGION_PROP, select: { equals: region } },
                { property: REGION_PROP, multi_select: { contains: region } }
              ]
            },
            { property: COMPANY_PROP, select: { equals: company } }
          ]
        },
        sorts: [{ property: ORDER_PROP, direction: "ascending" }]
      };

      const results = await queryAllDatabases(dbids, body);

      const poes = uniq(
        results.flatMap(p => getSelectOrMultiNames(p.properties, POE_PROP))
      ).sort((a, b) => a.localeCompare(b, "ko"));

      setCache(res);
      res.json({
        ok: true,
        country,
        region,
        company,
        poes,
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

  // 화물타입 목록: 업체+지역(+POE) → 화물타입
  app.get("/api/cargo-types/by-partner", async (req, res) => {
    try {
      const country = (req.query.country || "").trim();
      const region  = (req.query.region  || "").trim(); // 선택
      const company = (req.query.company || "").trim();
      const poe     = (req.query.poe     || "").trim(); // 🔹 새로 추가: POE 필터

      if (!country || !company) {
        return res.status(400).json({
          ok: false,
          error: "country and company are required"
        });
      }

      const dbids = getCountryDbIds(country);
      if (dbids.length === 0) {
        return res.json({
          ok: true,
          country,
          region: region || null,
          company,
          poe: poe || null,
          types: [],
          dbCount: 0
        });
      }

      const andFilters = [
        { property: COMPANY_PROP, select: { equals: company } }
      ];

      // 지역이 선택된 경우: 선택 지역 + 공통행 포함
      if (region) {
        andFilters.push({
          or: [
            { property: REGION_PROP, select: { equals: region } },
            { property: REGION_PROP, multi_select: { contains: region } },
            { property: REGION_PROP, select: { is_empty: true } },
            { property: REGION_PROP, multi_select: { is_empty: true } }
          ]
        });
      }

      // 🔹 POE가 선택된 경우: 해당 POE를 포함하는 행만
      if (poe) {
        andFilters.push({
          or: [
            { property: POE_PROP, select: { equals: poe } },
            { property: POE_PROP, multi_select: { contains: poe } }
          ]
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
        poe: poe || null,
        types,
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
