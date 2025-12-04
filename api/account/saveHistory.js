// api/account/saveHistory.js

const axios = require("axios");

module.exports = function (app) {
  app.post("/api/account/save-history", async (req, res) => {
    try {
      // 1. 요청 데이터 받기
      const payload = req.body; // { name, id, b3Date, dataMap ... } 전체
      const { name, id, b3Date } = payload; // 헤더용 변수만 따로 추출

      const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
      const DATABASE_ID = "2bf0b10191ce80568082ddb4deaab532"; 

      if (!NOTION_TOKEN) return res.status(500).json({ ok: false, error: "Notion Token 없음" });

      // ========================================================
      // [수정됨] dataMap만 저장하던 것을 payload(전체) 저장으로 변경
      // ========================================================
      const jsonString = JSON.stringify(payload); 
      
      // 2000자 단위 분할
      const chunks = [];
      for (let i = 0; i < jsonString.length; i += 2000) {
        chunks.push(jsonString.substring(i, i + 2000));
      }

      // 블록 생성
      const allBlocks = chunks.map((chunk) => ({
        object: "block",
        type: "code",
        code: {
          language: "json",
          rich_text: [{ type: "text", text: { content: chunk } }],
        },
      }));

      // 페이지 생성 (헤더 정보)
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

      // 블록 이어붙이기 (100개 제한 대응)
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
        details: error.response?.data || error.message,
      });
    }
  });
};
