// api/account/getHistoryItem.js
const axios = require("axios");

module.exports = function (app) {
  app.get("/api/account/get-history-item", async (req, res) => {
    const { pageId } = req.query;
    const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

    if (!pageId) return res.status(400).json({ ok: false, error: "Page ID Missing" });

    try {
      // 노션 페이지의 블록(본문) 조회
      const response = await axios.get(
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        {
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
          },
        }
      );

      // 코드 블록 안에 있는 텍스트 조각들을 모두 이어 붙임
      let fullJsonString = "";
      for (const block of response.data.results) {
        if (block.type === "code" && block.code) {
          fullJsonString += block.code.rich_text[0].plain_text;
        }
      }

      // JSON 파싱
      const parsedData = JSON.parse(fullJsonString);

      res.status(200).json({ ok: true, data: parsedData });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, error: "데이터 상세 로드 실패" });
    }
  });
};
