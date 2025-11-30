const axios = require("axios");

// [설정] Notion API 토큰 및 공지사항 데이터베이스 ID
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const DATABASE_ID = "2bb0b10191ce80f38607c9db0e18b2ce"; 

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

module.exports = function (app) {
  // 공지사항 조회 API (GET 방식)
  app.get("/api/notice/list", async (req, res) => {
    try {
      // 1. 노션 데이터베이스 쿼리 (필터 적용)
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          filter: {
            property: "상태", // 선택 속성 이름
            select: {
              equals: "공지" // 값이 '공지'인 것만
            }
          },
          sorts: [
            {
              timestamp: "created_time", // 생성일 기준 내림차순 (최신순)
              direction: "descending"
            }
          ]
        }, 
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 2. 필요한 데이터만 추출 (제목, URL)
      const notices = rows.map(row => {
        // 제목 속성 가져오기 (속성명이 '제목'이라고 가정)
        const titleParts = row.properties["제목"]?.title || [];
        const title = titleParts.map(t => t.plain_text).join("") || "제목 없음";
        
        return {
          title: title,
          url: row.url // 클릭 시 이동할 노션 페이지 URL
        };
      });

      res.json({
        ok: true,
        data: notices
      });

    } catch (e) {
      console.error("Notice API Error:", e.response?.data || e.message);
      res.status(500).json({ 
        ok: false, 
        error: "공지사항을 불러오는 중 오류가 발생했습니다." 
      });
    }
  });
};
