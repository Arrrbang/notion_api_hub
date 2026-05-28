// api/ofc/ofc-costs.js
const axios = require("axios");

const TARGET_DB_ID = "3420b10191ce80c2a864d2e33aa87b05"; // 기존 OFC 데이터베이스
const EXTRA_DB_ID = "3450b10191ce803ca0a9e700df8af7b8";  // 추가 비용 데이터베이스
const MAPPING_DB_ID = "36e0b10191ce804492fce82a1d2719c3"; // [NEW] POE 매핑 데이터베이스

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  if (!NOTION_TOKEN) throw new Error("NOTION_API_KEY (또는 NOTION_TOKEN) is missing");
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

function getMultiSelectNames(prop) {
  if (!prop || prop.type !== "multi_select" || !prop.multi_select) return [];
  return prop.multi_select.map(item => item.name);
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

module.exports = function registerPoeCostsRoutes(app) {
  
  app.get("/api/ofc/ofc-costs", async (req, res) => {
    try {
      const frontPoe = (req.query.poe || "").trim().toUpperCase();

      if (!frontPoe) {
        return res.status(400).json({ ok: false, error: "POE를 입력하세요. (예: LA)" });
      }

      let targetPoes = [frontPoe]; 

      // 1. 매핑 DB에서 PORT CODE(텍스트) 가져오기
      const mappingFilter = {
        filter: {
          property: "PORT NAME", // 제목 속성
          title: {
            equals: frontPoe
          }
        }
      };

      const mappingResp = await axios.post(
        `https://api.notion.com/v1/databases/${MAPPING_DB_ID}/query`,
        mappingFilter,
        { headers: notionHeaders() }
      );

      if (mappingResp.data.results && mappingResp.data.results.length > 0) {
        const mappingPage = mappingResp.data.results[0];
        const rawCodes = richTextToPlain(mappingPage.properties["PORT CODE"]?.rich_text || []);
        
        if (rawCodes) {
          targetPoes = rawCodes.split(",").map(code => code.trim()).filter(code => code !== "");
        }
      }

      // 2. 검색에 사용할 공통 필터 (POE 컬럼 확인)
      const filterBody = {
        filter: {
          or: targetPoes.map(code => ({
            property: "POE",
            multi_select: {
              contains: code
            }
          }))
        }
      };

      // 🚨 [핵심 수정 부분] 3. 메인 해상운임(OFC) DB를 먼저 조회
      const ofcResp = await axios.post(`https://api.notion.com/v1/databases/${TARGET_DB_ID}/query`, filterBody, { headers: notionHeaders() });
      const ofcResults = ofcResp.data.results || [];

      // 🚨 메인 운임 데이터가 없으면, 추가비용을 아예 조회하지 않고 즉시 404 리턴
      if (ofcResults.length === 0) {
        return res.status(404).json({
          ok: false,
          error: `매핑된 POE(${targetPoes.join(", ")})에 해당하는 해상 운임 데이터를 찾을 수 없습니다.`
        });
      }

      // 🚨 4. 메인 운임이 존재할 때만, 동일한 POE 조건으로 추가비용 DB 조회
      const extraResp = await axios.post(`https://api.notion.com/v1/databases/${EXTRA_DB_ID}/query`, filterBody, { headers: notionHeaders() });
      const extraResults = extraResp.data.results || [];

      // 5. 기존 OFC 데이터 정제
      const parsedOfcData = ofcResults.map(page => {
        const props = page.properties;
        const raw20DR = getFormulaNumber(props["20DR"]);
        const raw40HC = getFormulaNumber(props["40HC"]);

        return {
          id: page.id,
          poeList: getMultiSelectNames(props["POE"]),
          cost20DR: raw20DR !== null ? Math.round(raw20DR) : null,
          cost40HC: raw40HC !== null ? Math.round(raw40HC) : null,
          validity: getDateProperty(props["VALIDITY"]),   
          remarks: richTextToPlain(props["특이사항"]?.rich_text || [])
        };
      });

      // 6. 추가 비용(Extra Costs) 데이터 정제
      const parsedExtraCosts = extraResults.map(page => {
        const props = page.properties;
        
        const raw20 = props["20DR"]?.number || 0;
        const raw40 = props["40HC"]?.number || 0;
        const rawCONSOLE = props["CONSOLE"]?.number || 0;

        return {
          id: page.id,
          name: richTextToPlain(props["항목명"]?.title || []), 
          poeList: getMultiSelectNames(props["POE"]),
          cost20: Math.round(raw20),
          cost40: Math.round(raw40),
          costCONSOLE: Math.round(rawCONSOLE)
        };
      });

      // 7. 프론트엔드로 최종 전달
      return res.json({
        ok: true,
        input: { frontPoe, targetPoe: targetPoes },
        ofcData: parsedOfcData,       
        extraCosts: parsedExtraCosts  
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
