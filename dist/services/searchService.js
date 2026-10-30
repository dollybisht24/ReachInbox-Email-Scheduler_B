"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMAIL_INDEX = void 0;
exports.getElasticsearchClient = getElasticsearchClient;
exports.initElasticsearch = initElasticsearch;
exports.indexEmailRecord = indexEmailRecord;
exports.searchEmails = searchEmails;
const elasticsearch_1 = require("@elastic/elasticsearch");
const env_1 = require("../config/env");
const prisma_1 = require("../db/prisma");
exports.EMAIL_INDEX = 'reachinbox_emails';
let esClient = null;
let isEsAvailable = false;
function getElasticsearchClient() {
    if (!esClient) {
        esClient = new elasticsearch_1.Client({
            node: env_1.env.ELASTICSEARCH_URL,
            requestTimeout: 3000,
            maxRetries: 2,
        });
    }
    return esClient;
}
/**
 * Initializes the Elasticsearch email index with proper mappings
 */
async function initElasticsearch() {
    const client = getElasticsearchClient();
    try {
        const health = await client.cluster.health({});
        isEsAvailable = true;
        console.log(`[Elasticsearch] Connected. Cluster status: ${health.status}`);
        const indexExists = await client.indices.exists({ index: exports.EMAIL_INDEX });
        if (!indexExists) {
            await client.indices.create({
                index: exports.EMAIL_INDEX,
                body: {
                    mappings: {
                        properties: {
                            id: { type: 'keyword' },
                            userId: { type: 'keyword' },
                            senderEmail: { type: 'keyword' },
                            recipient: { type: 'text', fields: { keyword: { type: 'keyword' } } },
                            subject: { type: 'text' },
                            body: { type: 'text' },
                            status: { type: 'keyword' },
                            scheduledAt: { type: 'date' },
                            sentAt: { type: 'date' },
                            createdAt: { type: 'date' },
                        },
                    },
                },
            });
            console.log(`[Elasticsearch] Created index: ${exports.EMAIL_INDEX}`);
        }
        return true;
    }
    catch (err) {
        isEsAvailable = false;
        console.warn(`[Elasticsearch Notice] Elasticsearch not currently reachable at ${env_1.env.ELASTICSEARCH_URL} (${err.message}). Database search fallback will be used.`);
        return false;
    }
}
/**
 * Indexes or updates an email record in Elasticsearch
 */
async function indexEmailRecord(email) {
    const client = getElasticsearchClient();
    try {
        await client.index({
            index: exports.EMAIL_INDEX,
            id: email.id,
            document: {
                id: email.id,
                userId: email.userId,
                senderEmail: email.senderEmail,
                recipient: email.recipient,
                subject: email.subject,
                body: email.body,
                status: email.status,
                scheduledAt: email.scheduledAt.toISOString(),
                sentAt: email.sentAt ? email.sentAt.toISOString() : null,
                createdAt: email.createdAt ? email.createdAt.toISOString() : new Date().toISOString(),
            },
            refresh: 'wait_for',
        });
    }
    catch (err) {
        console.warn(`[Elasticsearch Warning] Could not index email ${email.id}:`, err.message);
    }
}
/**
 * Search emails by query string with strict tenant/user isolation.
 * Uses Elasticsearch multi-match if available, falls back to PostgreSQL ILIKE query.
 */
async function searchEmails(userId, query) {
    const client = getElasticsearchClient();
    if (isEsAvailable) {
        try {
            const response = await client.search({
                index: exports.EMAIL_INDEX,
                body: {
                    query: {
                        bool: {
                            must: [
                                {
                                    multi_match: {
                                        query,
                                        fields: ['recipient^3', 'subject^2', 'body', 'senderEmail'],
                                        fuzziness: 'AUTO',
                                    },
                                },
                            ],
                            filter: [
                                {
                                    term: { userId },
                                },
                            ],
                        },
                    },
                    sort: [{ scheduledAt: { order: 'desc' } }],
                    size: 50,
                },
            });
            const hits = response.hits.hits;
            const ids = hits
                .map((hit) => hit._id)
                .filter((id) => typeof id === 'string');
            if (ids.length > 0) {
                // Fetch complete records from Postgres to include any relational data
                const records = await prisma_1.prisma.emailJob.findMany({
                    where: {
                        id: { in: ids },
                        userId,
                    },
                    include: { sender: true },
                    orderBy: { scheduledAt: 'desc' },
                });
                return {
                    source: 'elasticsearch',
                    total: response.hits.total,
                    results: records,
                };
            }
            return {
                source: 'elasticsearch',
                total: 0,
                results: [],
            };
        }
        catch (err) {
            console.warn(`[Elasticsearch Search Fallback] Query failed (${err.message}). Falling back to PostgreSQL.`);
        }
    }
    // Graceful Fallback: PostgreSQL ILIKE search
    const records = await prisma_1.prisma.emailJob.findMany({
        where: {
            userId,
            OR: [
                { recipient: { contains: query, mode: 'insensitive' } },
                { subject: { contains: query, mode: 'insensitive' } },
                { body: { contains: query, mode: 'insensitive' } },
                { senderEmail: { contains: query, mode: 'insensitive' } },
            ],
        },
        include: { sender: true },
        orderBy: { scheduledAt: 'desc' },
        take: 50,
    });
    return {
        source: 'database_fallback',
        total: records.length,
        results: records,
    };
}
