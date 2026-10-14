const axios = require("axios");

const PARTNER_DB_ID = "34a0b10191ce805aacefcf62acfa15f6";
const PROP_POE = "POE";

function notionHeaders() {
  const token =
    process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

  if (!token) {
    throw new Error(
      "NOTION_API_KEY 또는 NOTION_TOKEN이 설정되어 있지 않습니다."
    );
  }

  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// (BUS)USLAX,(BUS)USLGB → ["USLAX", "USLGB"]
function normalizeSelectedPoe(value) {
  return [...new Set(
    String(value || "")
      .split(",")
      .map(code =>
        code
          .replace(/\([^)]*\)/g, "")
          .trim()
          .toUpperCase()
      )
      .filter(Boolean)
  )];
}

function getRichText(prop) {
  // 텍스트 조각을 먼저 합쳐서 대괄호를 추출합니다.
  return (prop?.rich_text || [])
    .map(item =>
      item.plain_text ?? item.text?.content ?? ""
    )
    .join("");
}

function getTitle(properties) {
  const titleProp = Object.values(properties).find(
    prop => prop?.type === "title"
  );

  return (titleProp?.title || [])
    .map(item =>
      item.plain_text ?? item.text?.content ?? ""
    )
    .join("");
}

// "[USNYC] NEW YORK, [USLGB] LONG BEACH"
// → ["USNYC", "USLGB"]
// 대괄호 밖의 텍스트는 비교하지 않습니다.
function extractPartnerPoeCodes(text) {
  return [...new Set(
    Array.from(
      String(text || "").matchAll(/\[([^\[\]]+)\]/g)
    )
      .map(match => match[1].trim().toUpperCase())
      .filter(Boolean)
  )];
}

// 100개를 초과하는 경우 다음 페이지까지 모두 조회
async function queryAllPartners() {
  const pages = [];
  let cursor = null;

  do {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${PARTNER_DB_ID}/query`,
      {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      },
      {
        headers: notionHeaders(),
        timeout: 30000
      }
    );

    pages.push(...(response.data.results || []));

    cursor = response.data.has_more
      ? response.data.next_cursor
      : null;

    if (response.data.has_more && !cursor) {
      throw new Error(
        "파트너 DB의 다음 페이지 정보를 받지 못했습니다."
      );
    }
  } while (cursor);

  return pages;
}

module.exports = function registerBookingPartnerRoutes(app) {
  app.get("/api/mail/booking/partners", async (req, res) => {
    const rawPoe = req.query.poe;

    if (typeof rawPoe !== "string" || !rawPoe.trim()) {
      return res.status(400).json({
        ok: false,
        error:
          "poe에 POE 값을 전달해 주세요. 여러 값은 쉼표로 구분합니다."
      });
    }

    const codes = normalizeSelectedPoe(rawPoe);

    if (!codes.length) {
      return res.status(400).json({
        ok: false,
        error: "비교할 POE 코드가 없습니다."
      });
    }

    try {
      const pages = await queryAllPartners();
      const selectedCodes = new Set(codes);
      const partners = [];
      const includedIds = new Set();

      for (const page of pages) {
        if (includedIds.has(page.id)) continue;

        const properties = page.properties || {};
        const poeText = getRichText(properties[PROP_POE]);
        const poeCodes = extractPartnerPoeCodes(poeText);

        const matchedCodes = poeCodes.filter(
          code => selectedCodes.has(code)
        );

        if (!matchedCodes.length) continue;

        includedIds.add(page.id);

        partners.push({
          id: page.id,
          name: getTitle(properties) || "이름 없음",
          poeText,
          poeCodes,
          matchedCodes
        });
      }

      partners.sort((a, b) =>
        a.name.localeCompare(b.name, "ko")
      );

      return res.json({
        ok: true,
        codes,
        count: partners.length,
        partners
      });
    } catch (error) {
      console.error(
        "POE 파트너 조회 실패:",
        error.response?.status || error.message
      );

      return res.status(500).json({
        ok: false,
        error: "POE 파트너 조회 실패"
      });
    }
  });
};
