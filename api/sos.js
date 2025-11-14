// api/sos.js
// "SOS" 요금 조회 전용 라우트
// DB: 2ab0b10191ce80b1994edd40afd32280

const axios = require("axios");

const SOS_DB_ID = "2ab0b10191ce80b1994edd40afd32280";

// 환경변수에서 다시 읽어옴 (index.js와 동일한 방식)
const NOTION_TOKEN      = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);

// Nager.Date 공휴일 캐시 (연도별)
const holidayCache = {}; // { [year]: Set<'YYYY-MM-DD'> }

// ───────────────────────── 공통 유틸 ─────────────────────────

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

function setCache(res) {
  if (CACHE_TTL_SECONDS > 0) {
    res.setHeader(
      "Cache-Control",
      `public, max-age=${CACHE_TTL_SECONDS}, stale-while-revalidate=86400`
    );
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
}

// rich_text → 단순 텍스트
function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

// 한국 공휴일 여부 확인 (Nager.Date)
async function isKoreanHoliday(dateStr) {
  const year = dateStr.slice(0, 4);
  if (!holidayCache[year]) {
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/KR`;
    const resp = await axios.get(url);
    const set = new Set(resp.data.map(h => h.date)); // "YYYY-MM-DD"
    holidayCache[year] = set;
  }
  return holidayCache[year].has(dateStr);
}

// 적용일(date range)이 선택 날짜를 포함하는지 확인
function dateRangeContains(dateProp, targetDateStr) {
  if (!dateProp || dateProp.type !== "date" || !dateProp.date) return false;
  const start = dateProp.date.start;               // "YYYY-MM-DD"
  const end   = dateProp.date.end || dateProp.date.start;
  if (!start) return false;
  return (targetDateStr >= start && targetDateStr <= end);
}

// 요일(한국 시간 기준) - 토/일이면 true
function isWeekendKST(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d)); // UTC 기준 캘린더 날짜
  const day = dt.getUTCDay();                 // 0=일, 6=토
  return day === 0 || day === 6;
}


// ───────────────────────── 라우트 등록 ─────────────────────────

module.exports = function registerSosRoutes(app) {

  /**
   * GET /api/sos-rate?date=2020-10-01&type=CONSOLE&cbm=25
   *
   * 1) date       : YYYY-MM-DD
   * 2) type       : CONSOLE / 20DRY / 40HC
   * 3) cbm        : 1~60 정수
   */
  app.get("/api/sos-rate", async (req, res) => {
    try {
      const dateStr = (req.query.date || "").trim();   // "2020-10-01"
      const typeStr = (req.query.type || "").trim().toUpperCase(); // CONSOLE/20DRY/40HC
      const cbmStr  = (req.query.cbm  || "").trim();

      if (!dateStr) return res.status(400).json({ ok:false, error:"date(YYYY-MM-DD) 쿼리 필요" });
      if (!typeStr) return res.status(400).json({ ok:false, error:"type(CONSOLE/20DRY/40HC) 쿼리 필요" });
      if (!cbmStr)  return res.status(400).json({ ok:false, error:"cbm(1~60) 쿼리 필요" });

      const cbm = Number(cbmStr);
      if (!Number.isInteger(cbm) || cbm < 1 || cbm > 60) {
        return res.status(400).json({ ok:false, error:"cbm 은 1~60 사이의 정수여야 합니다." });
      }

      // 타입 매핑: 프론트 → 노션
      const typeMap = {
        "CONSOLE": "GRP",
        "20DRY"  : "20",
        "40HC"   : "40"
      };
      const notionType = typeMap[typeStr];
      if (!notionType) {
        return res.status(400).json({ ok:false, error:"type 은 CONSOLE / 20DRY / 40HC 중 하나여야 합니다." });
      }

      // 한국 주말/공휴일 판정
      const weekend  = isWeekendKST(dateStr);
      const holiday  = await isKoreanHoliday(dateStr);
      const isOffDay = weekend || holiday;
      const weekdayType = isOffDay ? "주말" : "주중";

      // 노션에서 타입 + 주중/주말 필터로 1차 조회
      const body = {
        page_size: 100,
        filter: {
          and: [
            { property: "타입",      select: { equals: notionType } },
            { property: "주중/주말", select: { equals: weekdayType } }
          ]
        }
      };

      const resp = await axios.post(
        `https://api.notion.com/v1/databases/${SOS_DB_ID}/query`,
        body,
        { headers: notionHeaders() }
      );

      const results = resp.data.results || [];
      if (!results.length) {
        return res.status(404).json({
          ok:false,
          error:`조건에 맞는 페이지가 없습니다. (타입=${notionType}, 주중/주말=${weekdayType})`
        });
      }

      // 적용일 범위에 dateStr 이 들어가는 행만 추리기
      const candidates = results.filter(page =>
        dateRangeContains(page.properties["적용일"], dateStr)
      );

      if (!candidates.length) {
        return res.status(404).json({
          ok:false,
          error:`해당 날짜(${dateStr})가 포함된 '적용일' 행이 없습니다.`
        });
      }

      // 여러 개면 시작일이 가장 최신인 행을 선택
      candidates.sort((a, b) => {
        const da = a.properties["적용일"]?.date?.start || "";
        const db = b.properties["적용일"]?.date?.start || "";
        return db.localeCompare(da); // 최신(start 큰 것) 우선
      });
      const page = candidates[0];
      const props = page.properties || {};

      // CBM 컬럼에서 값 추출 (1~60 숫자 속성)
      const colKey = String(cbm);
      const col = props[colKey];
      let value = null;
      if (col) {
        if (col.type === "number")   value = col.number;
        else if (col.type === "formula" && col.formula)
          value = col.formula[col.formula.type] ?? null;
        else if (col.type === "rich_text")
          value = Number(richTextToPlain(col.rich_text)) || null;
      }

      const extra   = richTextToPlain(props["추가"]?.rich_text || []);
      const name    = richTextToPlain(props["이름"]?.title || []);
      const dateObj = props["적용일"]?.date || null;

      setCache(res);
      return res.json({
        ok: true,
        input: {
          date: dateStr,
          type: typeStr,
          cbm,
          weekdayType,
          isWeekend: weekend,
          isHoliday: holiday
        },
        match: {
          pageId: page.id,
          name,
          appliedStart: dateObj?.start || null,
          appliedEnd  : dateObj?.end   || dateObj?.start || null,
          notionType,
          weekdayType,
          cbmColumn: colKey,
          value,
          extra
        }
      });
    } catch (e) {
      console.error("sos-rate error:", e.response?.data || e);
      res.status(500).json({
        ok:false,
        error:"sos-rate failed",
        details: e.message || String(e)
      });
    }
  });
};
