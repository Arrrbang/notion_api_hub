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

// [핵심 추가] 자식 블록을 재귀적으로 가져오는 함수 (깊이 제한: 3단계)
// Vercel 타임아웃 방지를 위해 깊이를 너무 깊게 하지 않습니다.
async function fetchChildrenRecursively(blockId, depth = 0) {
    if (depth > 4) return []; // 너무 깊으면 중단

    try {
        const response = await axios.get(
            `https://api.notion.com/v1/blocks/${blockId}/children?page_size=100`,
            { headers: notionHeaders() }
        );
        
        let blocks = response.data.results;

        // 가져온 블록들 중에 또 자식이 있는 놈(has_children)이 있다면? -> 또 파고든다!
        const detailedBlocks = await Promise.all(blocks.map(async (block) => {
            if (block.has_children && block.type !== 'child_page') {
                block.children = await fetchChildrenRecursively(block.id, depth + 1);
            }
            return block;
        }));

        return detailedBlocks;
    } catch (e) {
        console.warn(`Fetch error for block ${blockId}:`, e.message);
        return [];
    }
}

// 1. 목록 조회
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

// 2. [수정] 상세 본문 조회 (재귀 함수 사용)
router.get("/:pageId", async (req, res) => {
  try {
    const { pageId } = req.params;
    
    // 재귀 함수를 통해 모든 하위 블록을 싹 긁어옵니다.
    const blocksWithChildren = await fetchChildrenRecursively(pageId);

    res.json({ ok: true, data: blocksWithChildren });

  } catch (error) {
    console.error("Notice Detail Error:", error.message);
    res.status(500).json({ ok: false, error: "본문 로딩 실패" });
  }
});

module.exports = (app) => {
  app.use("/api/home/notice", router);
};
