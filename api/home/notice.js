const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정 (공지사항 DB)
const NOTICE_DATABASE_ID = "1b20b10191ce803181ddd9e3296640c4";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 국가명에서 한글만 추출하는 헬퍼 함수
function extractKoreanName(text) {
  if (!text) return "";
  // 한글(가-힣)이 포함된 부분만 찾아서 반환
  const match = text.match(/[가-힣]+/);
  // 매칭된 한글이 있으면 반환, 없으면 원본 반환(혹은 빈칸)
  return match ? match[0] : text;
}

router.get("/", async (req, res) => {
  try {
    // 공지사항 쿼리
    // 조건: "타입" (Select) == "공지사항"
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${NOTICE_DATABASE_ID}/query`,
      {
        filter: {
          property: "타입",
          select: {
            equals: "공지사항"
          }
        },
        // 정렬: 최신순 (생성일 내림차순) - 필요 시 수정 가능
        sorts: [
          {
            timestamp: "created_time",
            direction: "descending"
          }
        ]
      },
      { headers: notionHeaders() }
    );

    // 데이터 정제
    const notices = response.data.results.map((page) => {
      const props = page.properties;

      // 1. 내역 (Title)
      const content = props["내역"]?.title?.[0]?.plain_text || "내용 없음";

      // 2. 국가명 (Select) -> 한글만 추출
      const rawCountry = props["국가명"]?.select?.name || "";
      const country = extractKoreanName(rawCountry);

      return {
        id: page.id,
        content,
        country
      };
    });

    res.json({ ok: true, data: notices });

  } catch (error) {
    console.error("Notice API Error:", error.response?.data || error.message);
    res.status(500).json({ ok: false, error: "공지사항을 불러오는 중 오류가 발생했습니다." });
  }
});

module.exports = (app) => {
  app.use("/api/home/notice", router);
};
