// api/account/getHistoryItem.js (수정됨: 100개 이상 블록 모두 가져오기)
const axios = require("axios");

module.exports = function (app) {
  app.get("/api/account/get-history-item", async (req, res) => {
    const { pageId } = req.query;
    const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

    if (!pageId) return res.status(400).json({ ok: false, error: "Page ID Missing" });

    try {
      let allBlocks = [];
      let hasMore = true;
      let startCursor = undefined;

      // 1. 반복문으로 모든 블록(Children) 다 가져오기 (Pagination)
      while (hasMore) {
        const response = await axios.get(
          `https://api.notion.com/v1/blocks/${pageId}/children`,
          {
            headers: {
              Authorization: `Bearer ${NOTION_TOKEN}`,
              "Notion-Version": "2022-06-28",
            },
            params: {
              page_size: 100, // 최대치
              start_cursor: startCursor, // 다음 페이지 위치
            },
          }
        );

        allBlocks = [...allBlocks, ...response.data.results];
        hasMore = response.data.has_more; // 더 있는지 확인
        startCursor = response.data.next_cursor; // 다음 페이지 주소 갱신
      }

      // 2. 가져온 모든 블록에서 텍스트 추출 및 병합
      let fullJsonString = "";
      for (const block of allBlocks) {
        if (block.type === "code" && block.code) {
          fullJsonString += block.code.rich_text[0].plain_text;
        }
      }

      // 3. JSON 파싱 (이제 전체 문자열이므로 에러 안 남)
      const parsedData = JSON.parse(fullJsonString);

      res.status(200).json({ ok: true, data: parsedData });

    } catch (error) {
      console.error("Fetch Error:", error.response?.data || error.message);
      
      // JSON 파싱 에러인지 확인
      if (error instanceof SyntaxError) {
        return res.status(500).json({ 
            ok: false, 
            error: "데이터가 손상되어 복구할 수 없습니다. (JSON Parse Error)" 
        });
      }

      res.status(500).json({ 
          ok: false, 
          error: "데이터 상세 로드 실패", 
          details: error.message 
      });
    }
  });
};
