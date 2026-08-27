import type BetterSqlite3 from "better-sqlite3";

import type {MediaIndex, MediaItem} from "@travel-movie/schema";

import type {StorageAdapter} from "../storage/storage-adapter.js";

export const DEFAULT_MEDIA_MANIFEST_KEY = "manifests/media-index.json";

const persistMediaRows = (
  database: BetterSqlite3.Database,
  sourceRoot: string,
  items: readonly MediaItem[],
): void => {
  const removeExisting = database.prepare("DELETE FROM media WHERE source_root = ?");
  const insert = database.prepare(`
    INSERT INTO media (
      source_root, relative_path, id, filename, ext, file_size, content_hash,
      media_type, captured_at_local, utc_offset_min, time_source, status, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const persist = database.transaction(() => {
    removeExisting.run(sourceRoot);
    for (const item of items) {
      insert.run(
        sourceRoot,
        item.relativePath,
        item.id,
        item.filename,
        item.ext,
        item.fileSize,
        item.contentHash,
        item.mediaType,
        item.capturedAtLocal,
        item.utcOffsetMin,
        item.timeSource,
        item.status,
        JSON.stringify(item),
      );
    }
  });

  persist();
};

export const persistMediaIndex = async (
  database: BetterSqlite3.Database,
  storage: StorageAdapter,
  index: MediaIndex,
  manifestKey = DEFAULT_MEDIA_MANIFEST_KEY,
): Promise<void> => {
  persistMediaRows(database, index.sourceRoot, index.items);
  await storage.write(manifestKey, Buffer.from(JSON.stringify(index, null, 2)));
};
