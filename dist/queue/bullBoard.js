"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bullBoardRouter = exports.bullBoardAdapter = void 0;
const api_1 = require("@bull-board/api");
const bullMQAdapter_1 = require("@bull-board/api/bullMQAdapter");
const express_1 = require("@bull-board/express");
const emailQueue_1 = require("./emailQueue");
exports.bullBoardAdapter = new express_1.ExpressAdapter();
exports.bullBoardAdapter.setBasePath('/admin/queues');
(0, api_1.createBullBoard)({
    queues: [new bullMQAdapter_1.BullMQAdapter(emailQueue_1.emailQueue)],
    serverAdapter: exports.bullBoardAdapter,
});
exports.bullBoardRouter = exports.bullBoardAdapter.getRouter();
