// api/trc/cal.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// 1. Notion 설정
const TRC_DATABASE_ID = "2c20b10191ce80d2afdaebe692cf074b"; // 유저가 알려준 DB ID
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 2. 거리별 운임 조회 라우트
// 요청 예시: /api/trc/cal?distance=468
router.get("/", async (req, res) => {
  try {
    const { distance } = req.query;

    if (!distance) {
        return res.status(400).json({ ok: false, error: "거리(distance) 값이 필요합니다." });
    }

    // Notion에 쿼리 날리기
    // "구간거리" (Title 속성)가 distance와 정확히 일치하는지 찾음
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${TRC_DATABASE_ID}/query`,
      {
        filter: {
          property: "구간거리", // 노션 데이터베이스의 타이틀 컬럼명
          title: {
            equals: String(distance) // 숫자라도 타이틀은 문자열로 검색해야 함
          }
        }
      },
      { headers: notionHeaders() }
    );

    const results = response.data.results;

    if (results.length === 0) {
        // 해당 거리에 대한 운임 정보가 없을 때
        return res.json({ 
            ok: true, 
            found: false, 
            data: null,
            message: "해당 거리의 운임 정보를 찾을 수 없습니다." 
        });
    }

    // 첫 번째 결과 가져오기
    const props = results[0].properties;
    
    // 노션 Number 속성에서 값 꺼내기
    const cost20 = props["20FT 안전운송운임"]?.number || 0;
    const cost40 = props["40FT 안전운송운임"]?.number || 0;

    res.json({
        ok: true,
        found: true,
        data: {
            distance: distance,
            cost20: cost20,
            cost40: cost40
        }
    });

  } catch (error) {
    console.error("Trucking Cost Error:", error.message);
    res.status(500).json({ ok: false, error: "운임 조회 실패" });
  }
});

// 라우터 등록
module.exports = (app) => {
  app.use("/api/trc/cal", router);
};
