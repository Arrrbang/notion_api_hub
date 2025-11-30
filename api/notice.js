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
      // 1. 노션 데이터베이스 쿼리
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          // [수정] 필터: 상태가 '공지' OR '정보' 인 것 조회
          filter: {
            or: [
                {
                    property: "상태",
                    select: { equals: "공지" }
                },
                {
                    property: "상태",
                    select: { equals: "정보" }
                }
            ]
          },
          sorts: [
            {
              timestamp: "created_time", // 1차: 최신순 (일단 가져옴)
              direction: "descending"
            }
          ]
        }, 
        { headers: notionHeaders() }
      );

      const rows = response.data.results;

      // 2. 필요한 데이터 추출
      let notices = rows.map(row => {
        const titleParts = row.properties["제목"]?.title || [];
        const title = titleParts.map(t => t.plain_text).join("") || "제목 없음";
        // [NEW] 상태 값('공지' or '정보') 가져오기
        const category = row.properties["상태"]?.select?.name || "공지";
        
        return {
          title: title,
          url: row.url,
          category: category // 프론트엔드로 전달
        };
      });

      // 3. [NEW] 순서 재정렬 (공지 -> 정보 순)
      notices.sort((a, b) => {
        // 우선순위 맵: 공지가 1번, 정보가 2번
        const priority = { "공지": 1, "정보": 2 };
        
        const pA = priority[a.category] || 99;
        const pB = priority[b.category] || 99;

        // 우선순위가 다르면 순서대로, 같으면(같은 카테고리면) 기존 최신순 유지
        return pA - pB;
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
