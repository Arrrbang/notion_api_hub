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

module.exports = function registerOutboundSosRoutes(app) {

  /**
   * GET /api/sos-rate?date=2020-10-01&type=CONSOLE&cbm=25
   *
   * 1) date       : YYYY-MM-DD
   * 2) type       : CONSOLE / 20DRY / 40HC
   * 3) cbm        : 1~80 정수
   */
  app.get("/api/sos-rate/outbound", async (req, res) => {
    try {
      const dateStr = (req.query.date || "").trim();   // "2020-10-01"
      const typeStr = (req.query.type || "").trim().toUpperCase(); // CONSOLE/20DRY/40HC
      const cbmStr  = (req.query.cbm  || "").trim();

      if (!dateStr) return res.status(400).json({ ok:false, error:"날짜를 선택하세요." });
      if (!typeStr) return res.status(400).json({ ok:false, error:"컨테이너 타입을 선택하세요." });
      if (!cbmStr)  return res.status(400).json({ ok:false, error:"CBM을 선택하세요" });

      const cbm = Number(cbmStr);
      if (Number.isNaN(cbm) || cbm < 1 || cbm > 80) {
        return res.status(400).json({ ok:false, error:"1~80cbm까지 조회가 가능합니다." });
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
        
        // 숫자형/포뮬러/텍스트에서도 숫자를 뽑아오는 헬퍼
        function getNumberFromProperty(p) {
          if (!p) return null;
        
          if (p.type === "number") {
            return typeof p.number === "number" ? p.number : null;
          }
        
          if (p.type === "formula" && p.formula) {
            const f = p.formula;
            if (typeof f.number === "number") return f.number;
            if (typeof f[f.type] === "number") return f[f.type];
            if (typeof f.string === "string") {
              const n = Number(f.string.replace(/,/g, ""));
              return Number.isNaN(n) ? null : n;
            }
            return null;
          }
        
          if (p.type === "rich_text") {
            const txt = richTextToPlain(p.rich_text || []);
            if (!txt) return null;
            const n = Number(txt.replace(/,/g, ""));
            return Number.isNaN(n) ? null : n;
          }
        
          return null;
        }
        
        // 특정 CBM 숫자 컬럼에서 값 읽기
        function getCbmColValue(n) {
          const key = String(n);
          const col = props[key];
          return getNumberFromProperty(col);
        }
        
        // 🔹 "추가" 숫자 속성 (1cbm당 추가 단가) 읽기
        const addProp = props["추가"];
        const addPerCbm = getNumberFromProperty(addProp) || 0;
        
        // 🔹 타입별 기준 CBM 설정
        //   - GRP / 40 : 60cbm 초과분부터 "추가" 적용
        //   - 20       : 28cbm 초과분부터 "추가" 적용
        let baseValue = null;     // 기준값 (28 또는 60 열 값)
        let computedValue = null; // 최종 계산값
        
        if (notionType === "20") {
          const threshold = 28;
        
          if (cbm <= threshold) {
            // 1~28CBM은 노션 테이블 값 그대로 사용
            baseValue = getCbmColValue(cbm);
            computedValue = baseValue;
          } else {
            // 28CBM 열을 기준으로, 초과분마다 "추가" 단가를 더함
            baseValue = getCbmColValue(threshold);
            if (baseValue != null && addPerCbm) {
              const extraUnits = cbm - threshold;
              computedValue = baseValue + addPerCbm * extraUnits;
            } else {
              // 기준값이나 단가가 없으면 값 없음 처리
              computedValue = null;
            }
          }
        } else {
          // GRP / 40
          const threshold = 60;
        
          if (cbm <= threshold) {
            // 1~60CBM은 노션 테이블 값 그대로 사용
            baseValue = getCbmColValue(cbm);
            computedValue = baseValue;
          } else {
            // 60CBM 열을 기준으로, 초과분마다 "추가" 단가를 더함
            baseValue = getCbmColValue(threshold);
            if (baseValue != null && addPerCbm) {
              const extraUnits = cbm - threshold;
              computedValue = baseValue + addPerCbm * extraUnits;
            } else {
              computedValue = null;
            }
          }
        }
      
        // ─────────────────────────────────────────────
        // 🔹 fractional CBM 계산 (정확한 삽입 위치)
        //    → computedValue가 계산된 “바로 아래”
        // ─────────────────────────────────────────────

        const threshold = (notionType === "20") ? 28 : 60;
        let fractionalValue = null;

        if (!Number.isInteger(cbm)) {
          const floor = Math.floor(cbm);
          const ceil  = floor + 1;

          let vFloor, vCeil;

          // threshold 아래(1~28 또는 1~60) : 노션 테이블 값 사용
          if (cbm <= threshold) {
            vFloor = getCbmColValue(floor);
            vCeil  = getCbmColValue(ceil);
          }
          // threshold 위(예: 61.5 CBM) : threshold 값 + 추가단가 이용
          else {
            vFloor = baseValue + addPerCbm * (floor - threshold);
            vCeil  = baseValue + addPerCbm * (ceil  - threshold);
          }

          if (vFloor != null && vCeil != null) {
            const decimal = cbm - floor;  
            fractionalValue = vFloor + (vCeil - vFloor) * decimal;
          }
        }
        // ─────────────────────────────────────────────
        // fractional CBM 계산 끝
        // ───────────────────────────────────────────── 

      
        // 기존 extra/이름/적용일 처리 (메모용 rich_text가 따로 있다면 여기에 바인딩)
        const extra   = richTextToPlain(props["메모"]?.rich_text || []); // 필요시 속성명 조정
        const name    = richTextToPlain(props["이름"]?.title || []);
        const dateObj = props["적용일"]?.date || null;
        
        // 최종 value = "추가"까지 다 더해진 값
        let value = computedValue;
        if (!Number.isInteger(cbm) && fractionalValue != null) {
          value = fractionalValue;
        }
        
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
            cbmColumn: cbm <= 60 ? String(cbm) : (notionType === "20" ? "28" : "60"),
            baseValue,
            addPerCbm,
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
