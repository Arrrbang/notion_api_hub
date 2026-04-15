// api/destination/poe-costs.js
const axios = require("axios");

const TARGET_DB_ID = "3420b10191ce80c2a864d2e33aa87b05";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// [1] 프론트엔드 입력값 -> 노션 POE 매핑 JSON
// 필요에 따라 추가/수정해서 사용하시면 됩니다.
const poeMapping = {
  "LA": "USLAX",
  "NEW YORK": "USNYC",
  "LONG BEACH": "USLGB",
  "CHICAGO": "USCHI",
  "SEATTLE": "USSEA"
};

// ───────────────────────── 공통 유틸 ─────────────────────────

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

// 롤업 속성(Number) 추출기 (원본 표시 vs 계산 값 모두 대응)
function getRollupNumber(prop) {
  if (!prop || prop.type !== "rollup" || !prop.rollup) return null;
  const r = prop.rollup;
  if (r.type === "number") return r.number;
  if (r.type === "array" && r.array.length > 0) {
    const first = r.array[0];
    if (first.type === "number") return first.number;
  }
  return null;
}

// 롤업 속성(Date) 추출기
function getRollupDate(prop) {
  if (!prop || prop.type !== "rollup" || !prop.rollup) return null;
  const r = prop.rollup;
  if (r.type === "date" && r.date) return { start: r.date.start, end: r.date.end };
  if (r.type === "array" && r.array.length > 0) {
    const first = r.array[0];
    if (first.type === "date" && first.date) return { start: first.date.start, end: first.date.end };
  }
  return null;
}

// 다중 선택(Multi-select) 값 배열 추출기
function getMultiSelectNames(prop) {
  if (!prop || prop.type !== "multi_select" || !prop.multi_select) return [];
  return prop.multi_select.map(item => item.name);
}

// ───────────────────────── 라우트 등록 ─────────────────────────

module.exports = function registerPoeCostsRoutes(app) {
  
  app.get("/api/destination/poe-costs", async (req, res) => {
    try {
      const frontPoe = (req.query.poe || "").trim().toUpperCase();

      if (!frontPoe) {
        return res.status(400).json({ ok: false, error: "POE를 입력하세요. (예: LA)" });
      }

      // [2] 매핑된 값 찾기 (없으면 입력값 그대로 사용)
      const targetPoe = poeMapping[frontPoe] || frontPoe;

      // [3] 노션 쿼리 필터: POE 다중 선택 속성에 targetPoe가 포함(contains)되어 있는지 확인
      const body = {
        filter: {
          property: "POE",
          multi_select: {
            contains: targetPoe
          }
        }
      };

      const resp = await axios.post(
        `https://api.notion.com/v1/databases/${TARGET_DB_ID}/query`,
        body,
        { headers: notionHeaders() }
      );

      const results = resp.data.results || [];
      
      if (!results.length) {
        return res.status(404).json({
          ok: false,
          error: `매핑된 POE(${targetPoe})에 해당하는 데이터를 찾을 수 없습니다.`
        });
      }

      // [4] 데이터 정제
      // 다중 선택 속성 특성상 여러 개가 조회될 수 있으므로 배열 형태로 반환합니다.
      const parsedData = results.map(page => {
        const props = page.properties;

        return {
          id: page.id,
          poeList: getMultiSelectNames(props["POE"]),
          cost20DR: getRollupNumber(props["20DR"]),
          cost40HC: getRollupNumber(props["40HC"]),
          validity: getRollupDate(props["VALIDITY"]),
          remarks: richTextToPlain(props["특이사항"]?.rich_text || [])
        };
      });

      return res.json({
        ok: true,
        input: { frontPoe, targetPoe },
        data: parsedData
      });

    } catch (e) {
      console.error("poe-costs error:", e.response?.data || e.message);
      res.status(500).json({
        ok: false,
        error: "노션 데이터베이스 조회 중 오류가 발생했습니다.",
        details: e.response?.data || e.message || String(e)
      });
    }
  });
};
