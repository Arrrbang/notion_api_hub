/* api/quotation/saveload.js */
const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const QUOTATION_DB_ID = '3aa0b10191ce80558a36d58c58c1df53';

function notionHeaders() {
    return {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
    };
}

function chunkString(str, length) {
    const chunks = [];
    for (let i = 0; i < str.length; i += length) {
        chunks.push(str.substring(i, i + length));
    }
    return chunks.slice(0, 100);
}

function formatIsoDate(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})/);
    if (match) {
        const yyyy = match[1];
        const mm = match[2].padStart(2, '0');
        const dd = match[3].padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    return null;
}

module.exports = function(app) {

    // [1] 견적서 저장 및 덮어쓰기 API
    app.post('/api/quotation/save', async (req, res) => {
        try {
            const { quoteNo, customer, date, totalAmount, sales, rawData, pageId } = req.body;

            let cleanDate = formatIsoDate(date);
            if (!cleanDate) {
                const today = new Date();
                const kstOffset = 9 * 60 * 60 * 1000;
                cleanDate = new Date(today.getTime() + kstOffset).toISOString().split('T')[0];
            }

            let finalQuoteNo = quoteNo;
            if (!finalQuoteNo || finalQuoteNo.trim() === '') {
                const salesPrefix = (sales && sales !== '') ? sales.split(' ')[0].toUpperCase() : 'PASS';
                const dateStr = cleanDate.replace(/-/g, ''); 

                // 💡 에러 방지: 담당자가 비어있으면 담당자 필터를 빼고 검색합니다.
                const queryPayload = {
                    filter: { property: "Date", date: { equals: cleanDate } }
                };
                
                if (sales && sales !== '') {
                    queryPayload.filter = {
                        and: [
                            { property: "Date", date: { equals: cleanDate } },
                            { property: "Sales", select: { equals: sales } }
                        ]
                    };
                }

                const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, queryPayload, { headers: notionHeaders() });

                const count = queryResp.data.results.length;
                const sequence = String(count + 1).padStart(2, '0');
                finalQuoteNo = `${salesPrefix}-${dateStr}-${sequence}`;
            }

            const jsonString = JSON.stringify(rawData || {});
            const chunkedData = chunkString(jsonString, 2000).map(chunk => ({
                text: { content: chunk }
            }));

            const properties = {
                "Quote No": { title: [{ text: { content: finalQuoteNo } }] },
                "Customer": { rich_text: [{ text: { content: customer || '-' } }] },
                "Date": { date: { start: cleanDate } },
                "Total Amount": { number: Number(totalAmount) || 0 },
                "Raw Data": { rich_text: chunkedData }
            };

            // 💡 에러 방지: 담당자가 있을 때만 Sales(Select 속성)를 추가합니다.
            if (sales && sales !== '') {
                properties["Sales"] = { select: { name: sales } };
            }

            if (pageId) {
                const updateResp = await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
                    properties: properties
                }, { headers: notionHeaders() });

                return res.json({ ok: true, quoteNo: finalQuoteNo, pageId: updateResp.data.id });
            } else {
                const createResp = await axios.post('https://api.notion.com/v1/pages', {
                    parent: { database_id: QUOTATION_DB_ID },
                    properties: properties
                }, { headers: notionHeaders() });

                return res.json({ ok: true, quoteNo: finalQuoteNo, pageId: createResp.data.id });
            }

        } catch (error) {
            console.error('❌ 노션 저장 에러 상세:', error.response?.data || error.message);
            return res.status(500).json({ ok: false, error: '저장 실패', details: error.response?.data });
        }
    });

    // [2] 특정 영업사원의 견적서 목록 불러오기 API
    app.post('/api/quotation/list', async (req, res) => {
        try {
            const { sales } = req.body;
            
            const queryPayload = {
                sorts: [{ property: "Date", direction: "descending" }]
            };
            
            // 💡 에러 방지: 담당자가 지정되었을 때만 필터를 추가합니다.
            if (sales && sales !== '') {
                queryPayload.filter = { property: "Sales", select: { equals: sales } };
            }

            const queryResp = await axios.post(`https://api.notion.com/v1/databases/${QUOTATION_DB_ID}/query`, queryPayload, { headers: notionHeaders() });

            const results = queryResp.data.results.map(page => {
                const props = page.properties;
                const rawDataArray = props["Raw Data"]?.rich_text || [];
                const fullRawDataStr = rawDataArray.map(t => t.plain_text).join('');
                
                let parsedData = {};
                try { parsedData = JSON.parse(fullRawDataStr); } catch(e) {}

                return {
                    id: page.id,
                    quoteNo: props["Quote No"]?.title[0]?.plain_text || '',
                    customer: props["Customer"]?.rich_text[0]?.plain_text || '',
                    date: props["Date"]?.date?.start || '',
                    totalAmount: props["Total Amount"]?.number || 0,
                    sales: props["Sales"]?.select?.name || '',
                    rawData: parsedData
                };
            });

            return res.json({ ok: true, list: results });
        } catch (error) {
            console.error('❌ 목록 조회 에러 상세:', error.response?.data || error.message);
            return res.status(500).json({ ok: false, error: '목록 조회 실패', details: error.response?.data });
        }
    });

    // [3] 견적서 영구 삭제(아카이브) API
    app.delete('/api/quotation/delete/:id', async (req, res) => {
        try {
            const pageId = req.params.id;
            await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
                archived: true
            }, { headers: notionHeaders() });
            return res.json({ ok: true, message: '삭제 완료' });
        } catch (error) {
            return res.status(500).json({ ok: false, error: '삭제 실패', details: error.response?.data });
        }
    });
};
