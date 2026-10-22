/**
 * 운임 요청 DB(4010b10191ce80be9621f8b04d91dea8) 등록 API.
 * GET /api/rate/request/options: 컨테이너 선택지와 로그인 직원 이름 조회.
 * POST /api/rate/request: 요청 POE/요청자/컨테이너 타입/작업예정일/요청일자 저장.
 * 요청자는 oper_info의 PASS_ID→한글명 서버 조회 결과를 사용하며 요청일자는 서버의 한국 날짜.
 * 메일은 발송하지 않습니다. 노션 DB 자동화에서 공용 Gmail 발송을 설정합니다.
 * 발송 상태는 DB 기본값 사용. 필요하면 RATE_REQUEST_INITIAL_STATUS 환경변수로 기존 상태명 지정.
 */
const axios=require('axios');
const {lookupOperInfo}=require('../info/oper_info');
const DB='4010b10191ce80be9621f8b04d91dea8';
const fail=(status,message)=>Object.assign(new Error(message),{status});
function headers(){const token=process.env.NOTION_API_KEY||process.env.NOTION_TOKEN;if(!token)throw fail(500,'Notion 연결 정보가 없습니다.');return {Authorization:`Bearer ${token}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'};}
function today(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
async function schema(){const {data}=await axios.get(`https://api.notion.com/v1/databases/${DB}`,{headers:headers(),timeout:20000});const p=data.properties||{};
 for(const [name,type] of Object.entries({'발송':'status','요청 POE':'title','요청자':'select','컨테이너 타입':'select','작업예정일':'date','요청일자':'date'}))if(p[name]?.type!==type)throw fail(422,`운임 요청 DB의 ${name} 속성 유형(${type})을 확인해 주세요.`);
 return p;
}
function text(value,name,max=200){if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\r\n]/.test(value))throw fail(400,`${name}을 확인해 주세요.`);return value.trim();}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw fail(400,'작업예정일을 선택해 주세요.');return value;}
function error(res,e){console.error('[rate/request]',e.response?.status||e.code||e.message);return res.status(e.status||500).json({ok:false,error:e.status?e.message:'운임 요청을 처리하지 못했습니다. DB 권한 및 속성을 확인해 주세요.'});}
module.exports=function registerRateRequestRoutes(app){
 app.get('/api/rate/request/options',async(req,res)=>{try{
  const [p,user]=await Promise.all([schema(),lookupOperInfo(req.query.username)]);
  res.set('Cache-Control','no-store');res.json({ok:true,requester:user.korean_name,containers:(p['컨테이너 타입'].select.options||[]).map(x=>x.name),requestDate:today()});
 }catch(e){error(res,e);}});
 app.post('/api/rate/request',async(req,res)=>{try{
  const b=req.body||{},poe=text(b.poe,'요청 POE'),container=text(b.container,'컨테이너 타입'),workDate=date(b.workDate);
  const [p,user]=await Promise.all([schema(),lookupOperInfo(b.username)]);
  if(!(p['컨테이너 타입'].select.options||[]).some(x=>x.name===container))throw fail(400,'DB에 등록된 컨테이너 타입을 선택해 주세요.');
  // 요청자 선택지는 직원 DB에서 확인한 이름만 사용. 새 직원 이름도 Notion이 선택 옵션으로 추가합니다.
  const properties={'요청 POE':{title:[{text:{content:poe}}]},'요청자':{select:{name:user.korean_name}},'컨테이너 타입':{select:{name:container}},'작업예정일':{date:{start:workDate}},'요청일자':{date:{start:today()}}};
  const initial=process.env.RATE_REQUEST_INITIAL_STATUS;
  if(initial){if(!(p['발송'].status.options||[]).some(x=>x.name===initial))throw fail(422,'RATE_REQUEST_INITIAL_STATUS가 DB의 발송 상태명과 일치하지 않습니다.');properties['발송']={status:{name:initial}};}
  const {data}=await axios.post('https://api.notion.com/v1/pages',{parent:{database_id:DB},properties},{headers:headers(),timeout:20000});
  res.status(201).json({ok:true,id:data.id,url:data.url,requester:user.korean_name,requestDate:properties['요청일자'].date.start,status:data.properties?.['발송']?.status?.name||null});
 }catch(e){error(res,e);}});
};
