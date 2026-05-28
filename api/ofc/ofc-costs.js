// api/ofc/ofc-costs.js
const axios = require("axios");

const TARGET_DB_ID = "3420b10191ce80c2a864d2e33aa87b05"; // 기존 OFC 데이터베이스
const EXTRA_DB_ID = "3450b10191ce803ca0a9e700df8af7b8";  // 추가 비용 데이터베이스
const MAPPING_DB_ID = "36e0b10191ce804492fce82a1d2719c3"; // [NEW] 테스트용 새 POE 매핑 데이터베이스

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

// 텍스트 속성 및 이름(title) 속성 추출기
function richTextToPlain(rich = []) {
  return rich.map(r => r.plain_text || "").join("").trim();
}

// 다중 선택(Multi-select) 값 배열 추출기
function getMultiSelectNames(prop) {
  if (!prop || prop.type !== "multi_select" || !prop.multi_select) return [];
  return prop.multi_select.map(item => item.name);
}

// 수식(Formula) 속성 추출기 (첫 번째 DB용)
function getFormulaNumber(prop) {
  if (!prop || prop.type !== "formula" || !prop.formula) return null;
  const f = prop.formula;
  if (f.type === "number") return f.number;
  return null;
}

// 일반 날짜(Date) 속성 추출기 (첫 번째 DB용)
function getDateProperty(prop) {
  if (!prop || prop.type !== "date" || !prop.date) return null;
  return { start: prop.date.start, end: prop.date.end };
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

      // 2. 노션 매핑 DB에서 PORT CODE 조회
      let targetPoes = [frontPoe]; // 매핑 데이터가 없을 경우 기본값으로 입력값 사용

      // [PORT NAME]이 제목(Title) 속성이므로 title 필터 사용
      const mappingFilter = {
        filter: {
          property: "PORT NAME",
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

      // 매핑 결과가 존재하는 경우
      if (mappingResp.data.results && mappingResp.data.results.length > 0) {
        const mappingPage = mappingResp.data.results[0];
        
        // [PORT CODE]가 텍스트(Rich text) 속성이므로 rich_text에서 추출
        const rawCodes = richTextToPlain(mappingPage.properties["PORT CODE"]?.rich_text || []);
        
        if (rawCodes) {
          // 쉼표로 구분된 문자열을 배열로 변환하고 양옆 공백 제거 (예: "CODE1, CODE2" -> ["CODE1", "CODE2"])
          targetPoes = rawCodes.split(",").map(code => code.trim()).filter(code => code !== "");
        }
      }

      // 3. 노션 쿼리 필터: POE 다중 선택 속성에 targetPoes 중 하나라도 포함되어 있는지 확인 (OR 조건)
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

      // 4. Promise.all을 사용하여 기존 OFC와 추가비용 DB를 병렬로 동시 조회
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
          error: `매핑된 POE(${targetPoes.join(", ")})에 해당하는 데이터를 찾을 수 없습니다.`
        });
      }

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
          cost20: Math.round(raw20),
          cost40: Math.round(raw40),
          costCONSOLE: Math.round(rawCONSOLE)
        };
      });

      // 7. 프론트엔드로 전달
      return res.json({
        ok: true,
        input: { frontPoe, targetPoe: targetPoes }, // 매핑되어 검색에 사용된 배열 값 리턴
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
