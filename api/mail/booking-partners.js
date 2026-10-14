const axios = require("axios");

const PARTNER_DB_ID = "34a0b10191ce805aacefcf62acfa15f6";
const PARTNER_INFO_DB_ID = "34a0b10191ce80c3b3aefd1fabbcbd55";

const PROP_POE = "POE";
const PROP_PARTNER_RELATION = "파트너 연결";
const PROP_INFO_TITLE = "이름";

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

// 파트너 POE 텍스트에서 대괄호 내부 코드만 추출
function extractPartnerPoeCodes(text) {
  return [...new Set(
    Array.from(
      String(text || "").matchAll(/\[([^\[\]]+)\]/g)
    )
      .map(match => match[1].trim().toUpperCase())
      .filter(Boolean)
  )];
}

// DB의 모든 페이지 조회
async function queryDatabase(databaseId, body = {}) {
  const pages = [];
  let cursor = null;

  do {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        ...body,
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
        "DB의 다음 페이지 정보를 받지 못했습니다."
      );
    }
  } while (cursor);

  return pages;
}

// 페이지 ID의 하이픈 표기 차이 제거
function normalizePageId(id) {
  return String(id || "")
    .replace(/-/g, "")
    .toLowerCase();
}

// 제목의 공백 차이를 허용
function isBlTypeRow(properties) {
  const title = (properties[PROP_INFO_TITLE]?.title || [])
    .map(item =>
      item.plain_text ?? item.text?.content ?? ""
    )
    .join("");

  return (
    title.replace(/\s+/g, "").toUpperCase() === "3.BLTYPE"
  );
}

// 관계형 속성에 연결된 파트너 ID 조회
async function getLinkedPartnerIds(page) {
  const prop = page.properties?.[PROP_PARTNER_RELATION];

  if (!prop?.relation) return [];

  if (!prop.has_more) {
    return prop.relation.map(item => item.id);
  }

  // 관계형 값이 잘린 경우 다음 페이지까지 조회
  const ids = [];
  let cursor = null;

  do {
    const response = await axios.get(
      `https://api.notion.com/v1/pages/${page.id}/properties/${encodeURIComponent(prop.id)}`,
      {
        headers: notionHeaders(),
        timeout: 30000,
        params: {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        }
      }
    );

    for (const item of response.data.results || []) {
      if (item.relation?.id) {
        ids.push(item.relation.id);
      }
    }

    cursor = response.data.has_more
      ? response.data.next_cursor
      : null;

    if (response.data.has_more && !cursor) {
      throw new Error(
        "관계형 속성의 다음 페이지 정보를 받지 못했습니다."
      );
    }
  } while (cursor);

  return ids;
}

// 각 파트너에 중복 없는 BL TYPE 목록 추가
async function addBlTypes(partners) {
  partners.forEach(partner => {
    partner.blTypes = [];
  });

  if (!partners.length) return;

  const partnerMap = new Map(
    partners.map(partner => [
      normalizePageId(partner.id),
      partner
    ])
  );

  const seenByPartner = new Map(
    partners.map(partner => [
      normalizePageId(partner.id),
      new Set()
    ])
  );

  const rows = await queryDatabase(PARTNER_INFO_DB_ID);

  for (const row of rows) {
    const properties = row.properties || {};

    if (!isBlTypeRow(properties)) continue;

    const linkedIds = await getLinkedPartnerIds(row);

    const matchedIds = [
      ...new Set(linkedIds.map(normalizePageId))
    ].filter(id => partnerMap.has(id));

    if (!matchedIds.length) continue;

  // 열 제목에 MBL이 포함된 텍스트 속성만 가져옵니다.
  const values = Object.entries(properties)
    .filter(([columnName, prop]) =>
      columnName.toUpperCase().includes("MBL") &&
      prop?.type === "rich_text"
    )
    .map(([, prop]) => getRichText(prop))
    .filter(value => value.trim() !== "");

    for (const id of matchedIds) {
      const partner = partnerMap.get(id);
      const seen = seenByPartner.get(id);

      for (const value of values) {
        if (seen.has(value)) continue;

        seen.add(value);
        partner.blTypes.push(value);
      }
    }
  }
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
      const pages = await queryDatabase(PARTNER_DB_ID);
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

      await addBlTypes(partners);

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
