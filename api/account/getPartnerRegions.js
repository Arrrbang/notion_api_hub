// api/account/getPartnerRegions.js
const axios = require("axios");

const DATABASE_ID = "3fb0b10191ce8004b84ed846bb92dabd";

// Notion 텍스트/제목의 여러 조각을 하나의 문자열로 합칩니다.
function getText(property) {
  const parts = property?.rich_text || property?.title || [];

  return parts
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("")
    .trim();
}

module.exports = function (app) {
  app.get("/api/account/get-partner-regions", async (req, res) => {
    const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: "Notion Token이 설정되어 있지 않습니다.",
      });
    }

    try {
      const list = [];
      let cursor;

      // 100행을 초과하는 경우에도 전체 조회
      while (true) {
        const body = { page_size: 100 };

        if (cursor) {
          body.start_cursor = cursor;
        }

        const response = await axios.post(
          `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
          body,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Notion-Version": "2022-06-28",
            },
            timeout: 20000,
          }
        );

        for (const page of response.data.results) {
          const props = page.properties || {};
          const code = getText(props["CODE"]);

          // 매칭 기준 CODE가 없는 행은 제외
          if (!code) continue;

          list.push({
            pageId: page.id,
            code,
            partnerName: getText(props["파트너명"]),
            country: getText(props["국가"]),
            continent: getText(props["대륙"]),
          });
        }

        if (!response.data.has_more) break;

        cursor = response.data.next_cursor;

        if (!cursor) {
          throw new Error("다음 페이지 조회 커서가 없습니다.");
        }
      }

      // CODE별 조회용 맵 생성
      const grouped = new Map();

      for (const item of list) {
        if (!grouped.has(item.code)) {
          grouped.set(item.code, []);
        }

        grouped.get(item.code).push(item);
      }

      const regionMap = Object.create(null);
      const duplicateCodes = [];

      for (const [code, items] of grouped) {
        if (items.length > 1) {
          duplicateCodes.push(code);
          continue;
        }

        regionMap[code] = items[0];
      }

      res.setHeader("Cache-Control", "no-store");

      return res.status(200).json({
        ok: true,
        count: list.length,
        regionMap,
        duplicateCodes,
      });
    } catch (error) {
      console.error(
        "Partner Regions Error:",
        error.response?.data || error.message
      );

      return res.status(502).json({
        ok: false,
        error: "파트너 대륙·국가 정보를 불러오지 못했습니다.",
      });
    }
  });
};
