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

// [Helper] RichText 전체 내용을 하나의 문자열로 결합
function getFullText(richTextArray) {
    if (!richTextArray || !Array.isArray(richTextArray)) return "";
    return richTextArray.map(item => item.plain_text).join("");
}

module.exports = function (app) {
  app.post("/api/yesg2m/calculate", async (req, res) => {
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

      // 비용 초기화
      let surveyFee = 0;
      let packingFee = 0;
      let travelFee = 0;
      let shuttleFee = 0;
      let woodenCrateFee = 0;
      let storageFee = 0;
      let loadingUnloadingFee = 0;

      const notices = [];

      // 고정 항목 리스트
      const fixedNoticeItems = [
        "FUMIGATION PALLET", 
        "CFS 입고 비용 부산(신항)/양산", 
        "기타 추가 비용"
      ];

      // 2. 데이터 순회
      for (const row of rows) {
        const props = row.properties;
        const itemName = getFullText(props["항목명"]?.title); 
        if (!itemName) continue;

        // 확인사항 전체 텍스트 추출
        const checkPoint = getFullText(props["확인 사항"]?.rich_text) || getFullText(props["확인사항"]?.rich_text);

        // ──────────────── Notice Logic ────────────────
        // 고정 항목
        if (fixedNoticeItems.includes(itemName)) {
            if (!notices.find(n => n.title === itemName)) {
                notices.push({ title: itemName, content: checkPoint });
            }
        }

        // ──────────────── Cost Logic A ────────────────
        if (itemName === "방문 견적비" || itemName === "지역 출장비") {
          const regionTags = props["지역"]?.multi_select || [];
          const isMatch = regionTags.some(tag => targetAddress.includes(tag.name));

          if (isMatch) {
            const cost = props["금액"]?.number || 0;
            if (itemName === "방문 견적비") surveyFee = cost;
            if (itemName === "지역 출장비") travelFee = cost;
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
          }
        }

        // ──────────────── Cost Logic B ────────────────
        if (itemName === "포장 작업비") {
            const cbmIndex = Math.ceil(targetCBM);
            if (cbmIndex >= 1 && cbmIndex <= 25) {
                packingFee = props[`CBM (${cbmIndex})`]?.number || 0;
            } else if (cbmIndex > 25) {
                const baseValue = props["CBM (25)"]?.number || 0;
                const overRate = props["OVER 1CBM"]?.number || 0;
                const overVolume = cbmIndex - 25;
                packingFee = baseValue + (overVolume * overRate);
            }
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }

        // ──────────────── Cost Logic C ────────────────
        if (itemName === "EV,셔틀,계단 작업비") {
            const cbmIndex = Math.ceil(targetCBM);
            if (cbmIndex <= 25) {
                shuttleFee = props[`CBM (${cbmIndex})`]?.number || 0;
            } else {
                const baseValue = props["CBM (25)"]?.number || 0;
                const remainder = cbmIndex - 25;
                const remainderValue = props[`CBM (${remainder})`]?.number || 0;
                shuttleFee = baseValue + remainderValue;
            }
             if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }

        // ──────────────── Cost Logic D ────────────────
        if (itemName === "우든 제작비용") {
            woodenCrateFee = props["금액"]?.number || 0;
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }

        if (itemName === "창고 보관료") {
            storageFee = props["금액"]?.number || 0;
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }

        if (itemName === "창고 보관 상하차 비용") {
            loadingUnloadingFee = (props["금액"]?.number || 0) * targetCBM;
            if (checkPoint) notices.push({ title: itemName, content: checkPoint });
        }
      }

      // 후처리
      if (targetAddress.includes("강서") || targetAddress.includes("사하")) {
        surveyFee = 0;
      }
      if (targetCBM >= 31) {
        travelFee = travelFee * 2;
      }

      res.json({
        ok: true,
        data: {
          surveyFee, packingFee, travelFee, shuttleFee,
          woodenCrateFee, storageFee, loadingUnloadingFee,
          notices
        }
      });

    } catch (e) {
      console.error("YESG2M Error:", e.response?.data || e.message);
      res.status(500).json({ ok: false, error: "오류 발생", details: e.message });
    }
  });
};
