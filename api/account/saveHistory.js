// api/account/saveHistory.js
const axios = require("axios");

module.exports = function (app) {
  app.post("/api/account/save-history", async (req, res) => {
    try {
      const { name, id, date, b3Date, dataMap } = req.body;

      // 1. 환경변수 및 데이터베이스 ID 확인
      const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
      const DATABASE_ID = "2bf0b10191ce80568082ddb4deaab532"; // 사용자님이 알려주신 ID

      if (!NOTION_TOKEN) {
        return res.status(500).json({ ok: false, error: "Notion Token이 없습니다." });
      }

      // 2. 방대한 JSON 데이터를 문자열로 변환 후 2000자 단위로 쪼개기 (Notion 제약 해결)
      const jsonString = JSON.stringify(dataMap);
      const chunks = [];
      for (let i = 0; i < jsonString.length; i += 2000) {
        chunks.push(jsonString.substring(i, i + 2000));
      }

      // 3. 쪼갠 데이터를 노션 '코드 블록'들로 변환
      const childrenBlocks = chunks.map((chunk) => ({
        object: "block",
        type: "code",
        code: {
          language: "json",
          rich_text: [
            {
              type: "text",
              text: { content: chunk },
            },
          ],
        },
      }));

      // 4. 노션 API 호출 (페이지 생성)
      const response = await axios.post(
        "https://api.notion.com/v1/pages",
        {
          parent: { database_id: DATABASE_ID },
          properties: {
            "이름": {
              title: [
                {
                  text: { content: name },
                },
              ],
            },
            "ID": {
              number: Number(id),
            },
            "저장일시": {
              date: { start: new Date().toISOString() }, // 현재 시간 (ISO 8601)
            },
            "기준일자": {
              // b3Date가 있으면 ISO 포맷으로, 없으면 null
              date: b3Date ? { start: new Date(b3Date).toISOString() } : null,
            },
          },
          // 본문(Body)에 쪼개진 JSON 데이터 블록들 추가
          children: childrenBlocks,
        },
        {
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
          },
        }
      );

      // 5. 성공 응답
      res.status(200).json({ ok: true, message: "Notion에 저장되었습니다.", pageId: response.data.id });

    } catch (error) {
      console.error("Notion 저장 실패:", error.response?.data || error.message);
      res.status(500).json({
        ok: false,
        error: "Notion 저장 중 오류가 발생했습니다.",
        details: error.response?.data || error.message,
      });
    }
  });
};
