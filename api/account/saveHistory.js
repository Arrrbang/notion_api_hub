// api/account/saveHistory.js (수정됨: 100개 블록 제한 해결)
const axios = require("axios");

module.exports = function (app) {
  app.post("/api/account/save-history", async (req, res) => {
    try {
      const { name, id, date, b3Date, dataMap } = req.body;

      const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
      const DATABASE_ID = "2bf0b10191ce80568082ddb4deaab532"; 

      if (!NOTION_TOKEN) {
        return res.status(500).json({ ok: false, error: "Notion Token이 없습니다." });
      }

      // 1. JSON 데이터 분할 (2000자 단위)
      const jsonString = JSON.stringify(dataMap);
      const chunks = [];
      for (let i = 0; i < jsonString.length; i += 2000) {
        chunks.push(jsonString.substring(i, i + 2000));
      }

      // 2. 노션 블록 형태로 변환
      const allBlocks = chunks.map((chunk) => ({
        object: "block",
        type: "code",
        code: {
          language: "json",
          rich_text: [{ type: "text", text: { content: chunk } }],
        },
      }));

      // 3. 페이지 먼저 생성 (내용 없이 껍데기만)
      const createResponse = await axios.post(
        "https://api.notion.com/v1/pages",
        {
          parent: { database_id: DATABASE_ID },
          properties: {
            "이름": { title: [{ text: { content: name } }] },
            "ID": { number: Number(id) },
            "저장일시": { date: { start: new Date().toISOString() } },
            "기준일자": { date: b3Date ? { start: new Date(b3Date).toISOString() } : null },
          },
        },
        {
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
        }
      );

      const pageId = createResponse.data.id;

      // 4. 블록을 100개씩 나누어서 추가 (Append Children)
      // Notion API 제한: 한 번에 100개까지만 추가 가능
      const BATCH_SIZE = 100;
      for (let i = 0; i < allBlocks.length; i += BATCH_SIZE) {
        const batch = allBlocks.slice(i, i + BATCH_SIZE);
        
        await axios.patch(
          `https://api.notion.com/v1/blocks/${pageId}/children`,
          { children: batch },
          {
            headers: {
              Authorization: `Bearer ${NOTION_TOKEN}`,
              "Content-Type": "application/json",
              "Notion-Version": "2022-06-28",
            },
          }
        );
      }

      res.status(200).json({ ok: true, message: "저장 완료", pageId: pageId });

    } catch (error) {
      console.error("Notion Error:", error.response?.data || error.message);
      res.status(500).json({
        ok: false,
        error: "Notion 저장 실패",
        details: error.response?.data || error.message, // 프론트엔드에서 원인 확인용
      });
    }
  });
};
