const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정
const NOTICE_DATABASE_ID = "1b20b10191ce803181ddd9e3296640c4";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 한글 추출 함수
function extractKoreanName(text) {
  if (!text) return "";
  const match = text.match(/[가-힣]+/);
  return match ? match[0] : ""; 
}

// ─────────────────────────────────────────────────────────────
// 1. 공지사항 목록 조회 (GET /api/home/notice)
// ─────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${NOTICE_DATABASE_ID}/query`,
      {
        filter: {
          property: "타입",
          select: { equals: "공지사항" }
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }]
      },
      { headers: notionHeaders() }
    );

    const notices = response.data.results.map((page) => {
      const props = page.properties;
      const content = props["내역"]?.title?.[0]?.plain_text || "내용 없음";

      // [수정] 다중 선택(multi_select) 우선 처리
      const rawCountry = 
        props["국가명"]?.multi_select?.[0]?.name || 
        props["국가명"]?.select?.name || 
        "";

      const country = extractKoreanName(rawCountry);

      return {
        id: page.id, // 페이지 ID (상세 조회용)
        content,
        country
      };
    });

    res.json({ ok: true, data: notices });
  } catch (error) {
    console.error("Notice List API Error:", error.message);
    res.status(500).json({ ok: false, error: "목록 로딩 실패" });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. 공지사항 본문(블록) 조회 (GET /api/home/notice/:pageId)
// ─────────────────────────────────────────────────────────────
router.get("/:pageId", async (req, res) => {
  try {
    const { pageId } = req.params;
    
    // 노션 블록 자식 목록 조회 API
    const response = await axios.get(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      { headers: notionHeaders() }
    );

    res.json({ ok: true, data: response.data.results });
  } catch (error) {
    console.error("Notice Detail API Error:", error.message);
    res.status(500).json({ ok: false, error: "본문 로딩 실패" });
  }
});

module.exports = (app) => {
  app.use("/api/home/notice", router);
};
