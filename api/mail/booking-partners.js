const axios = require("axios");

// =====================================================
// DB 설정
// =====================================================

// 파트너 DB
const PARTNER_DB_ID =
  "34a0b10191ce805aacefcf62acfa15f6";

// BL TYPE 등 파트너 정보 DB
const PARTNER_INFO_DB_ID =
  "34a0b10191ce80c3b3aefd1fabbcbd55";

// 선사 관련 문서 DB
const PARTNER_DOC_DB_ID =
  "34a0b10191ce800988a9dd777d4dc05c";

// 국가 매칭용 DB
const COUNTRY_DB_ID =
  "34a0b10191ce80adb5ecd175a478b3da";

// =====================================================
// 노션 속성명
// =====================================================

const PROP_POE = "POE";

// 파트너 DB → 국가 매칭용 DB
const PROP_PARTNER_COUNTRY = "국가";

// 국가 매칭용 DB → 문서 DB
const PROP_COUNTRY_DOCUMENTS = "국가별 공지사항 연결";

// 정보 DB / 문서 DB → 파트너 DB
const PROP_PARTNER_RELATION = "파트너 연결";

const PROP_INFO_TITLE = "이름";
const PROP_DOC_TYPE = "문서타입";
const DOC_TYPE_VALUE = "선 사 관 련";
const PROP_DOC_UPDATED = "업데이트일자";

// =====================================================
// 공통 함수
// =====================================================

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

function normalizePageId(id) {
  return String(id || "")
    .replace(/-/g, "")
    .toLowerCase();
}

function validNotionId(value) {
  return (
    typeof value === "string" &&
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      value
    )
  );
}

function normalizeSelectedPoe(value) {
  return [
    ...new Set(
      String(value || "")
        .split(",")
        .map(code =>
          code
            .replace(/\([^)]*\)/g, "")
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
  ];
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

function extractPartnerPoeCodes(text) {
  return [
    ...new Set(
      Array.from(
        String(text || "").matchAll(/\[([^\[\]]+)\]/g)
      )
        .map(match => match[1].trim().toUpperCase())
        .filter(Boolean)
    )
  ];
}

// DB全件 조회: 100개 초과 시 다음 페이지 조회
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

// 개별 페이지 조회
async function retrievePage(pageId) {
  const response = await axios.get(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      headers: notionHeaders(),
      timeout: 30000
    }
  );

  return response.data;
}

// 관계형 속성의 전체 페이지 ID 조회
async function getRelationIds(page, propertyName) {
  const prop = page.properties?.[propertyName];

  if (!prop?.relation) return [];

  if (!prop.has_more) {
    return [
      ...new Set(
        prop.relation
          .map(item => item.id)
          .filter(Boolean)
      )
    ];
  }

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

  return [...new Set(ids)];
}

async function getLinkedPartnerIds(page) {
  return getRelationIds(page, PROP_PARTNER_RELATION);
}

function getErrorMessage(error) {
  return (
    error.response?.data?.message ||
    error.message ||
    "알 수 없는 오류"
  );
}

function logNotionError(label, error) {
  console.error(
    label,
    JSON.stringify(
      {
        status: error.response?.status,
        details: error.response?.data,
        message: getErrorMessage(error)
      },
      null,
      2
    )
  );
}

// =====================================================
// BL TYPE
// =====================================================

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

// 기존 파트너 연결 기준 유지
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

    // 열 제목에 MBL이 포함된 텍스트 속성만 수집
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

// =====================================================
// 국가에 연결된 문서
// =====================================================

// 파트너 DB의 "국가" 관계형 조회
async function getPartnerCountryIds(partnerId) {
  const page = await retrievePage(partnerId);

  if (
    normalizePageId(page.parent?.database_id) !==
      normalizePageId(PARTNER_DB_ID) ||
    page.archived ||
    page.in_trash
  ) {
    const error = new Error(
      "해당 파트너를 찾을 수 없습니다."
    );

    error.response = { status: 404 };
    throw error;
  }

  return getRelationIds(page, PROP_PARTNER_COUNTRY);
}

// 파트너 → 국가 → 국가별 공지사항 연결 → 문서 ID
async function getCountryDocumentIds(partnerId) {
  const countryIds = await getPartnerCountryIds(partnerId);
  const documentIds = new Map();

  for (const countryId of countryIds) {
    const countryPage = await retrievePage(countryId);

    if (
      normalizePageId(countryPage.parent?.database_id) !==
        normalizePageId(COUNTRY_DB_ID) ||
      countryPage.archived ||
      countryPage.in_trash
    ) {
      continue;
    }

    const linkedDocumentIds = await getRelationIds(
      countryPage,
      PROP_COUNTRY_DOCUMENTS
    );

    for (const id of linkedDocumentIds) {
      documentIds.set(normalizePageId(id), id);
    }
  }

  return [...documentIds.values()];
}

// 표시 가능한 선사 관련 문서인지 확인
function isCarrierDocument(page) {
  return (
    normalizePageId(page.parent?.database_id) ===
      normalizePageId(PARTNER_DOC_DB_ID) &&
    page.properties?.[PROP_DOC_TYPE]?.select?.name ===
      DOC_TYPE_VALUE &&
    !page.archived &&
    !page.in_trash
  );
}

// 파트너 직접 연결 또는 국가 공지사항 연결 여부 확인
async function matchesPartnerOrCountry(page, partnerId) {
  const linkedPartnerIds = await getLinkedPartnerIds(page);

  const directlyLinked = linkedPartnerIds.some(
    id =>
      normalizePageId(id) === normalizePageId(partnerId)
  );

  if (directlyLinked) return true;

  const countryDocumentIds =
    await getCountryDocumentIds(partnerId);

  return countryDocumentIds.some(
    id =>
      normalizePageId(id) === normalizePageId(page.id)
  );
}

// =====================================================
// 문서 요약 / 본문 렌더링
// =====================================================

function documentSummary(page) {
  const date = page.properties?.[PROP_DOC_UPDATED]?.date;

  return {
    id: page.id,
    title:
      getTitle(page.properties || {}) || "제목 없음",
    url: page.url || "",
    updatedDate: date
      ? {
          start: date.start,
          end: date.end || null,
          timeZone: date.time_zone || null
        }
      : null
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c])
  );
}

function safeTextLink(value) {
  try {
    const url = new URL(value);

    return ["https:", "http:", "mailto:"].includes(
      url.protocol
    )
      ? url.href
      : "";
  } catch {
    return "";
  }
}

const NOTION_COLORS = {
  gray: "#787774",
  brown: "#9f6b53",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
  gray_background: "#f1f1ef",
  brown_background: "#f4eeee",
  orange_background: "#fbecdd",
  yellow_background: "#fbf3db",
  green_background: "#edf3ec",
  blue_background: "#e7f3f8",
  purple_background: "#f4f0f7",
  pink_background: "#f9eef3",
  red_background: "#fdebec"
};

function colorStyle(color) {
  if (!NOTION_COLORS[color]) return "";

  const property = color.endsWith("_background")
    ? "background-color"
    : "color";

  return `${property}:${NOTION_COLORS[color]};`;
}

function renderRichText(items = []) {
  return items.map(item => {
    let html = escapeHtml(
      item.plain_text ??
      item.text?.content ??
      item.equation?.expression ??
      ""
    );

    const annotations = item.annotations || {};

    if (annotations.code) {
      html = `<code>${html}</code>`;
    }

    if (annotations.bold) {
      html = `<strong>${html}</strong>`;
    }

    if (annotations.italic) {
      html = `<em>${html}</em>`;
    }

    if (annotations.strikethrough) {
      html = `<s>${html}</s>`;
    }

    if (annotations.underline) {
      html = `<u>${html}</u>`;
    }

    const style = colorStyle(annotations.color);

    if (style) {
      html = `<span style="${style}">${html}</span>`;
    }

    const link = safeTextLink(
      item.href || item.text?.link?.url || ""
    );

    if (link) {
      html = `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
    }

    return html;
  }).join("");
}

async function readTextBlocks(blockId) {
  const blocks = [];
  let cursor = null;

  do {
    const response = await axios.get(
      `https://api.notion.com/v1/blocks/${blockId}/children`,
      {
        headers: notionHeaders(),
        timeout: 30000,
        params: {
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {})
        }
      }
    );

    blocks.push(...(response.data.results || []));

    cursor = response.data.has_more
      ? response.data.next_cursor
      : null;

    if (response.data.has_more && !cursor) {
      throw new Error(
        "본문의 다음 페이지 정보가 없습니다."
      );
    }
  } while (cursor);

  const textTypes = new Set([
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "toggle",
    "quote",
    "callout",
    "code",
    "table",
    "table_row",
    "column_list",
    "column",
    "synced_block",
    "divider",
    "equation"
  ]);

  const result = [];

  for (const block of blocks) {
    if (
      !textTypes.has(block.type) ||
      block.archived ||
      block.in_trash
    ) {
      continue;
    }

    const children = block.has_children
      ? await readTextBlocks(block.id)
      : [];

    result.push({ ...block, children });
  }

  return result;
}

function renderBlocks(blocks) {
  let html = "";
  let listType = null;

  function closeList() {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  }

  for (const block of blocks) {
    const type = block.type;
    const data = block[type] || {};
    const text = renderRichText(data.rich_text || []);
    const children = renderBlocks(block.children || []);
    const style = colorStyle(data.color);
    const attrs = style ? ` style="${style}"` : "";

    if (
      type === "bulleted_list_item" ||
      type === "numbered_list_item"
    ) {
      const tag =
        type === "bulleted_list_item" ? "ul" : "ol";

      if (listType !== tag) {
        closeList();
        html += `<${tag}>`;
        listType = tag;
      }

      html += `<li${attrs}>${text}${children}</li>`;
      continue;
    }

    closeList();

    if (type === "paragraph") {
      html += `<div class="notion-paragraph"${attrs}>${text || "<br>"}${children}</div>`;
    } else if (/^heading_[123]$/.test(type)) {
      const n = type.slice(-1);

      html += `<h${n}${attrs}>${text}</h${n}>${children}`;
    } else if (type === "quote") {
      html += `<blockquote${attrs}>${text}${children}</blockquote>`;
    } else if (type === "callout") {
      html += `<aside class="notion-callout"${attrs}>${text}${children}</aside>`;
    } else if (type === "toggle") {
      html += `<details open${attrs}><summary>${text}</summary>${children}</details>`;
    } else if (type === "to_do") {
      html += `<div class="notion-todo"${attrs}><span aria-label="${data.checked ? "완료" : "미완료"}">${data.checked ? "☑" : "☐"}</span> ${text}${children}</div>`;
    } else if (type === "code") {
      html += `<pre${attrs}><code>${text}</code></pre>${children}`;
    } else if (type === "divider") {
      html += "<hr>";
    } else if (type === "equation") {
      html += `<div>${escapeHtml(data.expression)}</div>`;
    } else if (type === "table") {
      const rows = (block.children || [])
        .map((row, i) => {
          const cells = (row.table_row?.cells || [])
            .map((cell, j) => {
              const isHeader =
                (data.has_column_header && i === 0) ||
                (data.has_row_header && j === 0);

              const tag = isHeader ? "th" : "td";

              return `<${tag}>${renderRichText(cell)}</${tag}>`;
            })
            .join("");

          return `<tr>${cells}</tr>`;
        })
        .join("");

      html += `<div class="notion-table-wrap"><table><tbody>${rows}</tbody></table></div>`;
    } else {
      html += children;
    }
  }

  closeList();

  return html;
}

// =====================================================
// 문서 API
// =====================================================

function registerPartnerDocumentRoutes(app) {
  // ---------------------------------------------------
  // 문서 목록
  //
  // 1. 선택한 파트너에 직접 연결된 문서
  // 2. 파트너의 국가 → 국가별 공지사항 연결 문서
  //
  // 위 두 결과를 합친 후 "선 사 관 련"만 표시
  // ---------------------------------------------------

  app.get(
    "/api/mail/booking/partner-documents",
    async (req, res) => {
      const partnerId = req.query.partnerId;

      if (!validNotionId(partnerId)) {
        return res.status(400).json({
          ok: false,
          error: "유효한 partnerId가 필요합니다."
        });
      }

      try {
        // 파트너에 직접 연결된 선사 관련 문서
        const partnerDocuments = await queryDatabase(
          PARTNER_DOC_DB_ID,
          {
            filter: {
              and: [
                {
                  property: PROP_PARTNER_RELATION,
                  relation: {
                    contains: partnerId
                  }
                },
                {
                  property: PROP_DOC_TYPE,
                  select: {
                    equals: DOC_TYPE_VALUE
                  }
                }
              ]
            }
          }
        );

        const pagesById = new Map();

        for (const page of partnerDocuments) {
          if (isCarrierDocument(page)) {
            pagesById.set(
              normalizePageId(page.id),
              page
            );
          }
        }

        // 국가 페이지의 "국가별 공지사항 연결" 문서
        const countryDocumentIds =
          await getCountryDocumentIds(partnerId);

        for (const documentId of countryDocumentIds) {
          const normalizedId =
            normalizePageId(documentId);

          // 이미 수집한 문서는 중복 조회하지 않음
          if (pagesById.has(normalizedId)) continue;

          let page;

          try {
            page = await retrievePage(documentId);
          } catch (error) {
            // 삭제되었거나 접근할 수 없는 개별 문서는 제외
            if (error.response?.status === 404) {
              continue;
            }

            throw error;
          }

          // 지정된 문서 DB의 선사 관련 문서만 수집
          if (!isCarrierDocument(page)) continue;

          pagesById.set(normalizedId, page);
        }

        const documents = [...pagesById.values()]
          .map(documentSummary);

        // 업데이트일자 내림차순
        documents.sort((a, b) =>
          (b.updatedDate?.start || "")
            .localeCompare(a.updatedDate?.start || "")
        );

        return res.json({
          ok: true,
          partnerId,
          count: documents.length,
          documents
        });
      } catch (error) {
        logNotionError(
          "파트너 문서 목록 조회 실패:",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            `파트너 문서 목록 조회 실패: ${getErrorMessage(error)}`
        });
      }
    }
  );

  // ---------------------------------------------------
  // 선택한 문서의 본문
  // ---------------------------------------------------

  app.get(
    "/api/mail/booking/partner-documents/:pageId",
    async (req, res) => {
      const { pageId } = req.params;
      const partnerId = req.query.partnerId;

      if (
        !validNotionId(pageId) ||
        !validNotionId(partnerId)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "유효한 pageId와 partnerId가 필요합니다."
        });
      }

      try {
        const page = await retrievePage(pageId);

        if (!isCarrierDocument(page)) {
          return res.status(404).json({
            ok: false,
            error: "해당 문서를 찾을 수 없습니다."
          });
        }

        const matched = await matchesPartnerOrCountry(
          page,
          partnerId
        );

        if (!matched) {
          return res.status(404).json({
            ok: false,
            error:
              "해당 파트너 또는 국가에 연결된 문서가 아닙니다."
          });
        }

        const blocks = await readTextBlocks(page.id);
        const html = renderBlocks(blocks);

        return res.json({
          ok: true,
          document: {
            ...documentSummary(page),
            html
          }
        });
      } catch (error) {
        if (error.response?.status === 404) {
          return res.status(404).json({
            ok: false,
            error: "해당 문서를 찾을 수 없습니다."
          });
        }

        logNotionError(
          "파트너 문서 본문 조회 실패:",
          error
        );

        return res.status(500).json({
          ok: false,
          error:
            `파트너 문서 본문 조회 실패: ${getErrorMessage(error)}`
        });
      }
    }
  );
}

// =====================================================
// API 등록
// =====================================================

module.exports = function registerBookingPartnerRoutes(app) {
  registerPartnerDocumentRoutes(app);

  // ---------------------------------------------------
  // POE에 해당하는 파트너 목록 + BL TYPE
  // ---------------------------------------------------

  app.get(
    "/api/mail/booking/partners",
    async (req, res) => {
      const rawPoe = req.query.poe;

      if (
        typeof rawPoe !== "string" ||
        !rawPoe.trim()
      ) {
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
          const poeText = getRichText(
            properties[PROP_POE]
          );

          const poeCodes =
            extractPartnerPoeCodes(poeText);

          const matchedCodes = poeCodes.filter(
            code => selectedCodes.has(code)
          );

          if (!matchedCodes.length) continue;

          includedIds.add(page.id);

          partners.push({
            id: page.id,
            name:
              getTitle(properties) || "이름 없음",
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
        logNotionError(
          "POE 파트너 조회 실패:",
          error
        );

        return res.status(500).json({
          ok: false,
          error: "POE 파트너 조회 실패"
        });
      }
    }
  );
};
