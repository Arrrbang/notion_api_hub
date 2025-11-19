// api/index.js
// 메인 엔트리: Express 앱 생성 + 각 모듈 라우트 등록

const express = require("express");
const cors    = require("cors");

// 새로 만든 도착지 모듈
const registerDestinationRoutes = require("./destination");

// 기존 SOS 모듈
const registerOutboundSosRoutes = require("./outboundsos");
const registerInboundSosRoutes  = require("./inboundsos");

const app = express();
app.use(cors());
app.use(express.json());

// 도착지(DESTINATION) 관련 라우트 등록
registerDestinationRoutes(app);

// SOS (기존) 라우트 등록
registerOutboundSosRoutes(app);
registerInboundSosRoutes(app);

module.exports = app;
