import { GOOGLE_DRIVE_FOLDER_MIME } from "../../core/config.js";

export class DriveAuthError extends Error {
  constructor(message = "Google Drive authorization expired.") {
    super(message);
    this.name = "DriveAuthError";
  }
}

let token = sessionStorage.getItem("google_provider_token");
const cache = new Map();

export const drive = {
  setToken(nextToken) {
    token = nextToken || null;
    if (token) sessionStorage.setItem("google_provider_token", token);
    else sessionStorage.removeItem("google_provider_token");
    cache.clear();
  },
  status() {
    return token ? "ok" : "absent";
  },
  async request(url, options = {}) {
    if (!token) throw new DriveAuthError("Reconnect Google Drive to continue.");
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      this.setToken(null);
      throw new DriveAuthError();
    }
    if (!response.ok) throw new Error(`Google Drive request failed (HTTP ${response.status}).`);
    return response;
  },
  async list(parentId, query = "") {
    if (!parentId) {
      throw new Error("A Drive parent folder is required for this operation.");
    }
    const key = `${parentId}:${query}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data;
    const q = [`'${parentId}' in parents`, "trashed = false", query].filter(Boolean).join(" and ");
    const url = `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
      q,
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink)",
      orderBy: "folder,name",
      pageSize: "1000",
    })}`;
    const data = await (await this.request(url)).json();
    const files = data.files || [];
    cache.set(key, { data: files, expires: Date.now() + 60000 });
    return files;
  },
  async createFolder(name, parentId) {
    if (!parentId) {
      throw new Error("A Drive parent folder is required for folder creation.");
    }
    const response = await this.request("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: GOOGLE_DRIVE_FOLDER_MIME, parents: [parentId] }),
    });
    cache.clear();
    return response.json();
  },
  async ensureFolder(name, parentId) {
    const existing = (await this.list(parentId)).find(
      (file) =>
        file.mimeType === GOOGLE_DRIVE_FOLDER_MIME && file.name === name,
    );
    return existing || this.createFolder(name, parentId);
  },
  async uploadJson(name, payload, parentId) {
    if (!parentId) {
      throw new Error("A Drive parent folder is required for backup upload.");
    }
    const metadata = { name, mimeType: "application/json", parents: parentId ? [parentId] : undefined };
    const boundary = `exo-${crypto.randomUUID()}`;
    const body = [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      JSON.stringify(payload, null, 2),
      `\r\n--${boundary}--`,
    ].join("");
    const response = await this.request(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      },
    );
    cache.clear();
    return response.json();
  },
};
