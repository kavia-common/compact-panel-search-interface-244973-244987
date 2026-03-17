/**
 * @fileoverview Chrome Extension Background Service Worker (MV3)
 * Provides: Indexing queue, BM25 search engine, persistent IndexedDB storage via idb,
 * message handlers for commands (index, search, update, exclusions, settings) with robust error handling.
 * Follows Google JavaScript Style Guide.
 */

/* global chrome */

// Imports (idb) via native importScripts or ES6 import – MV3 requires ES Module, but for simplicity, common idb patterns are used.
importScripts('https://cdn.jsdelivr.net/npm/idb@7/build/iife/index-min.js');

const INDEXEDDB_NAME = 'search_docs_db';
const INDEXEDDB_VERSION = 1;
const DOCS_STORE = 'documents';
const SETTINGS_STORE = 'settings';
const EXCLUDES_STORE = 'exclusions';

// An in-memory, promise-based message queue for indexing operations.
let indexingQueue = [];

/**
 * Util: Generic error reporting helper.
 * @param {string} action
 * @param {*} err
 * @return {void}
 */
function logError(action, err) {
    console.error(`[Background] Error during ${action}:`, err && err.stack ? err.stack : err);
}

/**
 * Initializes IndexedDB using idb.
 * @return {Promise<IDBDatabase>} The database instance.
 */
async function getDb() {
    try {
        if (!self._idbPromise) {
            self._idbPromise = idb.openDB(INDEXEDDB_NAME, INDEXEDDB_VERSION, {
                upgrade(db) {
                    if (!db.objectStoreNames.contains(DOCS_STORE)) {
                        db.createObjectStore(DOCS_STORE, {keyPath: 'id'});
                    }
                    if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
                        db.createObjectStore(SETTINGS_STORE, {keyPath: 'key'});
                    }
                    if (!db.objectStoreNames.contains(EXCLUDES_STORE)) {
                        db.createObjectStore(EXCLUDES_STORE, {keyPath: 'id'});
                    }
                }
            });
        }
        return await self._idbPromise;
    } catch (err) {
        logError('getDb', err);
        throw err;
    }
}

// ----------------------------- BM25 Search Implementation -----------------------------

/**
 * Basic BM25 search utility using in-memory data. For extension scale, this is sufficient.
 */
class BM25Searcher {
    /**
     * @param {Array<Object>} documents - Array of {id, content, ...}
     */
    constructor(documents) {
        this.documents = documents || [];
        this.k1 = 1.5;
        this.b = 0.75;
        this.index = null;
        this.buildIndex();
    }
    /**
     * PUBLIC_INTERFACE
     * Build index for fast searching.
     * @return {void}
     */
    buildIndex() {
        this.index = {};
        let totalLen = 0;
        for (const doc of this.documents) {
            const tokens = this.tokenize(doc.content);
            doc._tokens = tokens;
            totalLen += tokens.length;
            for (const t of tokens) {
                if (!this.index[t]) {
                    this.index[t] = [];
                }
                this.index[t].push(doc.id);
            }
        }
        this.avgDocLen = this.documents.length ? totalLen / this.documents.length : 0;
    }
    /**
     * Tokenizes text to lower-cased, word tokens.
     * @param {string} text
     * @return {Array<string>}
     */
    tokenize(text) {
        return (text||'').toLowerCase().match(/\b\w+\b/g) || [];
    }
    /**
     * PUBLIC_INTERFACE
     * Search BM25.
     * @param {string} query
     * @param {number} [maxResults=10]
     * @return {Array<{id: string, score: number, doc: Object}>}
     */
    search(query, maxResults=10) {
        const qtokens = this.tokenize(query);
        return this.documents
            .map(doc => {
                let score = 0;
                for (const qt of qtokens) {
                    const docFreq = this.index[qt] ? this.index[qt].length : 0;
                    if (docFreq === 0) continue;
                    // BM25 formula components
                    const N = this.documents.length;
                    const n = docFreq;
                    const tf = doc._tokens.filter(token => token===qt).length;
                    const dlen = doc._tokens.length;
                    const idf = Math.log(1 + ((N - n + 0.5)/(n + 0.5)));
                    const denom = tf + this.k1 * (1 - this.b + this.b * (dlen/this.avgDocLen));
                    score += idf * ((tf * (this.k1 + 1))/ (denom || 1));
                }
                return {
                    id: doc.id,
                    score: score,
                    doc: doc
                };
            })
            .filter(x => x.score > 0)
            .sort((a,b) => b.score - a.score)
            .slice(0, maxResults);
    }
}

// -- Storage Management Helpers --
/**
 * PUBLIC_INTERFACE
 * Save a document.
 * @param {Object} doc {id, content, meta}
 * @return {Promise<void>}
 */
async function saveDoc(doc) {
    try {
        const db = await getDb();
        await db.put(DOCS_STORE, doc);
    } catch (err) {
        logError('saveDoc', err);
        throw err;
    }
}

/**
 * PUBLIC_INTERFACE
 * Delete a document by id.
 * @param {string} id
 * @return {Promise<void>}
 */
async function deleteDoc(id) {
    try {
        const db = await getDb();
        await db.delete(DOCS_STORE, id);
    } catch (err) {
        logError('deleteDoc', err);
        throw err;
    }
}

/**
 * PUBLIC_INTERFACE
 * Get all documents.
 * @return {Promise<Array<Object>>}
 */
async function getAllDocs() {
    try {
        const db = await getDb();
        return await db.getAll(DOCS_STORE);
    } catch (err) {
        logError('getAllDocs', err);
        throw err;
    }
}

/**
 * PUBLIC_INTERFACE
 * Update exclusions.
 * @param {Array<Object>} exclusions
 * @return {Promise<void>}
 */
async function updateExclusions(exclusions) {
    try {
        const db = await getDb();
        const tx = db.transaction(EXCLUDES_STORE, 'readwrite');
        await tx.store.clear();
        for (const ex of exclusions) {
            await tx.store.put(ex);
        }
        await tx.done;
    } catch (err) {
        logError('updateExclusions', err);
        throw err;
    }
}

/**
 * PUBLIC_INTERFACE
 * Set extension settings.
 * @param {Object} settings
 * @return {Promise<void>}
 */
async function saveSettings(settings) {
    try {
        const db = await getDb();
        await db.put(SETTINGS_STORE, {key: 'settings', value: settings});
    } catch (err) {
        logError('saveSettings', err);
        throw err;
    }
}

/**
 * PUBLIC_INTERFACE
 * Load extension settings.
 * @return {Promise<Object>}
 */
async function loadSettings() {
    try {
        const db = await getDb();
        const entry = await db.get(SETTINGS_STORE, 'settings');
        return entry ? entry.value : {};
    } catch (err) {
        logError('loadSettings', err);
        throw err;
    }
}

// ----------------------------- Indexing Queue Logic -----------------------------

/**
 * Add indexing task to queue and trigger processing.
 * @param {Object} doc
 */
function enqueueIndex(doc) {
    indexingQueue.push(doc);
    // Trigger async queue process (no await so it drains naturally).
    processIndexingQueue();
}

/**
 * Process the queue (drain in FIFO order).
 * @return {Promise<void>}
 */
async function processIndexingQueue() {
    if (self._indexingInProgress) return;
    self._indexingInProgress = true;
    while (indexingQueue.length > 0) {
        const doc = indexingQueue.shift();
        try {
            await saveDoc(doc);
        } catch (err) {
            logError('Indexing Queue saveDoc', err);
        }
    }
    self._indexingInProgress = false;
}

// ----------------------------- Message Handlers -----------------------------

/**
 * PUBLIC_INTERFACE
 * Message Listener for chrome.runtime.
 */
chrome.runtime.onMessage.addListener(
    /**
     * @param {Object} message
     * @param {Object} sender
     * @param {function} sendResponse
     * @return {boolean}
     */
    function(message, sender, sendResponse) {
        // Each message should have a `command`
        (async function() {
            let result, error;
            try {
                switch (message.command) {
                    case 'index':
                        if (!message.doc || !message.doc.id || !message.doc.content) {
                            throw new Error('Invalid document for indexing.');
                        }
                        enqueueIndex(message.doc);
                        result = {success: true};
                        break;
                    case 'search':
                        const allDocs = await getAllDocs();
                        const searcher = new BM25Searcher(allDocs);
                        result = {success: true, results: searcher.search(message.query, message.maxResults)};
                        break;
                    case 'updateDocs':
                        if (!Array.isArray(message.docs)) {
                            throw new Error('docs must be array');
                        }
                        for (const doc of message.docs) {
                            enqueueIndex(doc);
                        }
                        result = {success: true};
                        break;
                    case 'deleteDoc':
                        if (!message.id) throw new Error('Missing doc id');
                        await deleteDoc(message.id);
                        result = {success: true};
                        break;
                    case 'getAllDocs':
                        result = {success: true, docs: await getAllDocs()};
                        break;
                    case 'updateExclusions':
                        await updateExclusions(message.exclusions || []);
                        result = {success: true};
                        break;
                    case 'saveSettings':
                        await saveSettings(message.settings || {});
                        result = {success: true};
                        break;
                    case 'loadSettings':
                        result = {success: true, settings: await loadSettings()};
                        break;
                    default:
                        throw new Error('Unknown command: ' + message.command);
                }
            } catch (err) {
                logError('onMessage command: ' + message.command, err);
                error = err.message || String(err);
            }
            if (typeof(sendResponse) === 'function') {
                sendResponse(error ? {success: false, error: error} : result);
            }
        })();
        // Indicates sendResponse will be called asynchronously.
        return true;
    }
);

// Listen to extension install/upgrade for storage migration if ever needed.
chrome.runtime.onInstalled.addListener(function(details) {
    // Reserved for setup, if required in future.
    console.log('Extension installed/updated:', details.reason);
});

/**
 * PUBLIC_INTERFACE
 * For testability, expose some methods globally (not for production use).
 */
self._testHooks = {
    getDb: getDb,
    saveDoc: saveDoc,
    getAllDocs: getAllDocs,
    BM25Searcher: BM25Searcher
};
