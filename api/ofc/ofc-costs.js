// api/ofc/ofc-costs.js
const axios = require("axios");

// [1] 같은 경로(api/ofc/)에 있는 매핑 JSON 파일 불러오기
const poeMapping = require("./poe-mapping.json");

const TARGET_DB_ID = "3420b10191ce80c2a864d2e33aa87b05";
const EXTRA_DB_ID = "3450b10191ce803ca0a9e700df8af7b8";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// ───────────────────────── 공통 유틸 ─────────────────────────

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 텍스트 속성 추출기
function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

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

function getFormulaNumber(prop) {
  if (!prop || prop.type !== "formula" || !prop.formula) return null;
  const f = prop.formula;
  if (f.type === "number") return f.number;
  return null;
}

function getDateProperty(prop) {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return { start: prop.date.start, end: prop.date.end };
}

// 다중 선택(Multi-select) 값 배열 추출기
function getMultiSelectNames(prop) {
  if (!prop || prop.type !== "multi_select" || !prop.multi_select) return [];
  return prop.multi_select.map(item => item.name);
}

// ───────────────────────── 라우트 등록 ─────────────────────────

module.exports = function registerPoeCostsRoutes(app) {
  
  app.get("/api/ofc/ofc-costs", async (req, res) => {
    try {
      // 1. 프론트엔드에서 전달받은 POE 값 확인
      const frontPoe = (req.query.poe || "").trim().toUpperCase();

      if (!frontPoe) {
        return res.status(400).json({ ok: false, error: "POE를 입력하세요. (예: LA)" });
      }

      // 2. JSON 매핑 적용 (매핑 파일에 없으면 입력값 그대로 사용)
      const targetPoe = poeMapping[frontPoe] || frontPoe;

      // 3. 노션 쿼리 필터: POE 다중 선택 속성에 targetPoe가 포함(contains)되어 있는지 확인
      const body = {
        filter: {
          property: "POE",
          multi_select: {
            contains: targetPoe
          }
        }
      };

      // Promise.all을 사용하여 두 데이터베이스를 병렬로 동시 조회 (성능 최적화)
      const [ofcResp, extraResp] = await Promise.all([
        axios.post(`https://api.notion.com/v1/databases/${TARGET_DB_ID}/query`, filterBody, { headers: notionHeaders() }),
        axios.post(`https://api.notion.com/v1/databases/${EXTRA_DB_ID}/query`, filterBody, { headers: notionHeaders() })
      ]);

      const ofcResults = ofcResp.data.results || [];
      const extraResults = extraResp.data.results || [];
      
      // 두 DB 모두에서 데이터가 없을 경우에만 404 처리
      if (!ofcResults.length && !extraResults.length) {
        return res.status(404).json({
          ok: false,
          error: `매핑된 POE(${targetPoe})에 해당하는 데이터를 찾을 수 없습니다.`
        });
      }

      // 4. 데이터 정제 후 반환
      const parsedData = results.map(page => {
        const props = page.properties;

        return {
          id: page.id,
          poeList: getMultiSelectNames(props["POE"]),
          cost20DR: getFormulaNumber(props["20DR"]),
          cost40HC: getFormulaNumber(props["40HC"]),
          validity: getDateProperty(props["VALIDITY"]),
          remarks: richTextToPlain(props["특이사항"]?.rich_text || [])
        };
      });
      
      const parsedExtraCosts = extraResults.map(page => {
        const props = page.properties;

        return {
          id: page.id,
          // 노션의 이름(title) 속성도 rich_text와 구조가 같으므로 기존 유틸 활용 가능
          name: richTextToPlain(props["항목명"]?.title || []), 
          amount: props["금액"]?.number || 0
        };
      });

      // 프론트엔드로 두 개의 데이터 배열을 분리하여 전달
      return res.json({
        ok: true,
        input: { frontPoe, targetPoe },
        ofcData: parsedOfcData,       // 기존 메인 데이터
        extraCosts: parsedExtraCosts  // 추가 비용 데이터 (프론트에서 합산 용도)
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
