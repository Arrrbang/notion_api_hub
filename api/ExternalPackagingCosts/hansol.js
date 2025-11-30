const axios = require("axios");

// [설정] Notion API 토큰 및 Hansol 데이터베이스 ID
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const DATABASE_ID = "2bb0b10191ce80848479c8c76f58166c"; // Hansol DB ID

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

// [Helper] RichText 전체 내용을 하나의 문자열로 결합
function getFullText(richTextArray) {
    if (!richTextArray || !Array.isArray(richTextArray)) return "";
    return richTextArray.map(item => item.plain_text).join("");
}

module.exports = function (app) {
  // Hansol 비용 계산 API 엔드포인트
  app.post("/api/hansol/calculate", async (req, res) => {
    try {
      const { address, cbm } = req.body;

      const targetAddress = address ? address.trim() : "";
      let targetCBM = parseFloat(cbm);
      if (isNaN(targetCBM)) targetCBM = 0;

      // 1. 노션 데이터베이스 쿼리
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {}, 
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 비용 초기화 (요청하신 대로 포장비, 출장비만 남김 + 방문견적비는 지역 로직 공유하므로 유지)
      let surveyFee = 0;          // 방문 견적비
      let packingFee = 0;         // 포장 작업비 (숫자 or "별도 문의")
      let travelFee = 0;          // 지역 출장비

      const notices = [];

      // [수정] Hansol 전용 고정 공지 항목
      const fixedNoticeItems = [
        "사다리차 사용 불가 엘베 작업", 
        "포장 외 하역 작업 발생시", 
        "LONG CARRY", 
        "20FT 기준 보관 비용"
      ];

      // 2. 데이터 순회
      for (const row of rows) {
        const props = row.properties;
        const itemName = getFullText(props["항목명"]?.title); 
        if (!itemName) continue;

        // 확인사항 텍스트 추출
        const checkPoint = getFullText(props["확인 사항"]?.rich_text) || getFullText(props["확인사항"]?.rich_text);

        // ──────────────── Notice Logic ────────────────
        if (fixedNoticeItems.includes(itemName)) {
            if (!notices.find(n => n.title === itemName)) {
                notices.push({ title: itemName, content: checkPoint });
            }
        }

        // ──────────────── Cost Logic A: 지역 기반 (방문견적비, 지역출장비) ────────────────
        if (itemName === "방문 견적비" || itemName === "지역 출장비") {
          const regionTags = props["지역"]?.multi_select || [];
          const isMatch = regionTags.some(tag => targetAddress.includes(tag.name));

          if (isMatch) {
            const cost = props["금액"]?.number || 0;
            if (itemName === "방문 견적비") surveyFee = cost;
            if (itemName === "지역 출장비") travelFee = cost;
            
            // 관련 공지사항 추가
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
          }
        }

        // ──────────────── Cost Logic B: 포장 작업비 (CBM 1~28) ────────────────
        if (itemName === "포장 작업비") {
            const cbmIndex = Math.ceil(targetCBM);

            // [수정] 1 ~ 28 CBM 까지만 조회
            if (cbmIndex >= 1 && cbmIndex <= 28) {
                const key = `CBM (${cbmIndex})`;
                // 컬럼이 실제로 존재하는지 확인 후 값 가져오기
                if (props[key]) {
                    packingFee = props[key]?.number || 0;
                } else {
                    // CBM(26)~CBM(28) 컬럼이 없을 경우 대비
                    packingFee = "별도 문의";
                }
            } else {
                // [수정] 범위를 벗어나면 "별도 문의" 반환
                packingFee = "별도 문의";
            }

            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }
      }

      res.json({
        ok: true,
        data: {
          surveyFee,
          packingFee,
          travelFee,
          notices
        }
      });

    } catch (e) {
      console.error("Hansol Error:", e.response?.data || e.message);
      res.status(500).json({ ok: false, error: "오류 발생", details: e.message });
    }
  });
};
