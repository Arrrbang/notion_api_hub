// api/ofc/ofc-costs.js
const axios = require("axios");

const TARGET_DB_ID = "3720b10191ce80e291e3ca782bb6f0a1"; // 메인 OFC 데이터베이스
const EXTRA_DB_ID = "3450b10191ce803ca0a9e700df8af7b8";  // 추가 비용 데이터베이스
const MAPPING_DB_ID = "36e0b10191ce804492fce82a1d2719c3"; // POE 매핑 데이터베이스

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

      // 1. 매핑 DB에서 CODE 찾기
      const mappingFilter = { filter: { property: "PORT NAME", title: { equals: frontPoe } } };
      const mappingResp = await axios.post(`https://api.notion.com/v1/databases/${MAPPING_DB_ID}/query`, mappingFilter, { headers: notionHeaders() });

      let targetPoes = []; 
      if (mappingResp.data.results && mappingResp.data.results.length > 0) {
        const rawCodes = richTextToPlain(mappingResp.data.results[0].properties["PORT CODE"]?.rich_text || []);
        if (rawCodes) {
          targetPoes = rawCodes.split(",").map(code => code.trim().toUpperCase()).filter(code => code.length > 0);
        }
      }

      if (targetPoes.length === 0) {
        return res.status(404).json({ ok: false, error: `매핑 DB에서 '${frontPoe}'에 해당하는 PORT CODE를 찾을 수 없습니다.` });
      }

      // 2. 검색 필터
      const filterBody = {
        filter: {
          or: targetPoes.map(code => ({
            property: "POE",
            multi_select: { contains: code }
          }))
        }
      };

      // 3. 메인 해상운임(OFC) 조회 및 엄격한 필터링
      const ofcResp = await axios.post(`https://api.notion.com/v1/databases/${TARGET_DB_ID}/query`, filterBody, { headers: notionHeaders() });
      let ofcResults = ofcResp.data.results || [];
      
      // [자바스크립트 철벽 방어막 1] 노션이 잘못 뱉은 데이터를 버림
      ofcResults = ofcResults.filter(page => {
        const tags = getMultiSelectNames(page.properties["POE"]).map(t => t.trim().toUpperCase());
        return targetPoes.some(code => tags.includes(code));
      });

      if (ofcResults.length === 0) {
        return res.status(404).json({ ok: false, error: `코드(${targetPoes.join(", ")})와 완벽히 일치하는 해상 운임 데이터가 없습니다.` });
      }

      // 4. 추가비용 DB 조회
      const extraResp = await axios.post(`https://api.notion.com/v1/databases/${EXTRA_DB_ID}/query`, filterBody, { headers: notionHeaders() });
      let extraResults = extraResp.data.results || [];

      // 🚨 [자바스크립트 철벽 방어막 2] 일치하는 코드가 없으면 아무것도 안 가져오게 (배열을 비워버리게) 만듭니다.
      extraResults = extraResults.filter(page => {
        const tags = getMultiSelectNames(page.properties["POE"]).map(t => t.trim().toUpperCase());
        return targetPoes.some(code => tags.includes(code));
      });

      // 5. 정제
      const parsedOfcData = ofcResults.map(page => {
        const props = page.properties;
        const raw20DR = getFormulaNumber(props["20DR"]);
        const raw40HC = getFormulaNumber(props["40HC"]);
        return {
          id: page.id,
          poeList: getMultiSelectNames(props["POE"]),
          cost20DR: raw20DR !== null ? Math.round(raw20DR) : null,
          cost40HC: raw40HC !== null ? Math.round(raw40HC) : null,
          validity: getDateProperty(props["VALIDITY"])
        };
      });

      const parsedExtraCosts = extraResults.map(page => {
        const props = page.properties;
        return {
          id: page.id,
          name: richTextToPlain(props["항목명"]?.title || []), 
          cost20: Math.round(props["20DR"]?.number || 0),
          cost40: Math.round(props["40HC"]?.number || 0),
          costCONSOLE: Math.round(props["CONSOLE"]?.number || 0)
        };
      });

      return res.json({
        ok: true,
        // 🚨 프론트엔드가 인식할 수 있도록 변수명을 원래대로(targetPoe) 복구했습니다.
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
