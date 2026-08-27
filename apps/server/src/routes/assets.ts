import path from "node:path";

import type {FastifyInstance} from "fastify";

import {isStorageKeyEscapeError} from "../storage/storage-adapter.js";
import type {StorageAdapter} from "../storage/storage-adapter.js";

const contentTypes: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export const registerAssetRoutes = (app: FastifyInstance, storage: StorageAdapter): void => {
  app.get<{Params: {"*": string}}>("/assets/*", async (request, reply) => {
    const key = request.params["*"];
    if (key.length === 0) {
      return reply.code(404).send({error: "asset_not_found"});
    }
    try {
      const data = await storage.read(key);
      const contentType =
        contentTypes[path.extname(key).toLowerCase()] ?? "application/octet-stream";
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .type(contentType)
        .send(data);
    } catch (error) {
      if (isStorageKeyEscapeError(error)) {
        return reply.code(400).send({error: "invalid_asset_key"});
      }
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return reply.code(404).send({error: "asset_not_found"});
      }
      throw error;
    }
  });
};
