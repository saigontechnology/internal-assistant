import { Client } from '@microsoft/microsoft-graph-client'
import type { Session } from '@prisma/client'
import { SessionService } from '../auth/session.service.js'
import type { SharePointDrive, SharePointFile, SharePointSite } from '../common/types.js'

interface GraphDriveItem {
  id: string
  name: string
  size?: number
  webUrl: string
  lastModifiedDateTime: string
  file?: { mimeType?: string }
  parentReference?: { driveId?: string; siteId?: string }
}

/**
 * Wraps Microsoft Graph behind a small, typed surface. Each method takes
 * either a raw `accessToken` (for callers that already have one) or a
 * `Session` row (for controllers — we'll silently refresh the cached MSAL
 * token via SessionService).
 */
export class SharepointService {
  constructor(private readonly sessions: SessionService) {}

  /** Resolve a Graph access token for a session, refreshing the cache if needed. */
  async tokenFor(session: Session): Promise<string> {
    return this.sessions.getGraphToken(session)
  }

  private client(accessToken: string): Client {
    return Client.init({ authProvider: (done) => done(null, accessToken) })
  }

  async listSites(accessToken: string): Promise<SharePointSite[]> {
    const response = await this.client(accessToken)
      .api('/sites?search=*')
      .select('id,displayName,webUrl')
      .get()
    return (response.value ?? []).map((site: SharePointSite) => ({
      id: site.id,
      displayName: site.displayName,
      webUrl: site.webUrl,
    }))
  }

  async listDrives(accessToken: string, siteId: string): Promise<SharePointDrive[]> {
    const response = await this.client(accessToken)
      .api(`/sites/${siteId}/drives`)
      .select('id,name,driveType')
      .get()
    return (response.value ?? []).map((d: SharePointDrive) => ({
      id: d.id,
      name: d.name,
      driveType: d.driveType,
    }))
  }

  async listFiles(
    accessToken: string,
    siteId: string,
    driveId: string,
    folderId?: string,
  ): Promise<SharePointFile[]> {
    const path = folderId
      ? `/sites/${siteId}/drives/${driveId}/items/${folderId}/children`
      : `/sites/${siteId}/drives/${driveId}/root/children`
    const response = await this.client(accessToken)
      .api(path)
      .select('id,name,size,webUrl,lastModifiedDateTime,file,folder')
      .get()
    return (response.value ?? [])
      .filter((item: { file?: unknown; folder?: unknown }) => item.file || item.folder)
      .map((item: any) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        webUrl: item.webUrl,
        lastModifiedDateTime: item.lastModifiedDateTime,
        mimeType: item.file?.mimeType,
        isFolder: Boolean(item.folder),
        childCount: item.folder?.childCount,
      }))
  }

  async searchFiles(
    accessToken: string,
    query: string,
    from = 0,
    size = 50,
  ): Promise<{ files: SharePointFile[]; moreAvailable: boolean }> {
    const queryString = query.trim() || '*'
    const response = await this.client(accessToken).api('/search/query').post({
      requests: [{ entityTypes: ['driveItem'], query: { queryString }, from, size }],
    })
    const container = response?.value?.[0]?.hitsContainers?.[0]
    const hits = container?.hits ?? []
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
      }))
    return { files, moreAvailable: Boolean(container?.moreResultsAvailable) }
  }

  async downloadFile(accessToken: string, driveId: string, itemId: string): Promise<Buffer> {
    const stream = await this.client(accessToken)
      .api(`/drives/${driveId}/items/${itemId}/content`)
      .getStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  async getFileName(accessToken: string, driveId: string, itemId: string): Promise<string> {
    const item = await this.client(accessToken)
      .api(`/drives/${driveId}/items/${itemId}`)
      .select('name')
      .get()
    return item.name
  }
}
