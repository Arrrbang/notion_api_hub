// api/account/deleteHistory.js
const axios = require("axios");

module.exports = function (app) {
  app.post("/api/account/delete-history", async (req, res) => {
    const { pageIds } = req.body;
    const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

    try {
      // 여러 개 삭제 (Promise.all 사용)
      await Promise.all(
        pageIds.map((id) =>
          axios.patch(
            `https://api.notion.com/v1/pages/${id}`,
            { archived: true }, // 아카이브 = 삭제
            {
              headers: {
                Authorization: `Bearer ${NOTION_TOKEN}`,
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28",
              },
            }
          )
        )
      );

      res.status(200).json({ ok: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ ok: false, error: "삭제 실패" });
    }
  });
};
