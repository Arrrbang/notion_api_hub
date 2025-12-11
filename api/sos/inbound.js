// api/sos/inbound.js
const axios = require("axios");

const SOS_DB_ID = "2af0b10191ce8029a192ecd091a0eb09";

// 환경변수
const NOTION_TOKEN      = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 0);

// Nager.Date 공휴일 캐시
const holidayCache = {}; 

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

function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

async function isKoreanHoliday(dateStr) {
  const year = dateStr.slice(0, 4);
  if (!holidayCache[year]) {
    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/KR`;
    const resp = await axios.get(url);
    const set = new Set(resp.data.map(h => h.date));
    holidayCache[year] = set;
  }
  return holidayCache[year].has(dateStr);
}

function dateRangeContains(dateProp, targetDateStr) {
  if (!dateProp || dateProp.type !== "date" || !dateProp.date) return false;
  const start = dateProp.date.start;
  const end   = dateProp.date.end || dateProp.date.start;
  if (!start) return false;
  return (targetDateStr >= start && targetDateStr <= end);
}

function isWeekendKST(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay();
  return day === 0 || day === 6;
}


// ───────────────────────── 라우트 등록 ─────────────────────────

module.exports = function registerInboundSosRoutes(app) {

  app.get("/api/sos-rate/inbound", async (req, res) => {
    try {
      const dateStr = (req.query.date || "").trim();
      const typeStr = (req.query.type || "").trim().toUpperCase();
      const cbmStr  = (req.query.cbm  || "").trim();

      if (!dateStr) return res.status(400).json({ ok:false, error:"날짜를 선택하세요." });
      if (!typeStr) return res.status(400).json({ ok:false, error:"컨테이너 타입을 선택하세요." });
      if (!cbmStr)  return res.status(400).json({ ok:false, error:"CBM을 선택하세요" });

      const cbm = Number(cbmStr);
      if (Number.isNaN(cbm) || cbm < 1 || cbm > 80) {
        return res.status(400).json({ ok:false, error:"1~80cbm까지 조회가 가능합니다." });
      }

      const typeMap = {
        "CONSOLE": "GRP",
        "20DRY"  : "20",
        "40HC"   : "40"
      };
      const notionType = typeMap[typeStr];
      if (!notionType) {
        return res.status(400).json({ ok:false, error:"type 은 CONSOLE / 20DRY / 40HC 중 하나여야 합니다." });
      }

      const weekend  = isWeekendKST(dateStr);
      const holiday  = await isKoreanHoliday(dateStr);
      const isOffDay = weekend || holiday;
      const weekdayType = isOffDay ? "주말" : "주중";

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

      const candidates = results.filter(page =>
        dateRangeContains(page.properties["적용일"], dateStr)
      );

      if (!candidates.length) {
        return res.status(404).json({
          ok:false,
          error:`해당 날짜(${dateStr})가 포함된 '적용일' 행이 없습니다.`
        });
      }

      candidates.sort((a, b) => {
        const da = a.properties["적용일"]?.date?.start || "";
        const db = b.properties["적용일"]?.date?.start || "";
        return db.localeCompare(da);
      });
        
      const page = candidates[0];
      const props = page.properties || {};
        
      function getNumberFromProperty(p) {
        if (!p) return null;
        if (p.type === "number") return typeof p.number === "number" ? p.number : null;
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
        
      function getCbmColValue(n) {
        const key = String(n);
        const col = props[key];
        return getNumberFromProperty(col);
      }
        
      const addProp = props["추가"];
      const addPerCbm = getNumberFromProperty(addProp) || 0;
      
      let baseValue = null;
      let computedValue = null;
        
      if (notionType === "20") {
        const threshold = 28;
        if (cbm <= threshold) {
          baseValue = getCbmColValue(cbm);
          computedValue = baseValue;
        } else {
          baseValue = getCbmColValue(threshold);
          if (baseValue != null && addPerCbm) {
            const extraUnits = cbm - threshold;
            computedValue = baseValue + addPerCbm * extraUnits;
          } else {
            computedValue = null;
          }
        }
      } else {
        const threshold = 60;
        if (cbm <= threshold) {
          baseValue = getCbmColValue(cbm);
          computedValue = baseValue;
        } else {
          baseValue = getCbmColValue(threshold);
          if (baseValue != null && addPerCbm) {
            const extraUnits = cbm - threshold;
            computedValue = baseValue + addPerCbm * extraUnits;
          } else {
            computedValue = null;
          }
        }
      }

      let fractionalValue = null;
      const threshold = (notionType === "20") ? 28 : 60;
      
      if (!Number.isInteger(cbm)) {
        const floor = Math.floor(cbm);
        const ceil  = floor + 1;
        const decimal = cbm - floor;
      
        let vFloor, vCeil;
      
        if (cbm <= threshold) {
          vFloor = getCbmColValue(floor);
          vCeil  = getCbmColValue(ceil);
        } else {
          const baseAt = getCbmColValue(threshold);
          vFloor = baseAt + addPerCbm * (floor - threshold);
          vCeil  = baseAt + addPerCbm * (ceil  - threshold);
        }
      
        if (vFloor != null && vCeil != null) {
          fractionalValue = vFloor + (vCeil - vFloor) * decimal;
        }
      }

      const extra   = richTextToPlain(props["메모"]?.rich_text || []);
      const name    = richTextToPlain(props["이름"]?.title || []);
      
      // ▼▼▼ [추가] 특이사항 속성 가져오기 ▼▼▼
      const remarks = richTextToPlain(props["특이사항"]?.rich_text || []);
      // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

      const dateObj = props["적용일"]?.date || null;
      const value = (fractionalValue != null) ? fractionalValue : computedValue;
        
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
          extra,
          remarks
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
