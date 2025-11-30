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

      // 입력값 정리
      const targetAddress = address ? address.trim() : "";
      
      // CBM 숫자로 변환 (유효하지 않으면 0)
      let targetCBM = parseFloat(cbm);
      if (isNaN(targetCBM)) targetCBM = 0;

      // 1. 노션 데이터베이스 쿼리 (전체 행 조회)
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {}, 
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 결과값 초기화
      let surveyFee = 0;          // 방문 견적비
      let packingFee = 0;         // 포장 작업비
      let travelFee = 0;          // 지역 출장비
      let shuttleFee = 0;         // EV+셔틀 작업비
      let woodenCrateFee = 0;     // 우든 제작비용 (NEW)
      let storageFee = 0;         // 창고 보관료 (NEW)
      let loadingUnloadingFee = 0;// 창고 보관 상하차 비용 (NEW)

      // 2. 데이터 순회 및 비용 계산
      for (const row of rows) {
        const props = row.properties;

        // '항목명' (Title) 가져오기
        const itemName = props["항목명"]?.title?.[0]?.plain_text;
        if (!itemName) continue;

        // ──────────────────────────────────────────
        // A. 지역 기반 비용 (방문 견적비, 지역 출장비)
        // ──────────────────────────────────────────
        if (itemName === "방문 견적비" || itemName === "지역 출장비") {
          const regionTags = props["지역"]?.multi_select || [];
          
          // 주소 매칭 (포함 여부 확인)
          const isMatch = regionTags.some(tag => targetAddress.includes(tag.name));

          if (isMatch) {
            const cost = props["금액"]?.number || 0;
            if (itemName === "방문 견적비") surveyFee = cost;
            if (itemName === "지역 출장비") travelFee = cost;
          }
        }

        // ──────────────────────────────────────────
        // B. 포장 작업비 (CBM 기반 - Over CBM 방식)
        // ──────────────────────────────────────────
        if (itemName === "포장 작업비") {
            const cbmIndex = Math.ceil(targetCBM);

            if (cbmIndex >= 1 && cbmIndex <= 25) {
                // 1~25: 해당 컬럼 값 조회
                const key = `CBM (${cbmIndex})`;
                packingFee = props[key]?.number || 0;
            } else if (cbmIndex > 25) {
                // 26 이상: CBM(25) + {(CBM - 25) * OVER단가}
                const baseValue = props["CBM (25)"]?.number || 0;
                const overRate = props["OVER 1CBM"]?.number || 0;
                const overVolume = cbmIndex - 25;
                packingFee = baseValue + (overVolume * overRate);
            }
        }

        // ──────────────────────────────────────────
        // C. EV+셔틀 작업비 (CBM 기반 - 합산 방식)
        // ──────────────────────────────────────────
        if (itemName === "EV+셔틀 작업비") {
            const cbmIndex = Math.ceil(targetCBM);

            if (cbmIndex <= 25) {
                // 25 이하: 해당 CBM 값 그대로
                const key = `CBM (${cbmIndex})`;
                shuttleFee = props[key]?.number || 0;
            } else {
                // 26 이상: CBM(25) + CBM(나머지)
                const baseValue = props["CBM (25)"]?.number || 0;
                const remainder = cbmIndex - 25;
                const remainderKey = `CBM (${remainder})`;
                const remainderValue = props[remainderKey]?.number || 0;
                
                shuttleFee = baseValue + remainderValue;
            }
        }

        // ──────────────────────────────────────────
        // D. 기타 비용 (단순 조회 및 곱하기 연산) [NEW]
        // ──────────────────────────────────────────
        
        // 1. 우든 제작비용 (단순 금액 조회)
        if (itemName === "우든 제작비용") {
            woodenCrateFee = props["금액"]?.number || 0;
        }

        // 2. 창고 보관료 (단순 금액 조회)
        if (itemName === "창고 보관료") {
            storageFee = props["금액"]?.number || 0;
        }

        // 3. 창고 보관 상하차 비용 (금액 * CBM)
        if (itemName === "창고 보관 상하차 비용") {
            const unitPrice = props["금액"]?.number || 0;
            // 입력된 CBM 만큼 곱하기
            loadingUnloadingFee = unitPrice * targetCBM;
        }
      }

      // 3. 후처리 로직 (예외 처리 및 할증)

      // [방문 견적비] 강서, 사하 지역은 0원 처리
      if (targetAddress.includes("강서") || targetAddress.includes("사하")) {
        surveyFee = 0;
      }

      // [지역 출장비] CBM 31 이상이면 2배 할증
      if (targetCBM >= 31) {
        travelFee = travelFee * 2;
      }

      // 최종 결과 반환
      res.json({
        ok: true,
        data: {
          surveyFee,
          packingFee,
          travelFee,
          shuttleFee,
          woodenCrateFee,      // 추가
          storageFee,          // 추가
          loadingUnloadingFee  // 추가
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
