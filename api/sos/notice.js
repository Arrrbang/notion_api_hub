// api/sos/notice.js
const express = require("express");
const axios = require("axios");
const router = express.Router();

// 환경변수에서 Notion Key 가져오기
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const DATABASE_ID = "2c60b10191ce80cda471c1e46cd979d6"; // 지정하신 DB ID

// 공통 헤더
function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 라우트 핸들러 함수
const getSosNotices = async (req, res) => {
  try {
    // 1. 데이터베이스 쿼리 (공지유무가 '진행'인 것만 필터링)
    const queryResponse = await axios.post(
      `https://api.notion.com/v1/databases/${DATABASE_ID}/query`,
      {
        filter: {
          property: "공지유무",
          select: {
            equals: "진행"
          }
        },
        sorts: [
          {
            property: "적용기간",
            direction: "descending" // 최신순 정렬 (필요시 수정 가능)
          }
        ]
      },
      { headers: notionHeaders() }
    );

    const pages = queryResponse.data.results;

    // 2. 각 페이지의 본문(Block children) 가져오기 + 데이터 정리
    // Promise.all을 사용하여 병렬로 처리합니다.
    const noticesWithContent = await Promise.all(
      pages.map(async (page) => {
        const props = page.properties;

        // (1) 기본 속성 파싱
        const title = props["공지사항"]?.title?.[0]?.plain_text || "제목 없음";
        const bound = props["BOUND"]?.select?.name || "";
        const period = props["적용기간"]?.date || null;
        const startDate = period?.start || "";
        const endDate = period?.end || "";

        // (2) 본문 내용(Blocks) 가져오기
        let contentBlocks = [];
        try {
          const blocksResponse = await axios.get(
            `https://api.notion.com/v1/blocks/${page.id}/children?page_size=100`,
            { headers: notionHeaders() }
          );
          contentBlocks = blocksResponse.data.results;
        } catch (blockError) {
          console.error(`본문 가져오기 실패 (${title}):`, blockError.message);
          // 본문 가져오기 실패해도 목록은 보여주기 위해 빈 배열 처리
        }

        // 프론트엔드로 보낼 최종 객체 구조
        return {
          id: page.id,
          title: title,
          bound: bound,
          startDate: startDate,
          endDate: endDate,
          content: contentBlocks // 팝업에 띄울 본문 데이터 (Notion Block 구조 그대로 전달)
        };
      })
    );

    res.json({
      ok: true,
      data: noticesWithContent
    });

  } catch (error) {
    console.error("SOS Notice Error:", error.response?.data || error.message);
    res.status(500).json({
      ok: false,
      error: "공지사항을 불러오는 중 오류가 발생했습니다.",
      details: error.response?.data || error.message
    });
  }
};

module.exports = (app) => {
  router.get("/api/sos/notice", getSosNotices);
  app.use(router);
};
