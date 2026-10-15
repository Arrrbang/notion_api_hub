const axios = require("axios");

const NOTION_TOKEN =
  process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

const OCEAN_RATE_DB_ID = "36f0b10191ce80939698cc910e2df427";
const FORWARDER_CONTACT_DB_ID = "35a0b10191ce805eb7b4d62784874a79";
const PORT_CODE_DB_ID = "36e0b10191ce804492fce82a1d2719c3";

const PROP_POE = "POE";
const PROP_RELATION = "포워딩 연락처 및 운임 연결";
const PROP_PORT_CODE = "PORT CODE";
const PROP_PORT_NAME = "PORT NAME";
const PROP_CONTACT = "연락처";

let poeOptionsCache = null;
let poeOptionsCacheTime = 0;

const POE_OPTIONS_CACHE_TTL = 1000 * 60 * 60 * 24 * 7;

function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error(
      "NOTION_API_KEY 또는 NOTION_TOKEN이 설정되어 있지 않습니다."
    );
  }

  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

function getTitle(prop) {
  return prop?.title?.map(t => t.plain_text).join("") || "";
}

function getRichText(prop) {
  return prop?.rich_text?.map(t => t.plain_text).join("") || "";
}

function getMultiSelectNames(prop) {
  return prop?.multi_select?.map(v => v.name).filter(Boolean) || [];
}

function getRelationIds(prop) {
  return prop?.relation?.map(v => v.id).filter(Boolean) || [];
}

async function queryDatabase(databaseId, body = {}) {
  const results = [];
  let cursor;

  do {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${databaseId}/query`,
      {
        ...body,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {})
      },
      {
        headers: notionHeaders()
      }
    );

    results.push(...(response.data.results || []));

    cursor = response.data.has_more
      ? response.data.next_cursor
      : null;
  } while (cursor);

  return results;
}

async function retrievePage(pageId) {
  const response = await axios.get(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      headers: notionHeaders()
    }
  );

  return response.data;
}

async function getAllForwarderIds(page) {
  const prop = page.properties?.[PROP_RELATION];

  if (!prop?.has_more) {
    return getRelationIds(prop);
  }

  const ids = [];
  let cursor;

  do {
    const response = await axios.get(
      `https://api.notion.com/v1/pages/${page.id}/properties/${encodeURIComponent(prop.id)}`,
      {
        headers: notionHeaders(),
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
      throw new Error("관계형 다음 페이지 조회 실패");
    }
  } while (cursor);

  return [...new Set(ids)];
}

module.exports = function registerMailBookingRoutes(app) {
  // POE 목록: PORT CODE DB의 PORT NAME 기준
  app.get("/api/mail/booking/poe-options", async (req, res) => {
    try {
      const now = Date.now();

      if (
        poeOptionsCache &&
        now - poeOptionsCacheTime < POE_OPTIONS_CACHE_TTL
      ) {
        return res.json({
          ok: true,
          cached: true,
          options: poeOptionsCache
        });
      }

      const portPages = await queryDatabase(PORT_CODE_DB_ID);

      // DB의 각 행을 하나의 옵션으로 사용합니다.
      // PORT NAME은 쉼표로 분리하지 않고 전체 제목을 표시합니다.
      // PORT CODE는 쉼표로 분리하여 검색용 코드 배열로 보관합니다.
      const options = portPages
        .map(page => {
          const props = page.properties || {};
          const name = getTitle(props[PROP_PORT_NAME]).trim();

          const codes = [
            ...new Set(
              getRichText(props[PROP_PORT_CODE])
                .split(",")
                .map(code => code.trim())
                .filter(Boolean)
            )
          ];

          return {
            id: page.id,
            code: codes.join(","),
            codes,
            name,
            label: name
          };
        })
        .filter(item => item.name && item.codes.length)
        .sort((a, b) => a.name.localeCompare(b.name, "ko"));

      poeOptionsCache = options;
      poeOptionsCacheTime = now;

      return res.json({
        ok: true,
        cached: false,
        options
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "POE 드롭다운 조회 실패",
        details: e.response?.data || e.message || String(e)
      });
    }
  });

  // 선택한 POE 코드와 일치하는 해상운임의 관계형 포워딩 목록
  app.get("/api/mail/booking/forwarders", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          property: PROP_POE,
          multi_select: {
            contains: poe
          }
        }
      });

      const forwarderIdSet = new Set();

      ratePages.forEach(page => {
        const ids = getRelationIds(
          page.properties?.[PROP_RELATION]
        );

        ids.forEach(id => forwarderIdSet.add(id));
      });

      const forwarders = [];

      for (const id of forwarderIdSet) {
        const page = await retrievePage(id);
        const props = page.properties || {};

        const titleProp = Object.values(props).find(
          prop => prop.type === "title"
        );

        forwarders.push({
          id,
          name: getTitle(titleProp) || "이름 없음"
        });
      }

      forwarders.sort(
        (a, b) => a.name.localeCompare(b.name, "ko")
      );

      return res.json({
        ok: true,
        forwarders
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "포워딩 드롭다운 조회 실패",
        details: e.response?.data || e.message || String(e)
      });
    }
  });

  // 포워딩 연락처
  app.get("/api/mail/booking/forwarder-contact", async (req, res) => {
    try {
      const id = String(req.query.id || "").trim();

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "id 값이 필요합니다."
        });
      }

      const page = await retrievePage(id);
      const props = page.properties || {};

      const titleProp = Object.values(props).find(
        prop => prop.type === "title"
      );

      return res.json({
        ok: true,
        contact: {
          id,
          name: getTitle(titleProp),
          contact: getRichText(props[PROP_CONTACT])
        }
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "포워딩 연락처 조회 실패",
        details: e.response?.data || e.message || String(e)
      });
    }
  });

  // POL 목록: 기존 POE 태그의 (BUS), (INC) 감지 방식 유지
  app.get("/api/mail/booking/pol-options", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          property: PROP_POE,
          multi_select: {
            contains: poe
          }
        }
      });

      const polSet = new Set();

      ratePages.forEach(page => {
        const poeList = getMultiSelectNames(
          page.properties?.[PROP_POE]
        );

        poeList.forEach(value => {
          if (value.includes("(BUS)")) {
            polSet.add("BUSAN");
          }

          if (value.includes("(INC)")) {
            polSet.add("INCHEON");
          }
        });
      });

      return res.json({
        ok: true,
        options: Array.from(polSet).sort()
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "POL 옵션 조회 실패",
        details: e.response?.data || e.message || String(e)
      });
    }
  });

  // 운임 목록
  app.get("/api/mail/booking/rates", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          property: PROP_POE,
          multi_select: {
            contains: poe
          }
        }
      });

      const idsByRate = new Map();
      const contactMap = new Map();

      for (const page of ratePages) {
        const ids = await getAllForwarderIds(page);

        idsByRate.set(page.id, ids);

        for (const id of ids) {
          if (contactMap.has(id)) continue;

          const linkedPage = await retrievePage(id);
          const props = linkedPage.properties || {};

          const titleProp = Object.values(props).find(
            prop => prop.type === "title"
          );

          contactMap.set(id, {
            id,
            name: getTitle(titleProp) || "이름 없음"
          });
        }
      }

      const rates = ratePages.map(page => {
        const props = page.properties || {};
        const start = props["VALIDITY"]?.date?.start || "";
        const end = props["VALIDITY"]?.date?.end || "";
        const forwarderIds = idsByRate.get(page.id) || [];

        return {
          id: page.id,
          forwarder: props["포워딩"]?.select?.name || "-",
          forwarderIds,
          linkedForwarders: forwarderIds.map(
            id => contactMap.get(id)
          ),
          carrier: props["선사"]?.select?.name || "-",
          dr20: props["20DR 최종"]?.formula?.number || 0,
          hc40: props["40HC 최종"]?.formula?.number || 0,
          validity:
            (end ? `${start} ~ ${end}` : start) || "-"
        };
      });

      return res.json({
        ok: true,
        rates
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "운임 표 조회 실패",
        details: e.response?.data || e.message || String(e)
      });
    }
  });
};
