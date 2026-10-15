const axios = require("axios");

// =====================================================
// 환경설정
// =====================================================

const NOTION_TOKEN =
  process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 해상운임 DB
const OCEAN_RATE_DB_ID = "36f0b10191ce80939698cc910e2df427";

// 포워딩 연락처 DB
const FORWARDER_CONTACT_DB_ID =
  "35a0b10191ce805eb7b4d62784874a79";

// 항구 코드 DB
const PORT_CODE_DB_ID = "36e0b10191ce804492fce82a1d2719c3";

// 노션 속성명
const PROP_POE = "POE";
const PROP_RELATION = "포워딩 연락처 및 운임 연결";
const PROP_PORT_CODE = "PORT CODE";
const PROP_PORT_NAME = "PORT NAME";
const PROP_CONTACT = "연락처";

// POE 목록 캐시
let poeOptionsCache = null;
let poeOptionsCacheTime = 0;

// 테스트 중에는 캐시 사용 안 함
const POE_OPTIONS_CACHE_TTL = 0;

// 테스트 종료 후 아래 설정으로 변경하면 7일 캐시
// const POE_OPTIONS_CACHE_TTL = 1000 * 60 * 60 * 24 * 7;

// =====================================================
// 공통 함수
// =====================================================

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

// 제목 속성의 텍스트
function getTitle(prop) {
  return prop?.title?.map(item => item.plain_text).join("") || "";
}

// 텍스트 속성의 텍스트
function getRichText(prop) {
  return (
    prop?.rich_text?.map(item => item.plain_text).join("") || ""
  );
}

// 다중선택 속성의 이름 배열
function getMultiSelectNames(prop) {
  return (
    prop?.multi_select
      ?.map(item => item.name)
      .filter(Boolean) || []
  );
}

// 관계형 속성의 페이지 ID 배열
function getRelationIds(prop) {
  return (
    prop?.relation
      ?.map(item => item.id)
      .filter(Boolean) || []
  );
}

// DB 전체 조회: 100개 초과 시 다음 페이지까지 조회
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

// 개별 페이지 조회
async function retrievePage(pageId) {
  const response = await axios.get(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      headers: notionHeaders()
    }
  );

  return response.data;
}

// 관계형 항목이 여러 페이지인 경우 전체 ID 조회
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

// =====================================================
// API 등록
// =====================================================

module.exports = function registerMailBookingRoutes(app) {
  // ---------------------------------------------------
  // 1. POE 드롭다운 목록
  //
  // 항구 코드 DB의 각 행을 하나의 옵션으로 사용
  // 표시 이름: PORT NAME 제목 전체
  // 검색 코드: PORT CODE 텍스트를 쉼표로 분리
  // ---------------------------------------------------

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

      const options = portPages
        .map(page => {
          const props = page.properties || {};

          // PORT NAME은 분리하지 않고 제목 전체 사용
          const name = getTitle(
            props[PROP_PORT_NAME]
          ).trim();

          // PORT CODE는 쉼표로 분리하고 중복 제거
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
        .sort((a, b) =>
          a.name.localeCompare(b.name, "ko")
        );

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
        details:
          e.response?.data || e.message || String(e)
      });
    }
  });

  // ---------------------------------------------------
  // 2. POE 코드에 연결된 포워딩 목록
  // ---------------------------------------------------

  app.get("/api/mail/booking/forwarders", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(
        OCEAN_RATE_DB_ID,
        {
          filter: {
            property: PROP_POE,
            multi_select: {
              contains: poe
            }
          }
        }
      );

      const forwarderIdSet = new Set();

      ratePages.forEach(page => {
        const ids = getRelationIds(
          page.properties?.[PROP_RELATION]
        );

        ids.forEach(id => {
          forwarderIdSet.add(id);
        });
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

      forwarders.sort((a, b) =>
        a.name.localeCompare(b.name, "ko")
      );

      return res.json({
        ok: true,
        forwarders
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "포워딩 드롭다운 조회 실패",
        details:
          e.response?.data || e.message || String(e)
      });
    }
  });

  // ---------------------------------------------------
  // 3. 전체 포워딩 목록
  //
  // 운임이 없는 지역에서 직접 선택할 목록
  // 기존 포워딩 연락처 DB의 전체 행 조회
  // ---------------------------------------------------

  app.get(
    "/api/mail/booking/forwarder-options",
    async (req, res) => {
      try {
        const pages = await queryDatabase(
          FORWARDER_CONTACT_DB_ID
        );

        const forwarders = pages
          .map(page => {
            const props = page.properties || {};

            const titleProp = Object.values(props).find(
              prop => prop.type === "title"
            );

            return {
              id: page.id,
              name: getTitle(titleProp).trim()
            };
          })
          .filter(item => item.name)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "ko")
          );

        return res.json({
          ok: true,
          forwarders
        });
      } catch (e) {
        return res.status(500).json({
          ok: false,
          error: "전체 포워딩 목록 조회 실패",
          details:
            e.response?.data || e.message || String(e)
        });
      }
    }
  );

  // ---------------------------------------------------
  // 4. 선택한 포워딩의 연락처
  //
  // 운임표에서 선택한 경우와
  // 전체 목록에서 직접 선택한 경우에 공통 사용
  // ---------------------------------------------------

  app.get(
    "/api/mail/booking/forwarder-contact",
    async (req, res) => {
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
            contact: getRichText(
              props[PROP_CONTACT]
            )
          }
        });
      } catch (e) {
        return res.status(500).json({
          ok: false,
          error: "포워딩 연락처 조회 실패",
          details:
            e.response?.data || e.message || String(e)
        });
      }
    }
  );

  // ---------------------------------------------------
  // 5. POL 목록
  //
  // 기존 방식 유지:
  // 조회한 운임 행의 POE 태그에
  // (BUS)가 있으면 BUSAN
  // (INC)가 있으면 INCHEON
  // ---------------------------------------------------

  app.get("/api/mail/booking/pol-options", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(
        OCEAN_RATE_DB_ID,
        {
          filter: {
            property: PROP_POE,
            multi_select: {
              contains: poe
            }
          }
        }
      );

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
        details:
          e.response?.data || e.message || String(e)
      });
    }
  });

  // ---------------------------------------------------
  // 6. 운임 목록
  //
  // 프론트에서 PORT CODE별로 호출한 뒤
  // 동일한 노션 행 ID는 중복 제거
  // ---------------------------------------------------

  app.get("/api/mail/booking/rates", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다."
        });
      }

      const ratePages = await queryDatabase(
        OCEAN_RATE_DB_ID,
        {
          filter: {
            property: PROP_POE,
            multi_select: {
              contains: poe
            }
          }
        }
      );

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

        const start =
          props["VALIDITY"]?.date?.start || "";

        const end =
          props["VALIDITY"]?.date?.end || "";

        const forwarderIds =
          idsByRate.get(page.id) || [];

        return {
          id: page.id,

          forwarder:
            props["포워딩"]?.select?.name || "-",

          forwarderIds,

          linkedForwarders: forwarderIds.map(
            id => contactMap.get(id)
          ),

          carrier:
            props["선사"]?.select?.name || "-",

          dr20:
            props["20DR 최종"]?.formula?.number || 0,

          hc40:
            props["40HC 최종"]?.formula?.number || 0,

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
        details:
          e.response?.data || e.message || String(e)
      });
    }
  });
};
