/** In-memory Google Drive stand-in (demo and tests). Records every call so tests can assert on them. */
import fs from "node:fs";
import { DriveHttpError } from "./drive.js";
import type { DriveClient, DriveCreateRequest, DriveFile } from "./types.js";

export interface FakeDriveRecord extends DriveFile {
  name: string;
  parents: string[];
  appProperties: Record<string, string>;
  webViewLink: string;
  content: Buffer;
  trashed?: boolean;
}

export interface FakeDrive extends DriveClient {
  readonly store: Map<string, FakeDriveRecord>;
  listCalls: number;
  createCalls: number;
  /** HTTP statuses to fail the next creates with */
  failCreates: number[];
  uploaded(): FakeDriveRecord[];
}

export function createFakeDrive(): FakeDrive {
  let counter = 0;
  const drive: FakeDrive = {
    store: new Map(),
    listCalls: 0,
    createCalls: 0,
    failCreates: [],
    async listFolder(folderId: string) {
      drive.listCalls++;
      const files = [...drive.store.values()]
        .filter((f) => f.parents.includes(folderId) && !f.trashed)
        .map(({ content: _content, ...rest }) => ({ ...rest }));
      return { files };
    },
    async createFile(request: DriveCreateRequest) {
      const status = drive.failCreates.shift();
      if (status !== undefined) throw new DriveHttpError(status);
      counter++;
      const id = `file${counter}`;
      const record: FakeDriveRecord = {
        id,
        name: request.name,
        parents: [...request.parents],
        appProperties: { ...request.appProperties },
        webViewLink: `https://drive.google.com/file/d/${id}/view`,
        content: await fs.promises.readFile(request.path),
      };
      drive.store.set(id, record);
      drive.createCalls++;
      return { id, name: record.name, webViewLink: record.webViewLink };
    },
    uploaded: () => [...drive.store.values()],
  };
  return drive;
}
