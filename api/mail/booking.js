const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

// 하드코딩 DB ID
const OCEAN_RATE_DB_ID = "33e0b10191ce806fb83cf8013b9a74b3";
const FORWARDER_CONTACT_DB_ID = "35a0b10191ce805eb7b4d62784874a79";
const PORT_CODE_DB_ID = "35a0b10191ce808fbac0d21a8968f3c3";

const PROP_POE = "POE";
const PROP_RELATION = "포워딩 연락처 및 운임 연결";
const PROP_PORT_CODE = "PORT CODE";
const PROP_PORT_NAME = "PORT NAME";
const PROP_CONTACT = "연락처";

let portMapCache = null;
let portMapCacheTime = 0;

let poeOptionsCache = null;
let poeOptionsCacheTime = 0;

const PORT_MAP_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 1주일
const POE_OPTIONS_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 1주일

function notionHeaders() {
  if (!NOTION_TOKEN) {
    throw new Error("NOTION_API_KEY 또는 NOTION_TOKEN이 설정되어 있지 않습니다.");
  }

  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
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
        ...(cursor ? { start_cursor: cursor } : {}),
      },
      { headers: notionHeaders() }
    );

    results.push(...(response.data.results || []));
    cursor = response.data.has_more ? response.data.next_cursor : null;
  } while (cursor);

  return results;
}

async function retrievePage(pageId) {
  const response = await axios.get(
    `https://api.notion.com/v1/pages/${pageId}`,
    { headers: notionHeaders() }
  );

  return response.data;
}

async function getPortMapCached() {
  const now = Date.now();

  if (portMapCache && now - portMapCacheTime < PORT_MAP_CACHE_TTL) {
    return portMapCache;
  }

  const portPages = await queryDatabase(PORT_CODE_DB_ID);
  const portMap = {};

  portPages.forEach(page => {
    const props = page.properties || {};

    const code = getTitle(props[PROP_PORT_CODE]);
    const name = getRichText(props[PROP_PORT_NAME]);

    if (code) {
      portMap[code] = name || code;
    }
  });

  portMapCache = portMap;
  portMapCacheTime = now;

  return portMap;
}

module.exports = function registerMailBookingRoutes(app) {
  // 1번 드롭다운: POE 코드 수집 후 PORT NAME으로 표시
  app.get("/api/mail/booking/poe-options", async (req, res) => {
    try {
      const now = Date.now();
  
      if (poeOptionsCache && now - poeOptionsCacheTime < POE_OPTIONS_CACHE_TTL) {
        return res.json({
          ok: true,
          cached: true,
          options: poeOptionsCache,
        });
      }
  
      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID);
      const portMap = await getPortMapCached();
  
      const poeSet = new Set();
  
      ratePages.forEach(page => {
        const poeList = getMultiSelectNames(page.properties?.[PROP_POE]);
        poeList.forEach(code => {
          if (code) poeSet.add(code);
        });
      });
  
      const options = Array.from(poeSet)
        .sort()
        .map(code => ({
          code,
          name: portMap[code] || code,
          label: portMap[code] ? `${portMap[code]} (${code})` : code,
        }));
  
      poeOptionsCache = options;
      poeOptionsCacheTime = now;
  
      return res.json({
        ok: true,
        cached: false,
        options,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "POE 드롭다운 조회 실패",
        details: e.response?.data || e.message || String(e),
      });
    }
  });

  // 2번 드롭다운: 선택한 POE와 일치하는 해상운임 row의 관계형 포워딩 목록
  app.get("/api/mail/booking/forwarders", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({
          ok: false,
          error: "poe 값이 필요합니다.",
        });
      }

      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          property: PROP_POE,
          multi_select: {
            contains: poe,
          },
        },
      });

      const forwarderIdSet = new Set();

      ratePages.forEach(page => {
        const ids = getRelationIds(page.properties?.[PROP_RELATION]);
        ids.forEach(id => forwarderIdSet.add(id));
      });

      const forwarders = [];

      for (const id of forwarderIdSet) {
        const page = await retrievePage(id);
        const props = page.properties || {};

        const titleProp = Object.values(props).find(prop => prop.type === "title");

        forwarders.push({
          id,
          name: getTitle(titleProp) || "이름 없음",
        });
      }

      forwarders.sort((a, b) => a.name.localeCompare(b.name, "ko"));

      res.json({
        ok: true,
        forwarders,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "포워딩 드롭다운 조회 실패",
        details: e.response?.data || e.message || String(e),
      });
    }
  });

  // 2번 드롭다운 선택 후 연락처 반환
  app.get("/api/mail/booking/forwarder-contact", async (req, res) => {
    try {
      const id = String(req.query.id || "").trim();

      if (!id) {
        return res.status(400).json({
          ok: false,
          error: "id 값이 필요합니다.",
        });
      }

      const page = await retrievePage(id);
      const props = page.properties || {};

      const titleProp = Object.values(props).find(prop => prop.type === "title");

      res.json({
        ok: true,
        contact: {
          id,
          name: getTitle(titleProp),
          contact: getRichText(props[PROP_CONTACT]),
        },
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: "포워딩 연락처 조회 실패",
        details: e.response?.data || e.message || String(e),
      });
    }
  });
    app.get("/api/mail/booking/pol-options", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();
      const forwarderId = String(req.query.forwarderId || "").trim();
  
      if (!poe || !forwarderId) {
        return res.status(400).json({
          ok: false,
          error: "poe와 forwarderId 값이 필요합니다.",
        });
      }
  
      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          and: [
            {
              property: "POE",
              multi_select: {
                contains: poe,
              },
            },
            {
              property: "포워딩 연락처 및 운임 연결",
              relation: {
                contains: forwarderId,
              },
            },
          ],
        },
      });
  
      const polSet = new Set();
  
      ratePages.forEach(page => {
        const podList = getMultiSelectNames(page.properties?.["POD"]);
        podList.forEach(v => {
          if (v) polSet.add(v);
        });
      });
  
      const options = Array.from(polSet).sort();
  
      return res.json({
        ok: true,
        options,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "POL 옵션 조회 실패",
        details: e.response?.data || e.message || String(e),
      });
    }
  });
  // 3번: 선택한 POE에 해당하는 운임표 데이터 가져오기
  app.get("/api/mail/booking/rates", async (req, res) => {
    try {
      const poe = String(req.query.poe || "").trim();

      if (!poe) {
        return res.status(400).json({ ok: false, error: "poe 값이 필요합니다." });
      }

      // POE 속성에서 일치하는 값을 가진 행 필터링
      const ratePages = await queryDatabase(OCEAN_RATE_DB_ID, {
        filter: {
          property: "POE",
          multi_select: {
            contains: poe,
          },
        },
      });

      // 필요한 속성만 추출
      const rates = ratePages.map(page => {
        const props = page.properties || {};
        
        // 날짜 속성은 시작일과 종료일 처리
        const validityStart = props["VALIDITY"]?.date?.start || "";
        const validityEnd = props["VALIDITY"]?.date?.end || "";
        const validityStr = validityEnd ? `${validityStart} ~ ${validityEnd}` : validityStart;

        return {
          id: page.id,
          forwarder: props["포워딩"]?.select?.name || "-",
          carrier: props["선사"]?.select?.name || "-",
          
          // 💡 수정된 부분: 일반 숫자가 아닌 '수식' 결과값(number)을 가져옵니다.
          dr20: props["20DR 합계"]?.formula?.number || 0,
          hc40: props["40HC 합계"]?.formula?.number || 0,
          
          validity: validityStr || "-",
        };
      });

      return res.json({
        ok: true,
        rates,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "운임 표 조회 실패",
        details: e.response?.data || e.message || String(e),
      });
    }
  });
};
