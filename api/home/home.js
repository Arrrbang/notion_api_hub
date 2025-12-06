const express = require("express");
const axios = require("axios");
const router = express.Router();

// Notion 설정
const NOTION_DATABASE_ID = "2760b10191ce80799f5fe13cd365ddad";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

// 1. 사용자 ID와 노션 '영업담당' 이름 매핑
const USER_MAPPING = {
  "admin": "정창락",
  // 추후 다른 사용자 추가 가능
  // "user1": "김철수",
};

// 2. 날짜 계산 함수 (YYYY-MM-DD 형식)
function getDateString(date) {
  return date.toISOString().split('T')[0];
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;

    // 1. 로그인된 아이디에 해당하는 영업담당 이름 찾기
    const salesRepName = USER_MAPPING[username];

    if (!salesRepName) {
      return res.status(400).json({ 
        ok: false, 
        error: "매칭되는 영업담당자가 없습니다. 관리자에게 문의하세요." 
      });
    }

    // 2. 날짜 필터 준비 (오늘 ~ 1주일 후)
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const todayStr = getDateString(today);
    const nextWeekStr = getDateString(nextWeek);

    // 3. 노션 쿼리 수행
    const response = await axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        filter: {
          and: [
            // (1) 영업담당 == 매핑된 이름 (예: 정창락)
            {
              property: "영업담당",
              select: {
                equals: salesRepName
              }
            },
            // (2) 여권수취여부 != "수취"
            {
              property: "여권수취여부",
              select: {
                does_not_equal: "수취"
              }
            },
            // (3) 서류마감 >= 오늘
            {
              property: "서류마감",
              date: {
                on_or_after: todayStr
              }
            },
            // (4) 서류마감 <= 1주일 뒤
            {
              property: "서류마감",
              date: {
                on_or_before: nextWeekStr
              }
            }
          ]
        }
      },
      { headers: notionHeaders() }
    );

    // 4. 필요한 데이터만 정제하여 응답
    // 필요한 값: 고객명(title), 업무담당(people)
    const results = response.data.results.map((page) => {
      const props = page.properties;

      // 고객명 추출
      const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";

      // 업무담당자 이름 추출 (여러 명일 수 있음)
      const assignees = props["업무담당"]?.people?.map(p => p.name).join(", ") || "배정 안됨";

      // 서류마감 날짜 (참고용으로 추가)
      const deadline = props["서류마감"]?.date?.start || "";

      return {
        id: page.id,
        clientName,
        assignees,
        deadline
      };
    });

    res.json({ ok: true, data: results, targetName: salesRepName });

  } catch (error) {
    console.error("Notion API Error:", error.response?.data || error.message);
    res.status(500).json({ ok: false, error: "데이터를 불러오는 중 오류가 발생했습니다." });
  }
});

module.exports = (app) => {
  app.use("/api/home", router);
};
