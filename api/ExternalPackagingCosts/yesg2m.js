// api/ExternalPackagingCosts/yesg2m.js

const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const DATABASE_ID = "2b90b10191ce8056943acd289fa3d5cf";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

module.exports = function (app) {
  // 비용 계산 API 엔드포인트
  app.post("/api/yesg2m/calculate", async (req, res) => {
    try {
      const { address, cbm } = req.body;

      if (!DATABASE_ID) {
        throw new Error("YESG2M_DB_ID 환경변수가 설정되지 않았습니다.");
      }

      // 1. 노션 데이터베이스 전체 조회 (필요시 필터 최적화 가능)
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {}, // 모든 데이터를 가져와서 메모리에서 필터링 (주소 매칭 로직 복잡성 때문)
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 결과값 초기화
      let surveyFee = 0;   // 방문 견적비
      let packingFee = 0;  // 포장 작업비
      let travelFee = 0;   // 지역 출장비

      // 주소 정제 (공백 제거 등 비교 편의성 증대, 선택사항)
      const targetAddress = address ? address.trim() : "";
      const targetCBM = parseFloat(cbm) || 0;

      // 2. 데이터 순회 및 로직 적용
      for (const row of rows) {
        const props = row.properties;

        // 항목명 가져오기 (Title 속성)
        const itemName = props["항목명"]?.title?.[0]?.plain_text;
        
        if (!itemName) continue;

        // A. 방문 견적비 & 지역 출장비 로직 (주소 매칭)
        if (itemName === "방문 견적비" || itemName === "지역 출장비") {
          // "지역" 다중 선택 속성 가져오기
          const regionTags = props["지역"]?.multi_select || [];
          
          // 주소 매칭: 태그 중 하나라도 주소 문자열에 포함되어 있으면 매칭 성공
          // 예: 주소 "울산 중구..." / 태그 "울산" -> 매칭됨
          const isMatch = regionTags.some(tag => targetAddress.includes(tag.name));

          if (isMatch) {
            const cost = props["금액"]?.number || 0;
            if (itemName === "방문 견적비") surveyFee = cost;
            if (itemName === "지역 출장비") travelFee = cost;
          }
        }

        // B. 포장 작업비 로직 (CBM 매칭)
        // 항목명이 '포장 작업비'인 경우 CBM 컬럼 확인
        if (itemName === "포장 작업비") {
            // CBM은 정수로 내림 혹은 반올림하여 처리 (정책에 따라 수정 필요)
            // 여기서는 1~25 사이의 정수 CBM을 찾습니다.
            const cbmIndex = Math.ceil(targetCBM); 
            
            if (cbmIndex >= 1 && cbmIndex <= 25) {
                // "CBM (N)" 컬럼 값 가져오기
                const cbmKey = `CBM (${cbmIndex})`;
                packingFee = props[cbmKey]?.number || 0;
            } else if (cbmIndex > 25) {
                // 25 CBM 초과시 "OVER 1CBM" 로직 적용
                // 예: 기본값 + (초과분 * OVER단가) 로직일 수 있으나, 
                // 현재는 해당 컬럼 값 자체를 가져오거나 별도 로직이 필요함.
                // 여기서는 "OVER 1CBM" 컬럼 값을 가져옵니다.
                packingFee = props["OVER 1CBM"]?.number || 0;
            }
        }
      }

      // 결과 반환
      res.json({
        ok: true,
        data: {
          surveyFee,    // 방문 견적비
          packingFee,   // 포장 작업비
          travelFee     // 지역 출장비
        }
      });

    } catch (e) {
      console.error("YESG2M Error:", e);
      res.status(500).json({
        ok: false,
        error: "비용 조회 중 오류가 발생했습니다.",
        details: e.response?.data || e.message
      });
    }
  });
};
