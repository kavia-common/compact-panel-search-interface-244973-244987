# compact-panel-search-interface-244973-244987

## Extension Background Service Worker (MV3)

Located in `extension_background/src/service_worker.js`, this is the background backend for the extension and provides:

- Command/message handlers for `index`, `search`, `updateDocs`, `deleteDoc`, `getAllDocs`, `updateExclusions`, `saveSettings`, `loadSettings` via chrome.runtime messaging.
- Robust persistent storage with IndexedDB, powered by `idb`.
- Indexing queue: Documents are added to a queue and saved asynchronously.
- BM25 search: In-memory BM25 ranking for fast, relevant results.
- All handlers implement robust error handling and return `{success, ...}`.
- Settings and exclusions are persisted atomically.

All code conforms to the Google JavaScript Style Guide.