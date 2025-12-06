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

function extractKoreanName(text) {
  if (!text) return "";
  const match = text.match(/[가-힣]+/);
  return match ? match[0] : ""; 
}

// 1. 목록 조회 (기존과 동일)
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
      const rawCountry = props["국가명"]?.multi_select?.[0]?.name || props["국가명"]?.select?.name || "";
      const country = extractKoreanName(rawCountry);

      return { id: page.id, content, country };
    })
    .filter(notice => notice.country && notice.country.trim() !== "");

    res.json({ ok: true, data: notices });
  } catch (error) {
    console.error("Notice List Error:", error.message);
    res.status(500).json({ ok: false, error: "목록 로딩 실패" });
  }
});

// 2. [수정] 상세 본문 조회 (토글 내부 내용 가져오기 추가)
router.get("/:pageId", async (req, res) => {
  try {
    const { pageId } = req.params;
    
    // 1단계: 최상위 블록 가져오기
    const response = await axios.get(
      `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
      { headers: notionHeaders() }
    );

    let blocks = response.data.results;

    // 2단계: 자식이 있는 블록(토글 등)은 내부 내용을 한 번 더 조회 (Deep Fetch)
    // Promise.all을 사용하여 병렬 처리
    const blocksWithChildren = await Promise.all(blocks.map(async (block) => {
        // 자식이 있고, 페이지가 아닌 경우 (토글, 불렛 등)
        if (block.has_children && block.type !== 'child_page') {
            try {
                const childRes = await axios.get(
                    `https://api.notion.com/v1/blocks/${block.id}/children?page_size=100`,
                    { headers: notionHeaders() }
                );
                // 가져온 자식들을 현재 블록의 .children 속성에 저장
                block.children = childRes.data.results;
            } catch (e) {
                console.warn(`Failed to fetch children for block ${block.id}`);
                block.children = [];
            }
        }
        return block;
    }));

    res.json({ ok: true, data: blocksWithChildren });

  } catch (error) {
    console.error("Notice Detail Error:", error.message);
    res.status(500).json({ ok: false, error: "본문 로딩 실패" });
  }
});

module.exports = (app) => {
  app.use("/api/home/notice", router);
};
