const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 파트너 DB
const PARTNER_DB_ID = "34a0b10191ce805aacefcf62acfa15f6";

// Notion 속성명
const PROP_NAME = "이름";
const PROP_MANAGER_EMAIL = "담당자 이메일";
const PROP_QUOTE_EMAIL = "견적 이메일";

// 파트너 목록 캐시
let partnerOptionsCache = null;
let partnerOptionsCacheTime = 0;

// 1시간 캐시
const PARTNER_OPTIONS_CACHE_TTL = 1000 * 60 * 60;


function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error(
      "NOTION_API_KEY 또는 NOTION_TOKEN이 설정되어 있지 않습니다."
    );
  }

  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}


// 제목 속성 읽기
function getTitle(prop) {
  return prop?.title?.map(t => t.plain_text).join("") || "";
}


// 이메일 속성 읽기
function getEmail(prop) {
  if (!prop) return "";

  // Notion Email 속성
  if (prop.type === "email") {
    return prop.email || "";
  }

  // 혹시 Rich Text 속성으로 되어 있을 경우 fallback
  if (prop.rich_text) {
    return prop.rich_text
      .map(t => t.plain_text)
      .join("") || "";
  }

  return "";
}


// Notion DB 전체 조회
async function queryDatabase(databaseId, body = {}) {
  const results = [];
  let cursor;

  do {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        ...body,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      {
        headers: notionHeaders(),
      }
    );

    results.push(...(response.data.results || []));

    cursor = response.data.has_more
      ? response.data.next_cursor
      : null;

  } while (cursor);

  return results;
}


// Notion 페이지 1개 조회
async function retrievePage(pageId) {
  const response = await axios.get(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      headers: notionHeaders(),
    }
  );

  return response.data;
}


// 파트너 목록 캐시
async function getPartnerOptionsCached() {
  const now = Date.now();

  if (
    partnerOptionsCache &&
    now - partnerOptionsCacheTime < PARTNER_OPTIONS_CACHE_TTL
  ) {
    return partnerOptionsCache;
  }

  const pages = await queryDatabase(PARTNER_DB_ID);

  const options = pages
    .map(page => {
      const props = page.properties || {};

      return {
        id: page.id,
        name: getTitle(props[PROP_NAME]),
      };
    })
    .filter(item => item.name)
    .sort((a, b) =>
      a.name.localeCompare(b.name, "ko")
    );

  partnerOptionsCache = options;
  partnerOptionsCacheTime = now;

  return options;
}


module.exports = function registerMailGreenlightRoutes(app) {

  /*
  ───────────────────────────────────────
  파트너 목록

  GET
  /api/mail/greenlight/partners

  검색:
  /api/mail/greenlight/partners?q=santa

  반환 예시:

  {
    ok: true,
    options: [
      {
        id: "...",
        name: "SANTA FE"
      }
    ]
  }

  ───────────────────────────────────────
  */

  app.get(
    "/api/mail/greenlight/partners",
    async (req, res) => {

      try {

        const q = String(
          req.query.q || ""
        )
          .trim()
          .toLowerCase();

        const options =
          await getPartnerOptionsCached();

        const filtered = q
          ? options.filter(item =>
              item.name
                .toLowerCase()
                .includes(q)
            )
          : options;

        return res.json({
          ok: true,
          options: filtered,
        });

      } catch (e) {

        return res.status(500).json({
          ok: false,
          error: "파트너 목록 조회 실패",
          details:
            e.response?.data ||
            e.message ||
            String(e),
        });

      }

    }
  );


  /*
  ───────────────────────────────────────
  선택한 파트너 이메일 조회

  GET
  /api/mail/greenlight/partner?id=NOTION_PAGE_ID

  반환 예시:

  {
    ok: true,
    partner: {
      id: "...",
      name: "SANTA FE",
      managerEmail: "abc@email.com",
      quoteEmail: "quote@email.com"
    }
  }

  ───────────────────────────────────────
  */

  app.get(
    "/api/mail/greenlight/partner",
    async (req, res) => {

      try {

        const id = String(
          req.query.id || ""
        ).trim();

        if (!id) {

          return res.status(400).json({
            ok: false,
            error: "파트너 id 값이 필요합니다.",
          });

        }


        const page =
          await retrievePage(id);

        const props =
          page.properties || {};


        return res.json({
          ok: true,

          partner: {
            id: page.id,

            name: getTitle(
              props[PROP_NAME]
            ),

            managerEmail: getEmail(
              props[PROP_MANAGER_EMAIL]
            ),

            quoteEmail: getEmail(
              props[PROP_QUOTE_EMAIL]
            ),
          },

        });

      } catch (e) {

        return res.status(500).json({
          ok: false,
          error: "파트너 이메일 조회 실패",
          details:
            e.response?.data ||
            e.message ||
            String(e),
        });

      }

    }
  );

};
