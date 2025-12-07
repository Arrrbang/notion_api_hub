const express = require("express");
const axios = require("axios");
const router = express.Router();

const NOTION_DATABASE_ID = "2760b10191ce80799f5fe13cd365ddad";
const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };
}

const OPS_USER_MAPPING = {
  "admin": "지아름",
  "opere": "지아름",
  "opero": "노해원",
  "operd": "소다미"
};

const HOLIDAYS = [
    "2024-01-01", "2024-02-09", "2024-02-10", "2024-02-11", "2024-02-12",
    "2024-03-01", "2024-04-10", "2024-05-05", "2024-05-06", "2024-05-15",
    "2024-06-06", "2024-08-15", "2024-09-16", "2024-09-17", "2024-09-18",
    "2024-10-03", "2024-10-09", "2024-12-25",
    "2025-01-01", "2025-01-28", "2025-01-29", "2025-01-30"
];

function getDateString(date) {
    return date.toISOString().split('T')[0];
}

// 다음 영업일 구하기 (내일이 휴일이면 그 다음날...)
function getNextBusinessDay(startDate) {
    let nextDate = new Date(startDate);
    let found = false;
    while (!found) {
        nextDate.setDate(nextDate.getDate() + 1); // 하루 더함
        const day = nextDate.getDay();
        const str = getDateString(nextDate);
        // 주말(0,6) 아니고 공휴일 아니면 찾음
        if (day !== 0 && day !== 6 && !HOLIDAYS.includes(str)) {
            found = true;
        }
    }
    return getDateString(nextDate); // YYYY-MM-DD 반환
}

// [날짜 계산 유틸] targetDays(예: 2일) 후의 영업일 (범위 쿼리용)
function addBusinessDays(startDate, daysToAdd) {
    let count = 0;
    let currentDate = new Date(startDate);
    while (count < daysToAdd) {
        currentDate.setDate(currentDate.getDate() + 1);
        const day = currentDate.getDay();
        const str = getDateString(currentDate);
        if (day !== 0 && day !== 6 && !HOLIDAYS.includes(str)) {
            count++;
        }
    }
    return currentDate;
}

// 3. 노션 페이지 포맷팅 (색상 판별 로직 포함)
// nextBusinessDayStr: "2024-05-20" 같은 형식 (오늘 기준 다음 영업일)
function formatOpsPage(page, nextBusinessDayStr) {
  const props = page.properties;
  
  const clientName = props["고객명"]?.title?.[0]?.plain_text || "이름 없음";
  const salesRep = props["영업담당"]?.select?.name || "";
  const assignees = props["업무담당"]?.people?.map(p => p.name) || [];
  
  // 노션 페이지 URL
  const pageUrl = page.url; 

  // 서류마감 처리
  const deadlineFull = props["서류마감"]?.date?.start || "";
  let deadlineDate = "";
  let isUrgentMorning = false;

  if (deadlineFull) {
      // 1. 표시용 날짜 (시간 제외)
      deadlineDate = deadlineFull.split('T')[0]; 

      // 2. 긴급 여부 판별 (날짜가 다음 영업일이면서, 시간이 오전인 경우)
      if (deadlineDate === nextBusinessDayStr) {
          // 시간이 있는지 확인 (T가 있으면 시간이 있는 것)
          if (deadlineFull.includes('T')) {
              const timePart = deadlineFull.split('T')[1]; // HH:mm:ss.000Z
              const hour = parseInt(timePart.split(':')[0], 10);
              // 오전(12시 미만)이면 빨간색
              if (hour < 12) {
                  isUrgentMorning = true;
              }
          }
      }
  }

  const containerDate = props["컨작업일정"]?.date?.start || "";

  return {
    id: page.id,
    clientName,
    salesRep,
    assignees,
    deadline: deadlineDate, // YYYY-MM-DD만 전달
    isUrgentMorning,        // 빨간색 표시 여부
    pageUrl,                // 링크용 URL
    containerDate
  };
}

router.get("/", async (req, res) => {
  try {
    const { username } = req.query;
    const opsName = OPS_USER_MAPPING[username];

    if (!opsName) {
      return res.status(400).json({ ok: false, error: "매칭되는 업무담당자가 없습니다." });
    }

    const today = new Date();
    // Vercel 서버 시간 보정을 위해 한국 시간(KST)으로 변환 권장 (간단히 +9시간 처리)
    const kstToday = new Date(today.getTime() + (9 * 60 * 60 * 1000));
    const todayStr = getDateString(kstToday);

    // "다음 영업일" 계산 (색상 판별용)
    const nextBizDayStr = getNextBusinessDay(kstToday);

    // 1주 후 (여권 수취용)
    const nextWeek = new Date(kstToday);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = getDateString(nextWeek);

    // 2 영업일 후 (마감 임박용)
    const targetDate = addBusinessDays(kstToday, 2);
    const targetDateStr = getDateString(targetDate);

    // 쿼리 실행 (병렬)
    const passportQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      { // ✅ 쿼리 본문 시작
        filter: {
          and: [
            { property: "여권수취여부", select: { does_not_equal: "수취" } },
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: nextWeekStr } }
          ]
        },
        sorts: [ // ✅ sorts를 filter와 같은 레벨에 통합
          {
            property: "서류마감",
            direction: "ascending" 
          }
        ]
      }, // ✅ 쿼리 본문 끝
      { headers: notionHeaders() }
    );

    const deadlineQuery = axios.post(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      { // ✅ 쿼리 본문 시작
        filter: {
          and: [
            { property: "서류마감", date: { on_or_after: todayStr } },
            { property: "서류마감", date: { on_or_before: targetDateStr } }
          ]
        },
        sorts: [ // ✅ sorts를 filter와 같은 레벨에 통합
          {
            property: "서류마감",
            direction: "ascending" 
          }
        ]
      }, // ✅ 쿼리 본문 끝
      { headers: notionHeaders() }
    );

    const [passportRes, deadlineRes] = await Promise.all([passportQuery, deadlineQuery]);

    // 데이터 정제 (filterOpsPage에 nextBizDayStr 전달)
    const passportNeeded = passportRes.data.results
        .map(page => formatOpsPage(page, nextBizDayStr))
        .filter(item => item.assignees.includes(opsName));

    const upcomingDeadline = deadlineRes.data.results
        .map(page => formatOpsPage(page, nextBizDayStr))
        .filter(item => item.assignees.includes(opsName));

    res.json({ 
      ok: true, 
      targetName: opsName,
      data: { passportNeeded, upcomingDeadline }
    });

  } catch (error) {
    console.error("Ops API Error:", error.response?.data || error.message);
    res.status(500).json({ ok: false, error: "서버 오류 발생", details: error.message });
  }
});

module.exports = (app) => {
  app.use("/api/home/home-ops", router);
};
