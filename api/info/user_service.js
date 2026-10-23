/**
 * 노션 허브 공통 직원정보 모듈. 직원 DB 접근·필드 변환·PASS_ID 매칭은 이 파일에서만 관리합니다.
 * 로그인/비밀번호/계정 생성은 기존 별도 인증 서버가 담당합니다.
 * 부서명: 영업부 / 업무부 / 회계부. 사람: 실제 Notion 사용자 연결.
 * 한글명은 표시용, 사람 ID는 people 속성 조회/저장용입니다.
 */
const axios=require('axios');
const DB='3a50b10191ce80c8b560f043f9565688';
const TTL=30000,cache=new Map(),inflight=new Map();let generation=0;
const error=(status,message)=>Object.assign(new Error(message),{status});
function headers(){const token=process.env.NOTION_API_KEY||process.env.NOTION_TOKEN;if(!token)throw error(500,'Notion 연결 정보가 없습니다.');return {Authorization:`Bearer ${token}`,'Content-Type':'application/json','Notion-Version':'2022-06-28'};}
function passId(value){if(typeof value!=='string'||!value.trim()||value.trim().length>100||/[\r\n]/.test(value))throw error(400,'로그인 아이디를 확인해 주세요.');return value.trim();}
function text(prop){if(!prop)return '';if(prop.type==='select'||prop.select)return prop.select?.name||'';if(prop.type==='email')return prop.email||'';if(prop.type==='phone_number')return prop.phone_number||'';return (prop.title||prop.rich_text||[]).map(x=>x.plain_text??x.text?.content??'').join('').trim();}
function parse(page){const p=page.properties||{},name=text(p['한글명']),position=text(p['직책']);return {
 id:page.id,pass_id:text(p.PASS_ID),korean_name:name,english_name:text(p['영문명']),email:text(p['E-MAIL']),tel:text(p.TEL),dir:text(p.DIR),
 department:text(p['부서명']),position,display_name:[name,position].filter(Boolean).join(' '),
 profit:typeof p.Profit?.number==='number'?p.Profit.number*100:0,
 notion_users:p['사람']?.type==='people'?(p['사람'].people||[]).map(u=>({id:u.id,name:u.name||null,type:u.type||null})):[]
};}
async function queryAll(body={}){const pages=[];let cursor;do{const {data}=await axios.post(`https://api.notion.com/v1/databases/${DB}/query`,{...body,page_size:100,...(cursor?{start_cursor:cursor}:{})},{headers:headers(),timeout:20000});pages.push(...(data.results||[]));if(data.has_more&&!data.next_cursor)throw error(502,'직원 목록 다음 페이지를 가져오지 못했습니다.');cursor=data.has_more?data.next_cursor:null;}while(cursor);return pages;}
function cached(key,loader){const existing=cache.get(key);if(existing&&existing.expires>Date.now())return Promise.resolve(existing.value);if(inflight.has(key))return inflight.get(key);const stamp=generation;const task=Promise.resolve().then(loader).then(value=>{if(stamp===generation){cache.set(key,{value,expires:Date.now()+TTL});if(cache.size>1000)cache.delete(cache.keys().next().value);}return value;}).finally(()=>{if(inflight.get(key)===task)inflight.delete(key)});inflight.set(key,task);return task;}
async function getUser(value){const id=passId(value);return cached(`user:${id}`,async()=>{const pages=await queryAll({filter:{property:'PASS_ID',title:{equals:id}}});if(!pages.length)throw error(404,'직원 DB에 해당 PASS_ID가 없습니다.');if(pages.length!==1)throw error(409,'동일한 PASS_ID가 여러 행에 등록돼 있습니다.');const user=parse(pages[0]);if(!user.korean_name)throw error(422,'직원 DB의 한글명이 비어 있습니다.');return user;});}
async function listUsers(department){if(department!==undefined&&!['영업부','업무부','회계부'].includes(department))throw error(400,'부서명을 확인해 주세요.');return cached(`list:${department||'all'}`,async()=>{const body=department?{filter:{property:'부서명',select:{equals:department}}}:{};return (await queryAll(body)).map(parse).filter(u=>u.pass_id).sort((a,b)=>a.korean_name.localeCompare(b.korean_name,'ko'));});}
function requireNotionUser(user){const people=user.notion_users||[];if(people.length===0)throw error(422,'직원 DB의 사람 속성에 본인의 노션 계정을 연결해 주세요.');if(people.length!==1)throw error(422,'직원 DB의 사람 속성에는 한 명만 지정해 주세요.');const u=people[0];if(u.type==='bot'||typeof u.id!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(u.id))throw error(422,'유효한 노션 사용자 계정을 연결해 주세요.');return u.id;}
async function updateProfit(id,value){if((typeof value!=='number'&&typeof value!=='string')||String(value).trim()===''||!Number.isFinite(Number(value)))throw error(400,'유효한 수익률을 입력해 주세요.');const user=await getUser(id);await axios.patch(`https://api.notion.com/v1/pages/${user.id}`,{properties:{Profit:{number:Number(value)/100}}},{headers:headers(),timeout:20000});generation++;cache.clear();inflight.clear();return user;}
function handleError(res,e,label='user-info'){console.error(`[${label}]`,e.response?.status||e.code||e.message);return res.status(e.status||500).json({ok:false,error:e.status?e.message:'직원 정보를 처리하지 못했습니다. DB 연결 및 권한을 확인해 주세요.'});}
module.exports={getUser,listUsers,requireNotionUser,updateProfit,handleError};
