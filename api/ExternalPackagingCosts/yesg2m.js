// api/ExternalPackagingCosts/yesg2m.js
const axios = require("axios");

// [설정] Notion API 토큰 및 데이터베이스 ID
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

      // 입력값 방어 코드
      // 주소 비교를 위해 공백 제거하지 않고 원본 유지가 필요할 수도 있으나,
      // includes 체크 편의를 위해 trim 정도만 수행
      const targetAddress = address ? address.trim() : "";
      
      // CBM 숫자로 변환
      let targetCBM = parseFloat(cbm);
      if (isNaN(targetCBM)) targetCBM = 0;

      // 1. 노션 데이터베이스 쿼리 (전체 행 가져오기)
      // 주소 매칭 로직(contains) 및 복합 계산을 위해 전체 로드 후 JS 처리
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {}, 
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 결과값 초기화
      let surveyFee = 0;   // 방문 견적비
      let packingFee = 0;  // 포장 작업비
      let travelFee = 0;   // 지역 출장비

      // 2. 데이터 순회 및 기본 값 추출
      for (const row of rows) {
        const props = row.properties;

        // '항목명' (Title) 가져오기
        const itemName = props["항목명"]?.title?.[0]?.plain_text;
        if (!itemName) continue;

        // ──────────────────────────────────────────
        // A. 지역 기반 비용 조회 (방문 견적비, 지역 출장비)
        // ──────────────────────────────────────────
        if (itemName === "방문 견적비" || itemName === "지역 출장비") {
          const regionTags = props["지역"]?.multi_select || [];
          
          // 로직: 노션의 지역 태그(예: '울산')가 사용자가 입력한 주소 문자열에 포함되어 있는지 확인
          const isMatch = regionTags.some(tag => targetAddress.includes(tag.name));

          if (isMatch) {
            const cost = props["금액"]?.number || 0;
            if (itemName === "방문 견적비") surveyFee = cost;
            if (itemName === "지역 출장비") travelFee = cost;
          }
        }

        // ──────────────────────────────────────────
        // B. 포장 작업비 (CBM 기반 계산)
        // ──────────────────────────────────────────
        if (itemName === "포장 작업비") {
            // CBM은 소수점이 있을 경우 올림 처리 (예: 25.1 -> 26, 26 -> 26)
            // 사용자 요구사항: "26이라면... 27이라면..." 등 정수 단위 계산 암시
            const cbmCeil = Math.ceil(targetCBM);

            if (cbmCeil >= 1 && cbmCeil <= 25) {
                // 1~25 사이: 해당 컬럼 값 그대로 조회 (예: "CBM (1)")
                const key = `CBM (${cbmCeil})`;
                packingFee = props[key]?.number || 0;
            } else if (cbmCeil >= 26) {
                // [요청사항 3] 26 이상일 경우 계산식 적용
                // 식: CBM(25)값 + {(입력CBM - 25) * "OVER 1CBM"값}
                
                const baseValue = props["CBM (25)"]?.number || 0;
                const overRate = props["OVER 1CBM"]?.number || 0;
                
                // 초과분 계산 (예: 26 -> 1, 27 -> 2)
                const overVolume = cbmCeil - 25;
                
                packingFee = baseValue + (overVolume * overRate);
            }
        }
      }

      // 3. [추가 요청사항] 후처리 로직 적용

      // [요청사항 1] "방문 견적비" 예외 처리
      // 주소에 '강서' 또는 '사하'가 포함되어 있다면 무조건 0원
      if (targetAddress.includes("강서") || targetAddress.includes("사하")) {
        surveyFee = 0;
      }

      // [요청사항 2] "지역 출장비" 할증 처리
      // 입력된 CBM이 31 이상이라면 조회된 지역 출장비를 2배로 계산
      if (targetCBM >= 31) {
        travelFee = travelFee * 2;
      }

      // 최종 결과 반환
      res.json({
        ok: true,
        data: {
          surveyFee,
          packingFee,
          travelFee
        }
      });

    } catch (e) {
      console.error("YESG2M Error:", e.response?.data || e.message);
      res.status(500).json({
        ok: false,
        error: "Notion 데이터 조회 중 오류가 발생했습니다.",
        details: e.message
      });
    }
  });
};
