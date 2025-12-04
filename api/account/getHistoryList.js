// api/account/getHistoryList.js
const axios = require("axios");

module.exports = function (app) {
  app.get("/api/account/get-history-list", async (req, res) => {
    const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
    const DATABASE_ID = "2bf0b10191ce80568082ddb4deaab532"; 

    try {
      const response = await axios.post(
        `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
        {
          sorts: [{ property: "저장일시", direction: "descending" }] // 최신순 정렬
        },
        {
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
          },
        }
      );

      const list = response.data.results.map((page) => ({
        pageId: page.id,
        name: page.properties["이름"]?.title[0]?.plain_text || "제목 없음",
        id: page.properties["ID"]?.number,
        date: page.properties["저장일시"]?.date?.start || "",
      }));

      res.status(200).json({ ok: true, list });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, error: "목록 불러오기 실패" });
    }
  });
};
