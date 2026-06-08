import { Client } from "@microsoft/microsoft-graph-client";
import type {
  SharePointSite,
  SharePointDrive,
  SharePointFile,
} from "../types.js";

interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl: string;
  lastModifiedDateTime: string;
  file?: { mimeType?: string };
  parentReference?: { driveId?: string; siteId?: string };
}

function getGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => done(null, accessToken),
  });
}

export async function listSites(
  accessToken: string
): Promise<SharePointSite[]> {
  const client = getGraphClient(accessToken);
  const response = await client
    .api("/sites?search=*")
    .select("id,displayName,webUrl")
    .get();

  return (response.value ?? []).map(
    (site: { id: string; displayName: string; webUrl: string }) => ({
      id: site.id,
      displayName: site.displayName,
      webUrl: site.webUrl,
    })
  );
}

export async function listDrives(
  accessToken: string,
  siteId: string
): Promise<SharePointDrive[]> {
  const client = getGraphClient(accessToken);
  const response = await client
    .api(`/sites/${siteId}/drives`)
    .select("id,name,driveType")
    .get();

  return (response.value ?? []).map(
    (drive: { id: string; name: string; driveType: string }) => ({
      id: drive.id,
      name: drive.name,
      driveType: drive.driveType,
    })
  );
}

export async function listFiles(
  accessToken: string,
  siteId: string,
  driveId: string,
  folderId?: string
): Promise<SharePointFile[]> {
  const client = getGraphClient(accessToken);
  const path = folderId
    ? `/sites/${siteId}/drives/${driveId}/items/${folderId}/children`
    : `/sites/${siteId}/drives/${driveId}/root/children`;

  const response = await client
    .api(path)
    .select("id,name,size,webUrl,lastModifiedDateTime,file,folder")
    .get();

  return (response.value ?? [])
    .filter((item: { file?: unknown; folder?: unknown }) => item.file || item.folder)
    .map(
      (item: {
        id: string;
        name: string;
        size: number;
        webUrl: string;
        lastModifiedDateTime: string;
        file?: { mimeType?: string };
        folder?: { childCount?: number };
      }) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        webUrl: item.webUrl,
        lastModifiedDateTime: item.lastModifiedDateTime,
        mimeType: item.file?.mimeType,
        isFolder: Boolean(item.folder),
        childCount: item.folder?.childCount,
      })
    );
}

export async function searchFiles(
  accessToken: string,
  query: string,
  from = 0,
  size = 50
): Promise<{ files: SharePointFile[]; moreAvailable: boolean }> {
  const client = getGraphClient(accessToken);
  const queryString = query.trim() || "*"; // "*" matches all accessible items
  const response = await client.api("/search/query").post({
    requests: [
      {
        entityTypes: ["driveItem"],
        query: { queryString },
        from,
        size,
      },
    ],
  });

  const container = response?.value?.[0]?.hitsContainers?.[0];
  const hits = container?.hits ?? [];
  const files: SharePointFile[] = hits
    .map((h: { resource?: GraphDriveItem }) => h.resource)
    .filter((r: GraphDriveItem | undefined): r is GraphDriveItem => Boolean(r && r.file))
    .map((r: GraphDriveItem) => ({
      id: r.id,
      name: r.name,
      size: r.size ?? 0,
      webUrl: r.webUrl,
      lastModifiedDateTime: r.lastModifiedDateTime,
      mimeType: r.file?.mimeType,
      driveId: r.parentReference?.driveId,
    }));

  return { files, moreAvailable: Boolean(container?.moreResultsAvailable) };
}

export async function downloadFile(
  accessToken: string,
  driveId: string,
  itemId: string
): Promise<Buffer> {
  const client = getGraphClient(accessToken);
  const stream = await client
    .api(`/drives/${driveId}/items/${itemId}/content`)
    .getStream();

  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function getFileName(
  accessToken: string,
  driveId: string,
  itemId: string
): Promise<string> {
  const client = getGraphClient(accessToken);
  const item = await client
    .api(`/drives/${driveId}/items/${itemId}`)
    .select("name")
    .get();

  return item.name;
}
