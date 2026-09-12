export type PlanSummary = {
  status: string
  hasChanges: boolean
  additions: number
  changes: number
  destructions: number
  imports: number
  logReadUrl: string | null
}

export class TfcApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'TfcApiError'
  }
}

type JsonApiResource<T> = { id: string; attributes: T }

type JsonApiDocument<T> = {
  data: T
  meta?: { pagination?: { 'next-page': number | null } }
}

type WorkspaceAttributes = {
  name: string
  'speculative-enabled': boolean
  'vcs-repo': { identifier: string; branch: string | null } | null
}

export type RepoWorkspace = {
  name: string
  speculativeEnabled: boolean
  // 追跡ブランチ。空文字はリポジトリのデフォルトブランチ
  branch: string
}

type PlanAttributes = {
  status: string
  'has-changes': boolean
  'resource-additions': number | null
  'resource-changes': number | null
  'resource-destructions': number | null
  'resource-imports': number | null
  'log-read-url'?: string | null
}

export class TfcClient {
  constructor(
    private readonly hostname: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async get(path: string): Promise<Response> {
    return this.fetchFn(`https://${this.hostname}/api/v2${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
      },
    })
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.get(path)
    if (!response.ok) {
      throw new TfcApiError(
        `HCP Terraform API request failed: GET ${path} -> ${response.status} ${response.statusText}`,
        response.status
      )
    }
    return (await response.json()) as T
  }

  // organization 内で指定リポジトリに VCS 連携されている workspace を返す (token が参照できる範囲のみ)
  async listWorkspacesForRepo(organization: string, repository: string): Promise<RepoWorkspace[]> {
    const workspaces: RepoWorkspace[] = []
    const wanted = repository.toLowerCase()
    let page: number | null = 1
    while (page !== null) {
      const document: JsonApiDocument<JsonApiResource<WorkspaceAttributes>[]> = await this.getJson(
        `/organizations/${encodeURIComponent(organization)}/workspaces?page%5Bsize%5D=100&page%5Bnumber%5D=${page}`
      )
      for (const workspace of document.data) {
        const vcsRepo = workspace.attributes['vcs-repo']
        if (vcsRepo !== null && vcsRepo.identifier.toLowerCase() === wanted) {
          workspaces.push({
            name: workspace.attributes.name,
            speculativeEnabled: workspace.attributes['speculative-enabled'],
            branch: vcsRepo.branch ?? '',
          })
        }
      }
      page = document.meta?.pagination?.['next-page'] ?? null
    }
    return workspaces.toSorted((a, b) => a.name.localeCompare(b.name))
  }

  // run の plan を返す。plan が存在しない (run が plan 前に失敗した等) 場合は null
  async getPlanForRun(runId: string): Promise<PlanSummary | null> {
    const response = await this.get(`/runs/${encodeURIComponent(runId)}/plan`)
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new TfcApiError(
        `HCP Terraform API request failed: GET /runs/${runId}/plan -> ${response.status} ${response.statusText}`,
        response.status
      )
    }
    const document = (await response.json()) as JsonApiDocument<JsonApiResource<PlanAttributes>>
    const attributes = document.data.attributes
    return {
      status: attributes.status,
      hasChanges: attributes['has-changes'],
      additions: attributes['resource-additions'] ?? 0,
      changes: attributes['resource-changes'] ?? 0,
      destructions: attributes['resource-destructions'] ?? 0,
      imports: attributes['resource-imports'] ?? 0,
      logReadUrl: attributes['log-read-url'] ?? null,
    }
  }

  // log-read-url は署名付きの一時 URL で、認証ヘッダなしで取得する
  async fetchLog(url: string): Promise<string> {
    const response = await this.fetchFn(url)
    if (!response.ok) {
      throw new TfcApiError(
        `Failed to fetch plan log: ${response.status} ${response.statusText}`,
        response.status
      )
    }
    return response.text()
  }
}
