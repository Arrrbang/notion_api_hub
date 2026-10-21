const axios = require("axios");

const DELIVERY_REGION_DB_ID = "3720b10191ce80e291e3ca782bb6f0a1";
const PORT_CODE_DB_ID = "36e0b10191ce804492fce82a1d2719c3";
const text = prop => (prop?.rich_text || []).map(item => item.plain_text ?? item.text?.content ?? "").join("");
const title = prop => (prop?.title || []).map(item => item.plain_text ?? item.text?.content ?? "").join("");
// 접두어를 제거하지 않습니다. (BUS)USLAX와 (INC)USLAX는 서로 다른 조회 키입니다.
const splitCodes = value => [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];

async function queryAll(databaseId) {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
  if (!token) throw new Error("Notion API token is missing");
  const pages = [];
  let cursor;
  do {
    const response = await axios.post(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    }, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      }
    });
    pages.push(...(response.data.results || []));
    cursor = response.data.has_more ? response.data.next_cursor : null;
  } while (cursor);
  return pages;
}

module.exports = function registerRateSearchRoutes(app) {
  app.get("/api/rate-search/delivery-regions", async (req, res) => {
    try {
      const pages = await queryAll(DELIVERY_REGION_DB_ID);
      const regions = new Map();
      for (const page of pages) {
        for (const name of splitCodes(text(page.properties?.["배송지역"]))) {
          if (!regions.has(name)) regions.set(name, new Set());
          regions.get(name).add(page.id);
        }
      }
      const options = [...regions].map(([name, ids]) => ({
        value: name, name, label: name, sourcePageIds: [...ids]
      })).sort((a, b) => a.name.localeCompare(b.name, "ko"));
      res.json({ ok: true, options });
    } catch (error) {
      console.error("[rate-search/delivery-regions]", error.response?.status || error.code || error.message);
      res.status(500).json({ ok: false, error: "배송지역 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });

  app.get("/api/rate-search/arrival-ports", async (req, res) => {
    try {
      const pages = await queryAll(PORT_CODE_DB_ID);
      const options = pages.map(page => {
        const name = title(page.properties?.["PORT NAME"]).trim();
        const codes = splitCodes(text(page.properties?.["PORT CODE"]));
        return { id: page.id, value: page.id, name, label: name, code: codes.join(","), codes };
      }).filter(item => item.name).sort((a, b) => a.name.localeCompare(b.name, "ko"));
      // PORT CODE가 없어도 PORT NAME이 있으면 목록에 표시합니다.
      res.json({ ok: true, options });
    } catch (error) {
      console.error("[rate-search/arrival-ports]", error.response?.status || error.code || error.message);
      res.status(500).json({ ok: false, error: "도착항구 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." });
    }
  });
};
